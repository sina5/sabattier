use std::path::Path;

use image::DynamicImage;
use image::metadata::Orientation as ImgOrientation;
use rawler::Orientation;
use rawler::decoders::RawDecodeParams;
use rawler::imgop::develop::RawDevelop;
use rawler::rawsource::RawSource;
use tauri::ipc::Response;

use crate::blocking;

/// Pixels go to the renderer as `[width u32 LE][height u32 LE][RGBA8…]`, which
/// maps straight onto an `ImageData` without any re-encoding.
fn to_rgba_response(img: DynamicImage) -> Response {
    let rgba = img.into_rgba8();
    let mut out = Vec::with_capacity(8 + rgba.as_raw().len());
    out.extend_from_slice(&rgba.width().to_le_bytes());
    out.extend_from_slice(&rgba.height().to_le_bytes());
    out.extend_from_slice(rgba.as_raw());
    Response::new(out)
}

fn orient(mut img: DynamicImage, orientation: Orientation) -> DynamicImage {
    let exif = match orientation {
        Orientation::Normal | Orientation::Unknown => return img,
        Orientation::HorizontalFlip => ImgOrientation::FlipHorizontal,
        Orientation::Rotate180 => ImgOrientation::Rotate180,
        Orientation::VerticalFlip => ImgOrientation::FlipVertical,
        Orientation::Transpose => ImgOrientation::Rotate90FlipH,
        Orientation::Rotate90 => ImgOrientation::Rotate90,
        Orientation::Transverse => ImgOrientation::Rotate270FlipH,
        Orientation::Rotate270 => ImgOrientation::Rotate270,
    };
    img.apply_orientation(exif);
    img
}

fn fit(img: DynamicImage, max_size: Option<u32>) -> DynamicImage {
    match max_size {
        Some(m) if img.width() > m || img.height() > m => img.thumbnail(m, m),
        _ => img,
    }
}

/// Full RAW development: demosaic, camera white balance, color calibration,
/// default crop and sRGB gamma — the equivalent of the old LibRaw settings
/// (camera WB, sRGB output, no auto-brighten).
pub(crate) fn develop(path: &Path) -> Result<DynamicImage, String> {
    crate::parallel::run(|| develop_now(path))
}

fn develop_now(path: &Path) -> Result<DynamicImage, String> {
    let src = RawSource::new(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let decoder = rawler::get_decoder(&src).map_err(|e| e.to_string())?;
    let raw = decoder
        .raw_image(&src, &RawDecodeParams::default(), false)
        .map_err(|e| e.to_string())?;
    let img = RawDevelop::default()
        .develop_intermediate(&raw)
        .map_err(|e| e.to_string())?
        .to_dynamic_image()
        .ok_or("RAW development produced no image")?;
    Ok(orient(img, raw.orientation))
}

#[tauri::command]
pub async fn decode_raw(path: String, max_size: Option<u32>) -> Result<Response, String> {
    blocking(move || Ok(to_rgba_response(fit(develop(Path::new(&path))?, max_size)))).await
}

/// The camera's embedded preview (fast path for thumbnails). An empty
/// response means the file has none and the caller should develop the RAW.
#[tauri::command]
pub async fn raw_preview(path: String, size: u32) -> Result<Response, String> {
    blocking(move || {
        let preview = (|| {
            let src = RawSource::new(Path::new(&path)).ok()?;
            let decoder = rawler::get_decoder(&src).ok()?;
            let params = RawDecodeParams::default();
            let img = decoder
                .preview_image(&src, &params)
                .ok()
                .flatten()
                .or_else(|| decoder.thumbnail_image(&src, &params).ok().flatten())?;
            // Embedded previews are stored unrotated, like the sensor data.
            let orientation = decoder.raw_image(&src, &params, true).map(|r| r.orientation).ok();
            Some(orient(img, orientation.unwrap_or(Orientation::Unknown)))
        })();
        Ok(match preview {
            Some(img) => to_rgba_response(fit(img, Some(size))),
            None => Response::new(Vec::new()),
        })
    })
    .await
}
