//! Settings → "Use all CPU cores". On (the default), heavy work — HDR merge,
//! RAW development, the AI models — spreads over every core; off, each job
//! keeps to one core and leaves the rest of the computer responsive.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::blocking;

static MULTICORE: AtomicBool = AtomicBool::new(true);

pub(crate) fn enabled() -> bool {
    MULTICORE.load(Ordering::Relaxed)
}

/// Run `f`, whose rayon work (ours and rawler's) then uses every core or
/// just one. Off, each call gets its own one-thread pool, so concurrent jobs
/// don't queue behind each other.
pub(crate) fn run<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    if enabled() {
        return f();
    }
    match rayon::ThreadPoolBuilder::new().num_threads(1).build() {
        Ok(pool) => pool.install(f),
        Err(_) => f(),
    }
}

/// Intra-op threads for a new model session: `None` keeps ONNX Runtime's
/// default (one per physical core).
pub(crate) fn model_threads() -> Option<usize> {
    (!enabled()).then_some(1)
}

#[tauri::command]
pub async fn set_multicore(app: AppHandle, on: bool) -> Result<(), String> {
    if MULTICORE.swap(on, Ordering::Relaxed) == on {
        return Ok(());
    }
    // Loaded models keep the thread count they were built with; drop them so
    // the next run reloads with the new one. Waits for a running model.
    blocking(move || app.state::<crate::models::Models>().clear()).await
}
