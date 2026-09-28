use std::process::Command;

/// The only pages the app opens in the browser (the About dialog). Anything else
/// is refused, so the webview can't use this to launch arbitrary programs.
const ALLOWED: &[&str] = &[
    "https://github.com/sina5/Sabattier",
    "https://github.com/sponsors/sina5",
];

/// Opens one of the app's own web pages in the default browser.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    if !ALLOWED.contains(&url.as_str()) {
        return Err(format!("not an allowed link: {url}"));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
