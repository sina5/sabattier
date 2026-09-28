use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

use crate::blocking;

pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "avif", "cr2", "cr3", "nef", "arw", "dng",
    "raf", "orf", "rw2", "pef", "srw",
];

fn ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_images(dir: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && IMAGE_EXTS.contains(&ext_lower(&path).as_str())
            {
                out.push(path.to_string_lossy().into_owned());
            }
        }
        Ok(out)
    })
    .await
}

/// Returns the file as a raw ArrayBuffer (no JSON encoding of the bytes).
#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    blocking(move || std::fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}")))
        .await
}

/// Body is the raw file bytes; the target path travels URI-encoded in the
/// `path` header because a raw-body invoke has no other arguments.
#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("write_file expects a raw byte body".into());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("write_file: missing path header")?;
    let path = PathBuf::from(urlencoding::decode(path).map_err(|e| e.to_string())?.into_owned());
    let data = data.clone();
    blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, data).map_err(|e| format!("{}: {e}", path.display()))
    })
    .await
}

/// Header value `name` from a raw-body invoke, URI-decoded.
pub(crate) fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or(format!("missing {name} header"))?;
    Ok(urlencoding::decode(raw).map_err(|e| e.to_string())?.into_owned())
}

/// Body is RGBA8 pixels, top row first; headers carry `path`, `format`
/// ("tiff" or "webp"), `width` and `height`. Encodes and writes the file.
#[tauri::command]
pub async fn save_pixels(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("save_pixels expects a raw RGBA body".into());
    };
    let path = PathBuf::from(header(&request, "path")?);
    let format = match header(&request, "format")?.as_str() {
        "tiff" => image::ImageFormat::Tiff,
        "webp" => image::ImageFormat::WebP,
        other => return Err(format!("save_pixels: unsupported format {other}")),
    };
    let parse = |name| header(&request, name)?.parse::<u32>().map_err(|e| e.to_string());
    let (width, height) = (parse("width")?, parse("height")?);
    let data = data.clone();
    blocking(move || encode_pixels(&path, format, width, height, data)).await
}

/// Encode RGBA8 pixels as `format` and write them to `path`. Fully opaque
/// images are stored as RGB, which keeps TIFFs a quarter smaller.
fn encode_pixels(
    path: &Path,
    format: image::ImageFormat,
    width: u32,
    height: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let rgba = image::RgbaImage::from_raw(width, height, data)
        .ok_or("save_pixels: body size does not match width × height")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let opaque = rgba.pixels().all(|p| p[3] == 255);
    let img = image::DynamicImage::ImageRgba8(rgba);
    let img = if opaque { image::DynamicImage::ImageRgb8(img.to_rgb8()) } else { img };
    img.save_with_format(path, format).map_err(|e| format!("{}: {e}", path.display()))
}

/// Returns `path`, or `path` with "-1", "-2", … appended to the stem if it
/// already exists, so exports never overwrite a file.
#[tauri::command]
pub fn unique_path(path: String) -> String {
    let original = PathBuf::from(&path);
    let stem = original.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = original.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = original.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut candidate = original;
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    candidate.to_string_lossy().into_owned()
}

const PRESETS_FILE: &str = "presets.json";

/// Where presets live unless the user picks another folder: `presets/` in the app's data folder.
fn default_presets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("presets"))
}

/// The presets file in `dir`, or in the default folder when `dir` is None or empty.
fn presets_file(app: &AppHandle, dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(dir) = dir.filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir).join(PRESETS_FILE));
    }
    let file = default_presets_dir(app)?.join(PRESETS_FILE);
    if !file.exists() {
        if let Some(legacy) = legacy_presets_file(app)? {
            std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
            // Copy rather than move, so an older build of the app still finds its presets.
            std::fs::copy(&legacy, &file).map_err(|e| e.to_string())?;
        }
    }
    Ok(file)
}

/// App ids this app shipped under before `com.sabattier.editor`; each had its own data folder.
pub const OLD_APP_IDS: &[&str] = &["com.backend.editor", "com.lumen.editor"];

/// Whether `path` holds at least one preset (an empty list is not worth migrating).
fn has_presets(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .is_some_and(|list| !list.is_empty())
}

/// Presets saved by an earlier version, to bring over once: `presets.json` directly in
/// the current data folder, or in the data folder of an older app id. The first file
/// that actually holds presets wins.
fn legacy_presets_file(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut candidates = vec![data_dir.join(PRESETS_FILE)];
    if let Some(parent) = data_dir.parent() {
        for id in OLD_APP_IDS {
            candidates.push(parent.join(id).join("presets").join(PRESETS_FILE));
            candidates.push(parent.join(id).join(PRESETS_FILE));
        }
    }
    Ok(candidates.into_iter().find(|p| has_presets(p)))
}

/// The default presets folder, for display in Settings.
#[tauri::command]
pub fn default_presets_location(app: AppHandle) -> Result<String, String> {
    Ok(default_presets_dir(&app)?.to_string_lossy().into_owned())
}

/// Whether `dir` (or the default folder) already holds a presets file.
#[tauri::command]
pub fn presets_exist(app: AppHandle, dir: Option<String>) -> Result<bool, String> {
    Ok(presets_file(&app, dir)?.exists())
}

#[tauri::command]
pub fn load_presets(app: AppHandle, dir: Option<String>) -> serde_json::Value {
    presets_file(&app, dir)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Array(vec![]))
}

#[tauri::command]
pub fn save_presets(app: AppHandle, presets: serde_json::Value, dir: Option<String>) -> Result<(), String> {
    let file = presets_file(&app, dir)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(file, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a small image through each backend-encoded format.
    #[test]
    fn encode_pixels_round_trips() {
        let dir = std::env::temp_dir().join(format!("sabattier-encode-{}", std::process::id()));
        let (w, h) = (7u32, 5u32);
        for (alpha, name) in [(255u8, "opaque"), (128u8, "alpha")] {
            let data: Vec<u8> = (0..w * h).flat_map(|i| [(i * 9) as u8, 40, 200, alpha]).collect();
            for (format, ext) in [(image::ImageFormat::Tiff, "tif"), (image::ImageFormat::WebP, "webp")] {
                let path = dir.join(format!("{name}.{ext}"));
                encode_pixels(&path, format, w, h, data.clone()).unwrap();
                let back = image::open(&path).unwrap();
                assert_eq!((back.width(), back.height()), (w, h));
                assert_eq!(back.color().has_alpha(), alpha != 255, "{name}.{ext}");
                // Both formats are lossless here: pixels must match exactly.
                assert_eq!(back.to_rgba8().into_raw(), data, "{name}.{ext}");
            }
        }
        assert!(encode_pixels(&dir.join("bad.tif"), image::ImageFormat::Tiff, w, h, vec![0; 3]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
