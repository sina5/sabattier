mod background;
mod catalog;
mod depth;
mod faces;
mod files;
mod hdr;
mod inpaint;
mod links;
mod models;
mod parallel;
mod raw;
mod smoke;
mod upscale;

/// Runs blocking work (disk I/O, RAW development, inference) off the main
/// thread. Sync Tauri commands run on the main thread and would freeze the UI.
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(models::Models::default())
        .manage(catalog::Catalog::default())
        .setup(|app| {
            smoke::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::list_images,
            files::read_file,
            files::write_file,
            files::save_pixels,
            files::unique_path,
            files::load_presets,
            files::save_presets,
            files::default_presets_location,
            files::presets_exist,
            raw::decode_raw,
            raw::raw_preview,
            background::remove_background,
            inpaint::inpaint,
            links::open_link,
            links::review_available,
            links::open_review,
            depth::estimate_depth,
            upscale::upscale_save,
            hdr::hdr_add_frame,
            hdr::merge_hdr,
            parallel::set_multicore,
            faces::analyze_faces,
            models::models_list,
            models::model_delete,
            catalog::catalog_get,
            catalog::catalog_set,
            catalog::catalog_export,
            catalog::catalog_import,
            smoke::smoke_config,
            smoke::smoke_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod license_tests {
    use sha2::{Digest, Sha256};

    /// Settings → Open-source licenses must match the crates actually built:
    /// the list records the Cargo.lock it was generated from.
    #[test]
    fn third_party_licenses_are_current() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lock = std::fs::read(dir.join("Cargo.lock")).unwrap();
        let list: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("../src-frontend/licenses/third-party.json")).unwrap()).unwrap();
        let hex: String = Sha256::digest(&lock).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            list["cargoLockSha256"].as_str(),
            Some(hex.as_str()),
            "Cargo.lock changed: run scripts/update-licenses.sh to refresh the open-source license list",
        );
        let has = |krate: &str, license: &str| {
            list["licenses"].as_array().unwrap().iter().any(|l| {
                l["id"].as_str().unwrap().contains(license)
                    && l["crates"].as_array().unwrap().iter().any(|c| c["name"] == krate)
            })
        };
        assert!(has("tauri", "MIT") || has("tauri", "Apache-2.0"));
        assert!(has("ort", "MIT") || has("ort", "Apache-2.0"));
        assert!(has("rawler", "LGPL-2.1"), "rawler's LGPL text must be included");
    }
}
