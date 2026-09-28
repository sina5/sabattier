use std::process::Command;

/// The only pages the app opens in the browser (the About dialog). Anything else
/// is refused, so the webview can't use this to launch arbitrary programs.
const ALLOWED: &[&str] = &[
    "https://github.com/sina5/Sabattier",
    "https://github.com/sponsors/sina5",
];

/// The app's Microsoft Store product ID (12 characters, from Partner Center).
/// `None` until the app is listed; the review button stays hidden until then.
const MS_STORE_PRODUCT_ID: Option<&str> = None;
/// The app's numeric Mac App Store ID (from App Store Connect), same rule.
const MAC_APP_STORE_ID: Option<&str> = None;

/// The review page for the store that sells the build for this OS, if it is listed there.
fn review_url() -> Option<String> {
    if cfg!(target_os = "windows") {
        MS_STORE_PRODUCT_ID.map(|id| format!("ms-windows-store://review/?ProductId={id}"))
    } else if cfg!(target_os = "macos") {
        MAC_APP_STORE_ID.map(|id| format!("macappstore://apps.apple.com/app/id{id}?action=write-review"))
    } else {
        None
    }
}

/// Opens one of the app's own web pages in the default browser.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    if !ALLOWED.contains(&url.as_str()) {
        return Err(format!("not an allowed link: {url}"));
    }
    launch(&url)
}

/// Whether this OS has a store listing to review, so the UI can hide the button.
#[tauri::command]
pub fn review_available() -> bool {
    review_url().is_some()
}

/// Opens the store's write-a-review page for this OS.
#[tauri::command]
pub fn open_review() -> Result<(), String> {
    let url = review_url().ok_or("no store listing for this platform")?;
    launch(&url)
}

/// Hands a URL (web or store scheme) to the OS's default handler.
fn launch(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
