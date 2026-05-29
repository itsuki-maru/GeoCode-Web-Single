// Windowsでコンソールを非表示にする設定処理
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use geocode_web_single::{
    build_tera_from_embed,
    config::CONFIG,
    db::{check_and_insert_initial_data, setup_database_pool},
    init::{SetupForm, build_env_from_form, get_application_user_setup_path, read_env_json},
    model::ApplicationInitSetup,
    router, utils,
};
use std::env;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use tauri::Manager;

const SERVER_ADDR: &str = "127.0.0.1:3000";
const WINDOW_URL: &str = "http://localhost:3000/index";

/// target="_blank" の外部リンクをデフォルトブラウザで開くための初期化スクリプト。
/// on_navigation は新規ウィンドウ要求をインターセプトできないため、
/// クリックイベントを捕捉して Tauri コマンド経由でブラウザを起動する。
const OPEN_EXTERNAL_SCRIPT: &str = r#"
    document.addEventListener('click', function(e) {
        const a = e.target.closest('a');
        if (!a || !a.href) return;
        try {
            const { hostname, pathname } = new URL(a.href);
            if (((hostname !== 'localhost' && hostname !== '127.0.0.1')) || pathname === '/licanses') {
                e.preventDefault();
                window.__TAURI_INTERNALS__.invoke('open_url', { url: a.href });
            }
        } catch (_) {}
    }, true);
"#;

// axum シャットダウン信号を保持する Tauri 管理状態
struct ShutdownState(Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>);

/// 環境変数を設定する（unsafe: シングルスレッドの初期化フェーズ限定）。
/// `server_addr` は ALLOW_ORIGINS に追加するバインドアドレス（例: "127.0.0.1:3000"）。
unsafe fn apply_env_vars(env: &ApplicationInitSetup, server_addr: &str) {
    // Rust 2024: unsafe fn 内でも unsafe ブロックが必要
    unsafe {
        env::set_var("APP_TITLE", &env.app_title);
        env::set_var(
            "CREATEDATABASE_PATH",
            env.sqlite_database_path.to_string_lossy().as_ref(),
        );
        env::set_var("DATABASE_URL", &env.database_url);
        env::set_var("SECRET_KEY", &env.secret_key);
        env::set_var("IMAGE_FILES_PATH", &env.image_file_path);
        env::set_var("UPLOAD_FILE_PATH", &env.upload_file_path);
        env::set_var("FAILED_ACCOUNT_LOCK", &env.failed_account_lock);
        env::set_var("NEXT_CHALLENGE_MINUTES", &env.next_challenge_minutes);
        env::set_var(
            "CHALLENGE_LIMIT_TIME_FAILEDCOUNT",
            &env.challenge_limit_time_failed_count,
        );
        env::set_var("ADMIN_USERNAME", &env.admin_username);
        env::set_var("ADMIN_PASSWORD", &env.admin_passwotd);
        env::set_var("ACCESS_TOKEN_EXP_MINUTUES", &env.access_token_exp_minutes);
        env::set_var("REFRESH_TOKEN_EXP_MINUTUES", &env.refresh_token_exp_minutes);
        env::set_var("CACHE_CONTROL", &env.cache_control);
        env::set_var("SECURE_COOKIE", &env.secure_cookie);
        env::set_var("SERVICE_NAME", &env.service_name);
        env::set_var("RUST_LOG", &env.rust_log);
        env::set_var("ALLOW_USER_CREATE_ACCOUNT", &env.allow_user_create_account);
        env::set_var(
            "ALLOW_USER_UPDATE_PASSWORD",
            &env.allow_user_update_password,
        );
        env::set_var(
            "ALLOW_ORIGINS",
            format!("{},http://{}", &env.allow_origins, server_addr),
        );
        env::set_var(
            "TILE_SERVER_BASE_URL",
            &env.tile_server_base_url.as_deref().unwrap_or(""),
        );
        env::set_var(
            "TILE_SERVER_API_KEY",
            &env.tile_server_api_key.as_deref().unwrap_or(""),
        );
    }
}

// ログの初期化（複数回呼ばれても安全）
static LOG_INIT: std::sync::Once = std::sync::Once::new();
fn init_tracing() {
    LOG_INIT.call_once(|| {
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "Middleware Debug".into()),
            )
            .with(tracing_subscriber::fmt::layer())
            .try_init()
            .ok();
    });
}

/// 外部URLをデフォルトブラウザで開く Tauri コマンド。
#[tauri::command]
fn open_url(url: String) {
    let _ = open::that(url);
}

/// セットアップフォーム送信時に呼ばれる Tauri コマンド
/// 設定を保存し、 axum を起動してからメインウィンドウを表示する
#[tauri::command]
async fn complete_setup(
    app: tauri::AppHandle,
    shutdown_state: tauri::State<'_, ShutdownState>,
    form: SetupForm,
) -> Result<(), String> {
    let setup_dir = get_application_user_setup_path();

    // フォームデータから設定を構築・JSON保存
    let env = build_env_from_form(setup_dir, form)?;

    // 環境変数を設定（Rust 2024: unsafeが必要）
    unsafe {
        apply_env_vars(&env, SERVER_ADDR);
    }

    // ログ設定（RUST_LOG 設定後に呼ぶ）
    init_tracing();
    tracing::info!("==================== Server Startup (after setup) ====================");

    // DB接続・初期データ投入
    let pool = setup_database_pool()
        .await
        .map_err(|e| format!("DB error: {}", e))?;
    check_and_insert_initial_data(&pool)
        .await
        .map_err(|e| format!("Seed error: {}", e))?;

    // Tera テンプレート
    let tera = build_tera_from_embed().map_err(|e| e.to_string())?;
    let tera = Arc::new(TokioMutex::new(tera));

    // axum ルーター
    let app_router = router::build_router(pool, tera);

    // TCP バインド
    let listener = tokio::net::TcpListener::bind(SERVER_ADDR)
        .await
        .map_err(|e| format!("Bind error: {}", e))?;

    tracing::info!("========== Listening on http://{} ==========", SERVER_ADDR);

    // シャットダウンチャネルを生成し、 State に格納
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut guard = shutdown_state.0.lock().unwrap();
        *guard = Some(shutdown_tx);
    }

    // メインウィンドウを作成（CONFIG は env 設定後にはじめてアクセスする）
    tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External(WINDOW_URL.parse().unwrap()),
    )
    .title(&CONFIG.app_title)
    .inner_size(1920.0, 1080.0)
    .maximized(true)
    .zoom_hotkeys_enabled(true)
    .initialization_script(OPEN_EXTERNAL_SCRIPT)
    .build()
    .map_err(|e| e.to_string())?;

    // セットアップウィンドウを閉じる
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }

    // axum をバックグラウンドで起動（invoke はここで返る）
    tokio::spawn(async move {
        axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.ok();
                tracing::info!("==================== Server Shutdown ====================");
            })
            .await
            .unwrap();
    });

    Ok(())
}

/// `-s` オプションで起動したときに使用するサーバー単体モード。
/// Tauri なしで axum を起動し、Ctrl+C でグレースフルシャットダウンする。
fn run_server_mode(bind_addr: String) {
    // Windows リリースビルドでは windows_subsytem_"windows" のためコンソールを手動で確保する
    #[cfg(windows)]
    utils::ensure_console();

    println!("Server mode: binding to http://{}", bind_addr);

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(async move {
        let setup_dir = get_application_user_setup_path();
        let env = match read_env_json(&setup_dir) {
            Some(env) => env,
            None => {
                eprintln!(
                    "Error: 設定ファイルが見つかりません。\
                     先に通常起動 (Tauri GUI) でセットアップを完了してください。"
                );
                std::process::exit(1);
            },
        };

        unsafe {
            apply_env_vars(&env, &bind_addr);
        }

        init_tracing();
        tracing::info!("==================== Server Mode Startup ====================");

        let pool = match setup_database_pool().await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("Failed to create DB pool: {}", e);
                std::process::exit(1);
            },
        };
        check_and_insert_initial_data(&pool).await.unwrap();

        let tera = Arc::new(TokioMutex::new(build_tera_from_embed().unwrap()));
        let app_router = router::build_router(pool, tera);

        let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("Failed to bind {}: {}", bind_addr, e);
                std::process::exit(1);
            },
        };

        tracing::info!("========== Listening on http://{} ==========", bind_addr);
        tracing::info!("Press Ctrl+C to stop the server.");

        axum::serve(listener, app_router)
            .with_graceful_shutdown(async {
                tokio::signal::ctrl_c()
                    .await
                    .expect("Failed to listen for Ctrl+C");
                tracing::info!("==================== Server Shutdown ====================");
            })
            .await
            .unwrap();
    });
}

fn main() {
    // CLI 引数解析
    // `-s <IP>` が指定された場合はサーバー単体モードで起動する。
    // <IP> はホストのみ（"0.0.0.0"）またはホスト:ポート（"0.0.0.0:3000"）を受け付ける。
    // ポートが省略された場合はデフォルトの 3000 番を使用する。
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "-s") {
        let ip_arg = args
            .get(pos + 1)
            .cloned()
            .unwrap_or_else(|| "0.0.0.0".to_string());
        // ポートが含まれていなければデフォルトポートを付与
        let bind_addr = if ip_arg.contains(':') {
            ip_arg
        } else {
            format!("{}:3000", ip_arg)
        };
        run_server_mode(bind_addr);
        return;
    }

    // ShutdownState を Arc で共有（on_window_event からも参照する）
    let shutdown_inner = Arc::new(Mutex::new(None::<tokio::sync::oneshot::Sender<()>>));
    let shutdown_for_event = Arc::clone(&shutdown_inner);

    tauri::Builder::default()
        .manage(ShutdownState(shutdown_inner))
        // セットアップ画面用カスタムプロトコル（axum 未起動でも配信可能）
        .register_uri_scheme_protocol("app-setup", |_app, _req| {
            let html = include_str!("../setup/index.html");
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(html.as_bytes().to_vec())
                .unwrap()
        })
        .setup(move |app| {
            let setup_dir = get_application_user_setup_path();
            let env_json_path = setup_dir.join("geocode-web-single.env.json");

            if !env_json_path.exists() {
                // 初回起動: セットアップウィンドウを表示
                tauri::WebviewWindowBuilder::new(
                    app,
                    "setup",
                    tauri::WebviewUrl::CustomProtocol("app-setup://index".parse().unwrap()),
                )
                .title("初回セットアップ")
                .inner_size(800.0, 800.0)
                .resizable(false)
                .center()
                .build()?;
            } else {
                // 通常起動: 設定を読み込んで axum を起動
                let env = read_env_json(&setup_dir).expect("設定ファイルの読み込みに失敗しました");

                // 環境変数設定
                unsafe {
                    apply_env_vars(&env, SERVER_ADDR);
                }

                // ログ設定
                init_tracing();
                tracing::info!("==================== Server Startup ====================");

                // axum 起動完了通知チャネル
                let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

                // シャットダウンチャネルを生成し State に格納
                let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
                {
                    let state = app.state::<ShutdownState>();
                    let mut guard = state.0.lock().unwrap();
                    *guard = Some(shutdown_tx);
                }

                tauri::async_runtime::spawn(async move {
                    let pool = match setup_database_pool().await {
                        Ok(pool) => pool,
                        Err(e) => {
                            tracing::error!("Failed to create pool: {}", e);
                            return;
                        },
                    };
                    check_and_insert_initial_data(&pool).await.unwrap();

                    let tera = build_tera_from_embed().unwrap();
                    let tera = Arc::new(TokioMutex::new(tera));

                    let app_router = router::build_router(pool, tera);

                    let listener = match tokio::net::TcpListener::bind(SERVER_ADDR).await {
                        Ok(l) => l,
                        Err(e) => {
                            tracing::error!("Failed to bind {}: {}", SERVER_ADDR, e);
                            return;
                        },
                    };

                    tracing::info!("========== Listening on http://{} ==========", SERVER_ADDR);

                    // Tauriウィンドウ作成前にサーバ準備完了を通知
                    let _ = ready_tx.send(());

                    axum::serve(listener, app_router)
                        .with_graceful_shutdown(async move {
                            shutdown_rx.await.ok();
                            tracing::info!(
                                "==================== Server Shutdown ===================="
                            );
                        })
                        .await
                        .unwrap();
                });

                // axumが起動するまで最大30秒待機
                ready_rx
                    .recv_timeout(std::time::Duration::from_secs(30))
                    .expect("axum server failed to start within 30 seconds");

                // メインウィンドウを作成
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::External(WINDOW_URL.parse().unwrap()),
                )
                .title(&CONFIG.app_title)
                .inner_size(1920.0, 1080.0)
                .maximized(true)
                .zoom_hotkeys_enabled(true)
                .initialization_script(OPEN_EXTERNAL_SCRIPT)
                .build()?;
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            // メインウィンドウが破棄されたら axum にシャットダウン信号を送信
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Ok(mut guard) = shutdown_for_event.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(());
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![complete_setup, open_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
