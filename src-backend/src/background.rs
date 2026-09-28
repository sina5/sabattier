//! Background removal: ISNet (DIS, "general use" weights, Apache-2.0) run
//! through ONNX Runtime. The model is fetched by the model manager (see
//! models.rs) on first use.

use ort::value::Tensor;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::models::{self, ISNET};

/// The network's fixed input resolution; the renderer sends RGBA at this size.
pub const SIZE: usize = 1024;

/// Same normalization as rembg's ISNet session: scale by the image maximum,
/// subtract 0.5 per channel (std is 1.0), NCHW layout.
fn preprocess(rgba: &[u8]) -> Vec<f32> {
    let plane = SIZE * SIZE;
    let max = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let mut out = vec![0f32; 3 * plane];
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        for c in 0..3 {
            out[c * plane + i] = px[c] as f32 / max - 0.5;
        }
    }
    out
}

/// Min-max normalize the predicted matte to 0–255.
fn postprocess(pred: &[f32]) -> Vec<u8> {
    let (lo, hi) = pred
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let range = (hi - lo).max(1e-6);
    pred.iter().map(|&v| (((v - lo) / range) * 255.0).round() as u8).collect()
}

/// Body: RGBA8 pixels at SIZE×SIZE. Returns the SIZE×SIZE alpha matte (one
/// byte per pixel); the renderer scales it up and applies it to the photo.
#[tauri::command]
pub async fn remove_background(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("remove_background expects a raw RGBA body".into());
    };
    if rgba.len() != SIZE * SIZE * 4 {
        return Err(format!("expected {SIZE}x{SIZE} RGBA, got {} bytes", rgba.len()));
    }
    let input = preprocess(rgba);
    models::with_session(app, ISNET, move |session| {
        let input_name = session.inputs()[0].name().to_string();
        let tensor = Tensor::from_array(([1usize, 3, SIZE, SIZE], input)).map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs![input_name => tensor])
            .map_err(|e| format!("inference: {e}"))?;
        let (_, pred) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if pred.len() != SIZE * SIZE {
            return Err(format!("unexpected model output size {}", pred.len()));
        }
        Ok(Response::new(postprocess(pred)))
    })
    .await
}
