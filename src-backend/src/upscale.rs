//! AI upscaling on export: Real-ESRGAN x4plus (BSD-3-Clause, ONNX export by
//! bukuroo) run through ONNX Runtime in 128-pixel tiles. The renderer sends
//! the finished (cropped, adjusted, watermarked) frame; the result is encoded
//! and written here, so the large upscaled image never crosses the bridge.

use std::sync::atomic::{AtomicBool, Ordering};

use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbImage, RgbaImage};
use ort::session::Session;
use ort::value::Tensor;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter};

use crate::models::{self, ESRGAN};

const TILE: usize = 128;
/// Context kept around each tile and thrown away, so seams don't show.
const OVERLAP: usize = 16;
const STRIDE: usize = TILE - 2 * OVERLAP;
const SCALE: usize = 4;
/// Share of the model's result in the output; the rest is a plain Lanczos
/// resize. Real-ESRGAN treats skin texture and grain as noise and paints
/// faces smooth; half and half keeps the texture and most of the sharper edges.
const MODEL_WEIGHT: f32 = 0.5;
/// Longest edge an upscaled photo may have.
pub const MAX_OUT: u32 = 8192;
/// Set by the Cancel button while saving; checked before every tile.
static CANCELLED: AtomicBool = AtomicBool::new(false);
const CANCELLED_ERR: &str = "upscale cancelled";

#[derive(Clone, serde::Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// Upscale RGB by `factor` (2 or 4). 2× runs the 4× model and halves each
/// tile right away, so memory stays at the output size. Stops with an error
/// as soon as `cancelled` is set.
pub fn upscale_rgb(
    session: &mut Session,
    src: &RgbImage,
    factor: u32,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(usize, usize),
) -> Result<RgbImage, String> {
    let (w, h) = (src.width() as usize, src.height() as usize);
    let f = factor as usize;
    let mut out = RgbImage::new((w * f) as u32, (h * f) as u32);
    let cols = w.div_ceil(STRIDE);
    let rows = h.div_ceil(STRIDE);
    let total = cols * rows;
    let name = session.inputs()[0].name().to_string();
    let plane = TILE * TILE;
    let mut input = vec![0f32; 3 * plane];
    let mut src_tile = RgbImage::new(TILE as u32, TILE as u32);
    for ty in 0..rows {
        for tx in 0..cols {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED_ERR.into());
            }
            // Tile origin in image space, context included; edges replicate.
            let (x0, y0) = ((tx * STRIDE) as isize - OVERLAP as isize, (ty * STRIDE) as isize - OVERLAP as isize);
            for y in 0..TILE {
                let sy = (y0 + y as isize).clamp(0, h as isize - 1) as u32;
                for x in 0..TILE {
                    let sx = (x0 + x as isize).clamp(0, w as isize - 1) as u32;
                    let p = *src.get_pixel(sx, sy);
                    for c in 0..3 {
                        input[c * plane + y * TILE + x] = p[c] as f32 / 255.0;
                    }
                    src_tile.put_pixel(x as u32, y as u32, p);
                }
            }
            let tensor = Tensor::from_array(([1usize, 3, TILE, TILE], input.clone())).map_err(|e| e.to_string())?;
            let outputs = session
                .run(ort::inputs![name.as_str() => tensor])
                .map_err(|e| format!("upscaling: {e}"))?;
            let (_, pred) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let big = TILE * SCALE;
            if pred.len() != 3 * big * big {
                return Err(format!("unexpected upscaler output size {}", pred.len()));
            }
            let mut tile = RgbImage::new(big as u32, big as u32);
            for (i, px) in tile.pixels_mut().enumerate() {
                for c in 0..3 {
                    px[c] = (pred[c * big * big + i] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
            let tile = if f == SCALE {
                tile
            } else {
                image::imageops::resize(&tile, (TILE * f) as u32, (TILE * f) as u32, FilterType::Lanczos3)
            };
            let plain = image::imageops::resize(&src_tile, (TILE * f) as u32, (TILE * f) as u32, FilterType::Lanczos3);
            // Keep the tile's centre (its STRIDE² share of the image), scaled.
            let (ox, oy) = (tx * STRIDE, ty * STRIDE);
            let keep_w = STRIDE.min(w - ox) * f;
            let keep_h = STRIDE.min(h - oy) * f;
            for y in 0..keep_h {
                for x in 0..keep_w {
                    let (px, py) = ((OVERLAP * f + x) as u32, (OVERLAP * f + y) as u32);
                    let (m, p) = (tile.get_pixel(px, py), plain.get_pixel(px, py));
                    let mix = |c: usize| (m[c] as f32 * MODEL_WEIGHT + p[c] as f32 * (1.0 - MODEL_WEIGHT)).round() as u8;
                    out.put_pixel((ox * f + x) as u32, (oy * f + y) as u32, image::Rgb([mix(0), mix(1), mix(2)]));
                }
            }
            progress(ty * cols + tx + 1, total);
        }
    }
    Ok(out)
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or(format!("upscale_save: missing {name} header"))?;
    Ok(urlencoding::decode(raw).map_err(|e| e.to_string())?.into_owned())
}

/// Body: RGBA8 frame, top row first. Headers: `path`, `format` (jpeg, png,
/// webp, tiff), `quality` (0–1, JPEG only), `factor` (2 or 4), `width`,
/// `height`. Emits `upscale-progress` { done, total } per tile.
#[tauri::command]
pub async fn upscale_save(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("upscale_save expects a raw RGBA body".into());
    };
    let path = std::path::PathBuf::from(header(&request, "path")?);
    let format = header(&request, "format")?;
    let quality: f32 = header(&request, "quality")?.parse().map_err(|_| "bad quality")?;
    let factor: u32 = header(&request, "factor")?.parse().map_err(|_| "bad factor")?;
    let width: u32 = header(&request, "width")?.parse().map_err(|_| "bad width")?;
    let height: u32 = header(&request, "height")?.parse().map_err(|_| "bad height")?;
    if factor != 2 && factor != 4 {
        return Err(format!("upscale_save: factor must be 2 or 4, got {factor}"));
    }
    if width.max(height) * factor > MAX_OUT {
        return Err(format!("upscale_save: {width}x{height} at {factor}x exceeds {MAX_OUT} px"));
    }
    let rgba = RgbaImage::from_raw(width, height, data.clone()).ok_or("upscale_save: body size mismatch")?;
    let emitter = app.clone();
    let rgb = models::with_session(app, ESRGAN, move |session| {
        let rgb = DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
        let big = upscale_rgb(session, &rgb, factor, &CANCELLED, |done, total| {
            let _ = emitter.emit("upscale-progress", Progress { done, total });
        })?;
        Ok((big, rgba))
    })
    .await?;
    crate::blocking(move || save(&path, &format, quality, rgb)).await
}

/// Cancel (`true`) the running upscale and any that start later, or allow
/// upscaling again (`false`, at the start of each save).
#[tauri::command]
pub fn upscale_set_cancelled(cancelled: bool) {
    CANCELLED.store(cancelled, Ordering::Relaxed);
}

/// Encode the upscaled RGB, bringing back a (resized) alpha channel for cutouts.
fn save(path: &std::path::Path, format: &str, quality: f32, (rgb, rgba): (RgbImage, RgbaImage)) -> Result<(), String> {
    let opaque = rgba.pixels().all(|p| p[3] == 255);
    let img = if opaque || format == "jpeg" {
        DynamicImage::ImageRgb8(rgb)
    } else {
        let alpha = image::imageops::resize(&rgba, rgb.width(), rgb.height(), FilterType::Triangle);
        let mut out = RgbaImage::new(rgb.width(), rgb.height());
        for (o, (c, a)) in out.pixels_mut().zip(rgb.pixels().zip(alpha.pixels())) {
            *o = image::Rgba([c[0], c[1], c[2], a[3]]);
        }
        DynamicImage::ImageRgba8(out)
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let err = |e: image::ImageError| format!("{}: {e}", path.display());
    match format {
        "jpeg" => {
            let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
            let q = (quality * 100.0).round().clamp(1.0, 100.0) as u8;
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), q);
            enc.encode_image(&img).map_err(err)
        }
        "png" => img.save_with_format(path, ImageFormat::Png).map_err(err),
        "webp" => img.save_with_format(path, ImageFormat::WebP).map_err(err),
        "tiff" => img.save_with_format(path, ImageFormat::Tiff).map_err(err),
        other => Err(format!("upscale_save: unsupported format {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real model when SABATTIER_ESRGAN points at the ONNX file:
    /// output is exactly 2×/4× the size, tile seams don't show, and colors
    /// stay put.
    #[test]
    fn upscales_without_seams() {
        let Ok(path) = std::env::var("SABATTIER_ESRGAN") else { return };
        let mut session = Session::builder().unwrap().commit_from_file(path).unwrap();
        // Smooth diagonal gradient, larger than one tile and not a multiple of the stride.
        let (w, h) = (150u32, 110u32);
        let src = RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 128]));
        for factor in [2u32, 4] {
            let mut calls = 0;
            let t = std::time::Instant::now();
            let out = upscale_rgb(&mut session, &src, factor, &AtomicBool::new(false), |_, _| calls += 1).unwrap();
            eprintln!("{factor}x of {w}x{h}: {calls} tiles in {:?}", t.elapsed());
            assert_eq!((out.width(), out.height()), (w * factor, h * factor));
            // Colors follow the source.
            let (sx, sy) = (100u32, 70u32);
            let (a, b) = (src.get_pixel(sx, sy), out.get_pixel(sx * factor + factor / 2, sy * factor + factor / 2));
            for c in 0..3 {
                assert!((a[c] as i32 - b[c] as i32).abs() < 12, "{factor}x channel {c}: {} vs {}", a[c], b[c]);
            }
            // No seam at the tile boundary (x = STRIDE): neighbours across it differ like elsewhere.
            let row = 50 * factor;
            let step = |x: u32| (out.get_pixel(x + 1, row)[0] as i32 - out.get_pixel(x, row)[0] as i32).abs();
            let seam = step(STRIDE as u32 * factor - 1);
            assert!(seam <= 6, "{factor}x seam jump {seam}");
        }
    }

    /// Runs the real model when SABATTIER_ESRGAN is set: a cancelled upscale
    /// stops before its first tile.
    #[test]
    fn stops_when_cancelled() {
        let Ok(path) = std::env::var("SABATTIER_ESRGAN") else { return };
        let mut session = Session::builder().unwrap().commit_from_file(path).unwrap();
        let src = RgbImage::new(300, 300);
        let mut calls = 0;
        let result = upscale_rgb(&mut session, &src, 2, &AtomicBool::new(true), |_, _| calls += 1);
        assert_eq!(result.err().as_deref(), Some(CANCELLED_ERR));
        assert_eq!(calls, 0);
    }
}
