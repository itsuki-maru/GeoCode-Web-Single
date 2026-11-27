//! 管理画面専用のTauriホスト。通常デスクトップのHTTP起動経路を使用しない。
use super::Manager;
use crate::init::SetupForm;
use crate::local_routing::config::HttpSettings;
use crate::local_tiles::{runtime::read_png, service::valid_id};
use crate::tilegen::tile::TileId;
use serde_json::Value;
use std::{
    borrow::Cow,
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager as _;

const LABEL: &str = "tile-manager";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost https://ipc.localhost; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

struct DesktopState {
    manager: Arc<Manager>,
    config_path: PathBuf,
    previews: Mutex<PreviewTiles>,
}

/// 管理DBの直近の照会で利用可能だった描画世代だけを、読取専用で公開する。
#[derive(Default)]
struct PreviewTiles(HashMap<String, PathBuf>);

impl PreviewTiles {
    fn from_snapshot(snapshot: &Value) -> Self {
        let mut previews = Self::default();
        let Some(root) = snapshot["config"]["cache_path"].as_str() else {
            return previews;
        };
        for dataset in snapshot["datasets"].as_array().into_iter().flatten() {
            let Some(id) = dataset["id"].as_str().filter(|s| valid_id(s)) else {
                continue;
            };
            if dataset["retired"] != false {
                continue;
            }
            for profile in dataset["profiles"].as_array().into_iter().flatten() {
                let Some(render) = profile["id"].as_str().filter(|s| valid_id(s)) else {
                    continue;
                };
                if profile["retired"] == false {
                    previews.0.insert(
                        format!("{id}/{render}"),
                        PathBuf::from(root).join(id).join(render),
                    );
                }
            }
        }
        previews
    }
    fn tile_path(&self, path: &str) -> Option<PathBuf> {
        let mut parts = path.strip_prefix("/preview/")?.split('/');
        let dataset = parts.next()?;
        let render = parts.next()?;
        let z = parts.next()?.parse().ok()?;
        let x = parts.next()?.parse().ok()?;
        let y = parts.next()?.strip_suffix(".png")?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        let tile = TileId::new(z, x, y).ok()?;
        let root = self.0.get(&format!("{dataset}/{render}"))?;
        Some(
            root.join(tile.z.to_string())
                .join(tile.x.to_string())
                .join(format!("{}.png", tile.y)),
        )
    }
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
    let snapshot = state.manager.snapshot().await?;
    *state.previews.lock().unwrap() = PreviewTiles::from_snapshot(&snapshot);
    Ok(snapshot)
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
async fn tile_manager_storage(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: crate::local_tiles::catalog::rebind::storage::Action,
) -> Result<Value, String> {
    authorize(&window)?;
    let path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::local_tiles::catalog::rebind::storage::run(&path, request)
    })
    .await
    .map_err(super::message)?
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
async fn tile_manager_save_route_http(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    expected: HttpSettings,
    dataset: Option<String>,
    allow_origin: Option<String>,
) -> Result<(), String> {
    authorize(&window)?;
    let path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::init::routing_http::save(
            &path,
            &expected,
            dataset.as_deref(),
            allow_origin.as_deref(),
        )
    })
    .await
    .map_err(super::message)?
    .map_err(super::message)
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

fn asset(path: &str) -> Option<(&'static str, Cow<'static, [u8]>)> {
    if let Some(name) = path.strip_prefix("/assets/") {
        let mime = match name {
            "leaflet.js" => "text/javascript; charset=utf-8",
            "leaflet.css" => "text/css; charset=utf-8",
            "layers.png" | "layers-2x.png" | "marker-icon.png" | "marker-icon-2x.png"
            | "marker-shadow.png" => "image/png",
            _ => return None,
        };
        return Some((mime, crate::StaticAsset::get(name)?.data));
    }
    let (mime, bytes): (_, &'static [u8]) = match path {
        "/" | "/index.html" => (
            "text/html; charset=utf-8",
            include_bytes!("../../tile-manager/index.html"),
        ),
        "/app.js" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../tile-manager/app.js"),
        ),
        "/paths.js" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../tile-manager/paths.js"),
        ),
        "/routes.js" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../tile-manager/routes.js"),
        ),
        "/style.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../tile-manager/style.css"),
        ),
        _ => return None,
    };
    Some((mime, Cow::Borrowed(bytes)))
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
        previews: Mutex::default(),
    };
    tauri::Builder::default()
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("tile-manager", |ctx, request, responder| {
            let path = request.uri().path();
            let allowed =
                ctx.webview_label() == LABEL && matches!(request.method().as_str(), "GET" | "HEAD");
            let head = request.method().as_str() == "HEAD";
            let respond = move |item: Option<(&'static str, Cow<'static, [u8]>)>| {
                let (status, content_type, bytes) = match item {
                    Some((content_type, bytes)) => (200, content_type, bytes),
                    None => (
                        404,
                        "text/plain; charset=utf-8",
                        Cow::Borrowed(&b"Not found"[..]),
                    ),
                };
                responder.respond(
                    tauri::http::Response::builder()
                        .status(status)
                        .header("Content-Type", content_type)
                        .header("Content-Security-Policy", CSP)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Cache-Control", "no-store")
                        .body(if head { Cow::Borrowed(&[][..]) } else { bytes })
                        .unwrap(),
                );
            };
            if allowed && path.starts_with("/preview/") {
                let state = ctx.app_handle().state::<DesktopState>();
                let file = state.previews.lock().unwrap().tile_path(path);
                tauri::async_runtime::spawn_blocking(move || {
                    let png = file.and_then(|path| read_png(&path).ok().flatten());
                    respond(png.map(|bytes| ("image/png", Cow::Owned(bytes))));
                });
            } else {
                respond(if allowed { asset(path) } else { None });
            }
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
            tile_manager_storage,
            tile_manager_save_route_http,
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
    fn preview_resolves_only_active_cached_tiles_in_the_last_snapshot() {
        let dataset = "a".repeat(64);
        let render = "b".repeat(64);
        let retired = "c".repeat(64);
        let root = tempfile::tempdir().unwrap();
        let previews = PreviewTiles::from_snapshot(&serde_json::json!({
            "config":{"cache_path":root.path()},
            "datasets":[{"id":dataset, "retired":false, "profiles":[
                {"id":render,"retired":false},{"id":retired,"retired":true}
            ]}]
        }));
        let prefix = format!("/preview/{dataset}/{render}");
        let file = previews.tile_path(&format!("{prefix}/2/1/3.png")).unwrap();
        assert_eq!(
            file,
            root.path().join(&dataset).join(&render).join("2/1/3.png")
        );
        assert!(read_png(&file).unwrap().is_none());
        assert!(!file.parent().unwrap().exists());
        for bad in [
            format!("{prefix}/2/4/0.png"),
            format!("{prefix}/2/1/3.png/extra"),
            format!("/preview/{dataset}/{retired}/0/0/0.png"),
            format!("/preview/../{render}/0/0/0.png"),
        ] {
            assert!(previews.tile_path(&bad).is_none());
        }
        assert!(asset("/assets/../templates/index.html").is_none());
    }
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
        assert!(asset("/paths.js").is_some());
    }
}
