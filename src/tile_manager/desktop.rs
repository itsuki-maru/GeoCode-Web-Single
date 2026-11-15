//! 管理画面専用のTauriホスト。通常デスクトップのHTTP起動経路を使用しない。
use super::Manager;
use crate::init::SetupForm;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

const LABEL: &str = "tile-manager";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost https://ipc.localhost; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

struct DesktopState {
    manager: Arc<Manager>,
    config_path: PathBuf,
}

fn local_page(url: &tauri::Url) -> bool {
    let origin = (url.scheme() == "tile-manager" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tile-manager.localhost")
            && url.port().is_none());
    origin
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
}

fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL || !local_page(&window.url().map_err(|e| e.to_string())?) {
        return Err("この画面から管理操作を呼び出すことはできません。".into());
    }
    Ok(())
}

#[tauri::command]
async fn tile_manager_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, String> {
    authorize(&window)?;
    state.manager.snapshot().await
}

#[tauri::command]
async fn tile_manager_query(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    authorize(&window)?;
    state.manager.query(&action, payload).await
}

#[tauri::command]
async fn tile_manager_submit(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    action: String,
    payload: Value,
    request_id: String,
) -> Result<Value, String> {
    authorize(&window)?;
    state.manager.submit(&action, payload, request_id).await
}

#[tauri::command]
async fn tile_manager_initialize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    form: SetupForm,
) -> Result<(), String> {
    authorize(&window)?;
    super::setup::initialize(&state.config_path, form).await
}

#[tauri::command]
async fn tile_manager_pick_path(
    window: tauri::WebviewWindow,
    kind: String,
) -> Result<Option<String>, String> {
    authorize(&window)?;
    if !matches!(
        kind.as_str(),
        "pbf" | "landmask" | "elevation" | "database" | "folder"
    ) {
        return Err("選択する資料の種類が不正です。".into());
    }
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let (send, receive) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("tile-manager-file-dialog".into())
            .spawn(move || {
                let _ = send.send(pick_windows_path(&kind, owner));
            })
            .map_err(|e| e.to_string())?;
        receive.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("ファイルの絶対パスを入力してください。".into())
    }
}

#[cfg(windows)]
fn pick_windows_path(kind: &str, owner: usize) -> Result<Option<String>, String> {
    use windows::{
        Win32::{
            Foundation::HWND,
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize,
            },
            UI::Shell::{
                Common::COMDLG_FILTERSPEC, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST,
                FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog,
                IFileOpenDialog, SIGDN_FILESYSPATH,
            },
        },
        core::w,
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    // 新しい専用スレッドにSTAを作り、COMのオブジェクトと文字列を同じスレッドで解放する。
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        let mut options = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT;
        if matches!(kind, "folder" | "elevation") {
            options |= FOS_PICKFOLDERS;
        } else {
            options |= FOS_FILEMUSTEXIST;
        }
        dialog.SetOptions(options).map_err(|e| e.to_string())?;
        let filter = match kind {
            "pbf" => Some(COMDLG_FILTERSPEC {
                pszName: w!("OSM PBF"),
                pszSpec: w!("*.osm.pbf;*.pbf"),
            }),
            "landmask" => Some(COMDLG_FILTERSPEC {
                pszName: w!("陸域 Shapefile"),
                pszSpec: w!("*.shp"),
            }),
            "database" => Some(COMDLG_FILTERSPEC {
                pszName: w!("SQLite データベース"),
                pszSpec: w!("*.sqlite;*.sqlite3;*.db"),
            }),
            _ => None,
        };
        if let Some(filter) = filter {
            dialog.SetFileTypes(&[filter]).map_err(|e| e.to_string())?;
        }
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut std::ffi::c_void))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(error.to_string());
        }
        let selected = dialog.GetResult().map_err(|e| e.to_string())?;
        let path = selected
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|e| e.to_string())?;
        let value = path.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(path.0.cast()));
        value.map(Some)
    }
}

fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    match path {
        "/" | "/index.html" => Some((
            "text/html; charset=utf-8",
            include_bytes!("../../tile-manager/index.html"),
        )),
        "/app.js" => Some((
            "text/javascript; charset=utf-8",
            include_bytes!("../../tile-manager/app.js"),
        )),
        "/style.css" => Some((
            "text/css; charset=utf-8",
            include_bytes!("../../tile-manager/style.css"),
        )),
        _ => None,
    }
}

pub fn run(config_path: Option<PathBuf>) -> Result<(), String> {
    let config_path = config_path.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".geocode-web-single/geocode-web-single.env.json")
    });
    if !config_path.is_absolute() {
        return Err("設定JSONの絶対パスを指定してください。".into());
    }
    let state = DesktopState {
        manager: Arc::new(Manager::new(
            config_path.clone(),
            std::env::current_exe().map_err(|e| e.to_string())?,
        )),
        config_path,
    };
    tauri::Builder::default()
        .manage(state)
        .register_uri_scheme_protocol("tile-manager", |_app, request| {
            let item = if matches!(request.method().as_str(), "GET" | "HEAD") {
                asset(request.uri().path())
            } else {
                None
            };
            let (status, content_type, bytes) = match item {
                Some((content_type, bytes)) => (200, content_type, bytes),
                None => (404, "text/plain; charset=utf-8", &b"Not found"[..]),
            };
            tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", content_type)
                .header("Content-Security-Policy", CSP)
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "no-store")
                .body(if request.method().as_str() == "HEAD" {
                    Vec::new()
                } else {
                    bytes.to_vec()
                })
                .unwrap()
        })
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                tauri::WebviewUrl::CustomProtocol(
                    "tile-manager://localhost/index.html".parse().unwrap(),
                ),
            )
            .title("GeoCode-Web ローカル地図管理")
            .inner_size(1180.0, 860.0)
            .min_inner_size(900.0, 680.0)
            .center()
            .on_navigation(local_page)
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tile_manager_snapshot,
            tile_manager_query,
            tile_manager_submit,
            tile_manager_initialize,
            tile_manager_pick_path
        ])
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?
        // 終了時にワーカーの取消やshutdownを呼ばない。処理の所有者は別プロセス。
        .run(|_, _| {});
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrict_manager_commands_to_bundled_page() {
        for url in [
            "tile-manager://localhost/index.html",
            "http://tile-manager.localhost/index.html",
            "https://tile-manager.localhost/",
        ] {
            assert!(local_page(&url.parse().unwrap()));
        }
        for url in [
            "http://localhost:3000/index",
            "https://example.com/index.html",
            "http://tile-manager.localhost:3000/index.html",
            "tile-manager://localhost/other.html",
            "http://tile-manager.localhost/index.html?redirect=remote",
            "http://tile-manager.localhost.example.com/index.html",
        ] {
            assert!(!local_page(&url.parse().unwrap()), "{url}");
        }
        assert!(asset("/../setup/index.html").is_none());
        assert!(asset("/app.js").is_some());
    }
}
