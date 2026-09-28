//! Healing: LaMa inpainting (big-lama, Apache-2.0, ONNX export by Carve) run
//! through ONNX Runtime. The renderer cuts a square around the area to heal,
//! scales it to the model's fixed SIZE², and sends it with a mask; the model
//! returns the square with the masked area filled in.

use ort::value::Tensor;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::models::{self, LAMA};

/// The network's fixed input resolution.
pub const SIZE: usize = 512;

/// RGBA8 + mask bytes → the model's NCHW inputs: image in [0, 1], mask in {0, 1}.
fn preprocess(body: &[u8]) -> (Vec<f32>, Vec<f32>) {
    let plane = SIZE * SIZE;
    let (rgba, mask) = body.split_at(plane * 4);
    let mut image = vec![0f32; 3 * plane];
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        for c in 0..3 {
            image[c * plane + i] = px[c] as f32 / 255.0;
        }
    }
    let mask = mask.iter().map(|&m| if m >= 128 { 1.0 } else { 0.0 }).collect();
    (image, mask)
}

/// The model's NCHW output (0–255) → RGBA8, opaque.
fn postprocess(pred: &[f32]) -> Vec<u8> {
    let plane = SIZE * SIZE;
    let mut out = vec![255u8; plane * 4];
    for i in 0..plane {
        for c in 0..3 {
            out[i * 4 + c] = pred[c * plane + i].round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Body: SIZE² RGBA8 pixels followed by a SIZE² mask (one byte per pixel,
/// ≥128 = fill in). Returns SIZE² RGBA8 with the masked area filled.
#[tauri::command]
pub async fn inpaint(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("inpaint expects a raw body".into());
    };
    if body.len() != SIZE * SIZE * 5 {
        return Err(format!("expected {SIZE}x{SIZE} RGBA + mask, got {} bytes", body.len()));
    }
    let (image, mask) = preprocess(body);
    models::with_session(app, LAMA, move |session| {
        let outputs = session
            .run(ort::inputs![
                "image" => Tensor::from_array(([1usize, 3, SIZE, SIZE], image)).map_err(|e| e.to_string())?,
                "mask" => Tensor::from_array(([1usize, 1, SIZE, SIZE], mask)).map_err(|e| e.to_string())?
            ])
            .map_err(|e| format!("inpainting: {e}"))?;
        let (_, pred) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if pred.len() != 3 * SIZE * SIZE {
            return Err(format!("unexpected model output size {}", pred.len()));
        }
        Ok(Response::new(postprocess(pred)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_and_postprocess_round_trip() {
        let plane = SIZE * SIZE;
        let mut body = vec![0u8; plane * 5];
        body[0..4].copy_from_slice(&[255, 128, 0, 255]);
        body[plane * 4] = 200;
        let (image, mask) = preprocess(&body);
        assert_eq!((image[0], image[plane], image[2 * plane]), (1.0, 128.0 / 255.0, 0.0));
        assert_eq!((mask[0], mask[1]), (1.0, 0.0));
        let pred: Vec<f32> = image.iter().map(|v| v * 255.0).collect();
        assert_eq!(&postprocess(&pred)[0..4], &[255, 128, 0, 255]);
    }

    /// Runs the real model when SABATTIER_LAMA points at lama_fp32.onnx:
    /// a flat gray square with a black blot masked out must come back gray.
    #[test]
    fn heals_a_blot() {
        let Ok(path) = std::env::var("SABATTIER_LAMA") else { return };
        let mut session = ort::session::Session::builder().unwrap().commit_from_file(path).unwrap();
        let plane = SIZE * SIZE;
        let mut body = vec![0u8; plane * 5];
        for i in 0..plane {
            let (x, y) = (i % SIZE, i / SIZE);
            let blot = (x as i32 - 256).pow(2) + (y as i32 - 256).pow(2) < 40 * 40;
            let v = if blot { 0 } else { 150 };
            body[i * 4..i * 4 + 4].copy_from_slice(&[v, v, v, 255]);
            body[plane * 4 + i] = if (x as i32 - 256).pow(2) + (y as i32 - 256).pow(2) < 48 * 48 { 255 } else { 0 };
        }
        let (image, mask) = preprocess(&body);
        let outputs = session
            .run(ort::inputs![
                "image" => Tensor::from_array(([1usize, 3, SIZE, SIZE], image)).unwrap(),
                "mask" => Tensor::from_array(([1usize, 1, SIZE, SIZE], mask)).unwrap()
            ])
            .unwrap();
        let (_, pred) = outputs[0].try_extract_tensor::<f32>().unwrap();
        let out = postprocess(pred);
        let center = out[(256 * SIZE + 256) * 4] as i32;
        assert!((center - 150).abs() < 20, "blot center healed to {center}, expected ~150");
    }
}
