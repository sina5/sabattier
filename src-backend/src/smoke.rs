//! Smoke test: with SABATTIER_SMOKE=1 the renderer runs its end-to-end flow
//! (see src-frontend/main.tsx), reports back here, and the process exits with
//! a status code. SABATTIER_SMOKE_IMPORT (`;`-separated paths) and
//! SABATTIER_SMOKE_EXPORT (a folder) drive the import and export steps.

use std::time::Duration;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeConfig {
    import_path: Option<String>,
    export_path: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct SmokeReport {
    errors: Vec<String>,
    #[serde(default)]
    info: Vec<String>,
}

fn enabled() -> bool {
    std::env::var_os("SABATTIER_SMOKE").is_some()
}

pub fn setup(_app: &mut tauri::App) {
    if enabled() {
        // First background removal may download the model, so allow longer
        // than a plain launch needs.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(300));
            eprintln!("[smoke] timeout (no ready signal in 300s)");
            std::process::exit(1);
        });
    }
}

/// `null` outside smoke runs, so the renderer's hook stays a no-op.
#[tauri::command]
pub fn smoke_config() -> Option<SmokeConfig> {
    enabled().then(|| SmokeConfig {
        import_path: std::env::var("SABATTIER_SMOKE_IMPORT").ok(),
        export_path: std::env::var("SABATTIER_SMOKE_EXPORT").ok(),
    })
}

#[tauri::command]
pub fn smoke_ready(app: tauri::AppHandle, report: SmokeReport) {
    if !enabled() {
        return;
    }
    let failed = !report.errors.is_empty();
    println!(
        "[smoke] renderer report: {}",
        serde_json::to_string(&report).unwrap_or_default()
    );
    println!("[smoke] {}", if failed { "renderer errors" } else { "ok" });
    // SABATTIER_SMOKE_KEEP_OPEN leaves the window up after the checks, e.g. to
    // screenshot the loaded UI.
    if std::env::var_os("SABATTIER_SMOKE_KEEP_OPEN").is_none() {
        app.exit(if failed { 1 } else { 0 });
    }
}
