//! Depth estimation for lens blur: Depth-Anything-V2 Small (Apache-2.0, ONNX
//! export by onnx-community) run through ONNX Runtime. The renderer sends the
//! photo downscaled so each side is a multiple of 14 (the model's patch size);
//! the result is a relative depth map at that size, 255 = nearest.

use ort::value::Tensor;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::models::{self, DEPTH};

/// Long edge the renderer scales photos to (a multiple of 14).
pub const LONG_EDGE: usize = 518;
const PATCH: usize = 14;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

fn preprocess(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let plane = w * h;
    let mut out = vec![0f32; 3 * plane];
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        for c in 0..3 {
            out[c * plane + i] = (px[c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    out
}

/// Min-max normalize the model's relative inverse depth to 0–255 (255 = near).
fn postprocess(pred: &[f32]) -> Vec<u8> {
    let (lo, hi) = pred.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let range = (hi - lo).max(1e-6);
    pred.iter().map(|&v| (((v - lo) / range) * 255.0).round() as u8).collect()
}

fn header(request: &Request<'_>, name: &str) -> Result<usize, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(format!("estimate_depth: missing {name} header"))
}

/// Body: RGBA8 at `width`×`height` (headers; each a multiple of 14, at most
/// LONG_EDGE). Returns the depth map, one byte per pixel, same size.
#[tauri::command]
pub async fn estimate_depth(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("estimate_depth expects a raw RGBA body".into());
    };
    let (w, h) = (header(&request, "width")?, header(&request, "height")?);
    if w % PATCH != 0 || h % PATCH != 0 || w.max(h) > LONG_EDGE || w == 0 || h == 0 {
        return Err(format!("estimate_depth: bad size {w}x{h}"));
    }
    if rgba.len() != w * h * 4 {
        return Err(format!("estimate_depth: expected {w}x{h} RGBA, got {} bytes", rgba.len()));
    }
    let input = preprocess(rgba, w, h);
    models::with_session(app, DEPTH, move |session| run(session, input, w, h)).await.map(Response::new)
}

fn run(session: &mut ort::session::Session, input: Vec<f32>, w: usize, h: usize) -> Result<Vec<u8>, String> {
    let tensor = Tensor::from_array(([1usize, 3, h, w], input)).map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs!["pixel_values" => tensor])
        .map_err(|e| format!("depth: {e}"))?;
    let (_, pred) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if pred.len() != w * h {
        return Err(format!("unexpected depth output size {}", pred.len()));
    }
    Ok(postprocess(pred))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real model when SABATTIER_DEPTH points at the ONNX file: a
    /// floor receding to a horizon (dark sky above, a bright checkered floor
    /// getting finer toward the top) must read nearer at the bottom.
    #[test]
    fn floor_is_nearer_at_the_bottom() {
        let Ok(path) = std::env::var("SABATTIER_DEPTH") else { return };
        let mut session = ort::session::Session::builder().unwrap().commit_from_file(path).unwrap();
        let (w, h) = (518usize, 350usize);
        let mut rgba = vec![0u8; w * h * 4];
        let horizon = h / 3;
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let v = if y < horizon {
                    (120 + y / 4) as u8
                } else {
                    // Perspective checkerboard: squares shrink toward the horizon.
                    let z = 40.0 / ((y - horizon) as f32 + 1.0);
                    let u = (x as f32 - w as f32 / 2.0) * z / 20.0;
                    if ((z * 4.0) as i32 + u.floor() as i32) % 2 == 0 { 200 } else { 60 }
                };
                rgba[i..i + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        let t = std::time::Instant::now();
        let depth = run(&mut session, preprocess(&rgba, w, h), w, h).unwrap();
        let mean = |y0: usize, y1: usize| depth[y0 * w..y1 * w].iter().map(|&v| v as f32).sum::<f32>() / ((y1 - y0) * w) as f32;
        let (near, far) = (mean(h - 30, h), mean(horizon + 5, horizon + 35));
        eprintln!("depth in {:?}: bottom {near:.0}, near horizon {far:.0}", t.elapsed());
        assert!(near > far + 30.0, "bottom {near} should be nearer than the horizon {far}");
    }
}
