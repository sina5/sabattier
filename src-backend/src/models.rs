//! Model manager: the ML models the app can use, downloaded on first use into
//! `<app data>/models`, verified against a pinned SHA-256, and loaded into an
//! ONNX Runtime session that stays in memory for the rest of the session.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ort::session::Session;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::blocking;

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// What it is used for, in plain words (shown in Settings).
    pub purpose: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub license: &'static str,
    /// The project the weights come from (shown with the license).
    pub source: &'static str,
    /// The upstream license text, bundled in src-frontend/licenses/.
    pub license_file: &'static str,
}

pub const ISNET: &str = "isnet";
pub const LAMA: &str = "lama";
pub const DEPTH: &str = "depth";
pub const ESRGAN: &str = "esrgan";
pub const YUNET: &str = "yunet";
pub const FACE_LANDMARKS: &str = "face-landmarks";
pub const SELFIE_SEGMENTER: &str = "selfie-multiclass";

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: ISNET,
        name: "Subject finder (ISNet)",
        purpose: "Remove background, subject and background masks",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
        sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
        file: "isnet-general-use.onnx",
        bytes: 178_648_008,
        license: "Apache-2.0",
        source: "https://github.com/xuebinqin/DIS",
        license_file: "isnet-LICENSE.txt",
    },
    ModelSpec {
        id: LAMA,
        name: "Healing (LaMa)",
        purpose: "Remove spots and objects",
        // Pinned to a commit so the file behind the URL can't change.
        url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
        sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
        file: "lama_fp32.onnx",
        bytes: 208_044_816,
        license: "Apache-2.0",
        source: "https://github.com/advimman/lama",
        license_file: "lama-LICENSE.txt",
    },
    ModelSpec {
        id: DEPTH,
        name: "Depth (Depth-Anything-V2 Small)",
        purpose: "Lens blur",
        url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
        sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
        file: "depth-anything-v2-small.onnx",
        bytes: 99_060_839,
        license: "Apache-2.0",
        source: "https://github.com/DepthAnything/Depth-Anything-V2",
        license_file: "depth-LICENSE.txt",
    },
    ModelSpec {
        id: ESRGAN,
        name: "Upscaler (Real-ESRGAN x4plus)",
        purpose: "Upscale 2× or 4× when saving",
        url: "https://huggingface.co/bukuroo/RealESRGAN-ONNX/resolve/a1f365e2ef85ca5d4c66325e76bc7e26374c9642/real-esrgan-x4plus-128.onnx",
        sha256: "6a6f4a3d58553d40fdd443d9e5f4b2deb9b52bef1ec2947700fc2167ac876c7d",
        file: "real-esrgan-x4plus-128.onnx",
        bytes: 67_160_311,
        license: "BSD-3-Clause",
        source: "https://github.com/xinntao/Real-ESRGAN",
        license_file: "esrgan-LICENSE.txt",
    },
    ModelSpec {
        id: YUNET,
        name: "Face finder (YuNet)",
        purpose: "Portrait tools: finds faces",
        url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
        sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        file: "face_detection_yunet_2023mar.onnx",
        bytes: 232_589,
        license: "MIT",
        source: "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet",
        license_file: "yunet-LICENSE.txt",
    },
    ModelSpec {
        id: FACE_LANDMARKS,
        name: "Face landmarks (MediaPipe)",
        purpose: "Portrait tools: eyes, brows and lips",
        url: "https://huggingface.co/senty-au/face_landmarks_detector-ONNX/resolve/337d58218b5b1cc597ca3c67360880b920f6ce7b/onnx/model.onnx",
        sha256: "7d6e82dee82a1dca5fbddb282b3cc74571833a530de317fc22ae325c3358beeb",
        file: "mediapipe-face-landmarks.onnx",
        bytes: 4_920_995,
        license: "Apache-2.0",
        source: "https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker",
        license_file: "mediapipe-LICENSE.txt",
    },
    ModelSpec {
        id: SELFIE_SEGMENTER,
        name: "Skin finder (MediaPipe selfie multiclass)",
        purpose: "Portrait tools: face skin",
        url: "https://huggingface.co/senty-au/selfie_multiclass_256x256-ONNX/resolve/6db8421a7150ac20558f2c24675078eb3a1a04d0/onnx/model.onnx",
        sha256: "35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0",
        file: "mediapipe-selfie-multiclass.onnx",
        bytes: 16_454_560,
        license: "Apache-2.0",
        source: "https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter",
        license_file: "mediapipe-LICENSE.txt",
    },
];

pub fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS.iter().find(|m| m.id == id).ok_or(format!("unknown model {id}"))
}

/// Loaded sessions by model id. Most runs never use a model, and loading one
/// costs a few seconds, so each loads on first use.
#[derive(Default)]
pub struct Models(Mutex<HashMap<&'static str, Session>>);

impl Models {
    /// Unload every model; each reloads on its next use.
    pub(crate) fn clear(&self) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.clear();
        Ok(())
    }
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    id: &'static str,
    name: &'static str,
    received: u64,
    total: Option<u64>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn download(app: &AppHandle, spec: &'static ModelSpec, dest: &Path) -> Result<(), String> {
    let part = dest.with_extension("onnx.part");
    let mut response = ureq::get(spec.url)
        .call()
        .map_err(|e| format!("{} download: {e}", spec.name))?;
    let total = response.body().content_length();
    let mut reader = response.body_mut().as_reader();
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut received = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("{} download: {e}", spec.name))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        let progress = DownloadProgress { id: spec.id, name: spec.name, received, total };
        let _ = app.emit("model-progress", progress);
    }
    drop(file);
    let digest = hex(&hasher.finalize());
    if digest != spec.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{} download corrupted (sha256 {digest})", spec.name));
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// The model file, downloading it first if needed.
fn ensure_file(app: &AppHandle, spec: &'static ModelSpec) -> Result<PathBuf, String> {
    let dir = models_dir(app)?;
    let path = dir.join(spec.file);
    if !path.exists() && !adopt_old_model(&dir, spec.file, &path) {
        download(app, spec, &path)?;
    }
    Ok(path)
}

/// Move a model over from the data folder of an older app id (see
/// files::OLD_APP_IDS), so renaming the app doesn't cost a re-download.
fn adopt_old_model(dir: &Path, file: &str, path: &Path) -> bool {
    // dir is <app data root>/<app id>/models
    let Some(root) = dir.parent().and_then(Path::parent) else { return false };
    crate::files::OLD_APP_IDS.iter().any(|id| {
        let old = root.join(id).join("models").join(file);
        old.exists() && std::fs::rename(&old, path).is_ok()
    })
}

/// Run `f` with the model's session on a blocking thread, downloading and
/// loading the model first if needed. Runs are serialized per app.
pub async fn with_session<T: Send + 'static>(
    app: AppHandle,
    id: &'static str,
    f: impl FnOnce(&mut Session) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let spec = spec(id)?;
    let loaded = app.state::<Models>().0.lock().map_err(|e| e.to_string())?.contains_key(id);
    if !loaded {
        // Download and load without holding the lock, so another model can run meanwhile.
        let app2 = app.clone();
        let session = blocking(move || {
            let path = ensure_file(&app2, spec)?;
            let mut builder = Session::builder().map_err(|e| e.to_string())?;
            if let Some(n) = crate::parallel::model_threads() {
                builder = builder.with_intra_threads(n).map_err(|e| e.to_string())?;
            }
            builder
                .commit_from_file(path)
                .map_err(|e| format!("loading {}: {e}", spec.name))
        })
        .await?;
        app.state::<Models>().0.lock().map_err(|e| e.to_string())?.entry(id).or_insert(session);
    }
    blocking(move || {
        let state = app.state::<Models>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let session = guard.get_mut(id).ok_or("model not loaded")?;
        f(session)
    })
    .await
}

#[derive(serde::Serialize)]
pub struct ModelInfo {
    id: &'static str,
    name: &'static str,
    purpose: &'static str,
    bytes: u64,
    license: &'static str,
    source: &'static str,
    url: &'static str,
    license_file: &'static str,
    installed: bool,
}

/// Every model, and whether it is on disk.
#[tauri::command]
pub fn models_list(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    Ok(MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            name: m.name,
            purpose: m.purpose,
            bytes: m.bytes,
            license: m.license,
            source: m.source,
            url: m.url,
            license_file: m.license_file,
            installed: dir.join(m.file).exists(),
        })
        .collect())
}

/// Delete a downloaded model (it downloads again when next needed).
#[tauri::command]
pub fn model_delete(app: AppHandle, models: State<'_, Models>, id: String) -> Result<(), String> {
    let spec = spec(&id)?;
    models.0.lock().map_err(|e| e.to_string())?.remove(spec.id);
    let path = models_dir(&app)?.join(spec.file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every model's license text ships with the app.
    #[test]
    fn license_files_are_bundled() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-frontend/licenses");
        for m in MODELS {
            let text = std::fs::read_to_string(dir.join(m.license_file)).unwrap_or_else(|e| panic!("{}: {e}", m.license_file));
            let expect = match m.license {
                "Apache-2.0" => "Apache License",
                "BSD-3-Clause" => "BSD 3-Clause",
                "MIT" => "MIT License",
                other => panic!("no check for license {other}"),
            };
            assert!(text.contains(expect), "{} should contain {expect:?}", m.license_file);
        }
    }
}
