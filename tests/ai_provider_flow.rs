//! 実際のrouter・設定・HTTPアダプターを通す。接続先はこのプロセス内の模擬サーバーだけ。
#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
};
use geocode_web_single::auth::create_token;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Captured {
    method: String,
    path: String,
    headers: HeaderMap,
    body: Value,
}
struct Route {
    status: StatusCode,
    response: Value,
    requests: Vec<Captured>,
}
struct MockServer {
    origin: String,
    routes: Arc<Mutex<HashMap<String, Route>>>,
}
impl MockServer {
    fn set_output(&self, id: &str, output: Value) {
        self.set_response(
            id,
            StatusCode::OK,
            json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}),
        );
    }
    fn set_response(&self, id: &str, status: StatusCode, response: Value) {
        let mut routes = self.routes.lock().unwrap();
        if let Some(route) = routes.get_mut(id) {
            route.status = status;
            route.response = response;
        } else {
            routes.insert(
                id.into(),
                Route {
                    status,
                    response,
                    requests: vec![],
                },
            );
        }
    }
    fn requests(&self, id: &str) -> Vec<Captured> {
        self.routes
            .lock()
            .unwrap()
            .get(id)
            .unwrap()
            .requests
            .clone()
    }
    fn base_url(&self, id: &str) -> String {
        format!("{}/{id}/v1", self.origin)
    }
}
fn mock_server() -> &'static MockServer {
    static SERVER: OnceLock<MockServer> = OnceLock::new();
    SERVER.get_or_init(|| {
        common::init_test_env();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        // 別の結合テスト実行ファイルとはプロセスが分かれる。値はこのOnce内で一度だけ設定する。
        unsafe {
            std::env::set_var("AI_ALLOWED_ORIGINS", &origin);
            std::env::set_var(
                "AI_ENCRYPTION_KEY",
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            );
        }
        let routes: Arc<Mutex<HashMap<String, Route>>> = Arc::new(Mutex::new(HashMap::new()));
        let state = routes.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let app = Router::new().fallback(move |request: Request<Body>| {
                    let state = state.clone();
                    async move {
                        let method = request.method().to_string();
                        let path = request.uri().path().to_owned();
                        let headers = request.headers().clone();
                        let body = to_bytes(request.into_body(), 512 * 1024).await.unwrap();
                        let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let id = path.split('/').nth(1).unwrap_or_default();
                        let mut state = state.lock().unwrap();
                        let Some(route) = state.get_mut(id) else {
                            return (
                                StatusCode::NOT_FOUND,
                                axum::Json(json!({"error":"unknown mock route"})),
                            )
                                .into_response();
                        };
                        route.requests.push(Captured {
                            method,
                            path: path.clone(),
                            headers,
                            body,
                        });
                        if !path.ends_with("/chat/completions") {
                            return (
                                StatusCode::NOT_FOUND,
                                axum::Json(json!({"error":"unexpected endpoint"})),
                            )
                                .into_response();
                        }
                        (route.status, axum::Json(route.response.clone())).into_response()
                    }
                });
                axum::serve(listener, app).await.unwrap();
            });
        });
        MockServer { origin, routes }
    })
}

fn app(pool: &SqlitePool) -> Router {
    geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    )
}
async fn request(
    app: &Router,
    user: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let token = create_token(&user.to_owned(), 30, "access_token", 0).unwrap();
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", format!("access_token={token}"))
        .header("x-ai-account-id", user.to_string())
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn insert_marker(pool: &SqlitePool, user: &str, name: &str, secret: &str) -> Uuid {
    let layer = common::master_layer_id(pool, &user).await;
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        )
        VALUES ($1, $2, $3, $4, 35, 139, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(id.to_string())
    .bind(&user)
    .bind(layer.to_string())
    .bind(name)
    .bind(secret)
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn mock_llm_chat_executes_owned_search_without_sending_object_contents() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    mock.set_output(&route, json!({"message":"名前と本文に学校を含む対象を検索します。","action":{"type":"filter","expression":{"op":"text","query1":"学校","query2":""}}}));
    let admin = common::create_test_admin(&pool, "ai-flow-admin").await;
    let owner = common::create_test_user(&pool, "ai-flow-owner").await;
    let other = common::create_test_user(&pool, "ai-flow-other").await;
    let selected =
        insert_marker(&pool, &owner, "学校", "OBJECT-CONTENT-MUST-STAY-LOCAL-2468").await;
    insert_marker(&pool, &owner, "病院", "SECOND-PRIVATE-CONTENT-3579").await;
    insert_marker(&pool, &other, "学校", "OTHER-ACCOUNT-MUST-NOT-LEAK-4680").await;
    let app = app(&pool);
    let (status, saved) = request(&app, &admin, "PUT", "/admin/ai-settings", json!({"revision":null,"enabled":true,"provider":"openai","baseUrl":mock.base_url(&route),"model":"mock-model","apiKey":"mock-only-api-key","speechEnabled":false})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let input = json!({"message":"学校を抽出して","history":[],"context":{"layer_ids":null}});
    let (status, chat) = request(&app, &owner, "POST", "/ai/chat", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["action"]["type"], "filter");
    assert_eq!(chat["revision"], saved["revision"]);
    let calls = mock.requests(&route);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].path, format!("/{route}/v1/chat/completions"));
    assert_eq!(
        calls[0].headers["authorization"],
        "Bearer mock-only-api-key"
    );
    let prompt = calls[0].body.to_string();
    for secret in [
        "OBJECT-CONTENT-MUST-STAY-LOCAL-2468",
        "SECOND-PRIVATE-CONTENT-3579",
        "OTHER-ACCOUNT-MUST-NOT-LEAK-4680",
        "mock-only-api-key",
    ] {
        assert!(!prompt.contains(secret));
    }
    let (status, executed) = request(
        &app,
        &owner,
        "POST",
        "/ai/execute",
        json!({"action":chat["action"],"revision":chat["revision"],"context":{"layer_ids":null}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{executed}");
    assert_eq!(executed["target_count"], 1);
    assert_eq!(executed["targets"], json!([format!("marker:{selected}")]));
    let mut disabled = saved;
    disabled["enabled"] = json!(false);
    assert_eq!(
        request(&app, &admin, "PUT", "/admin/ai-settings", disabled)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &owner, "POST", "/ai/chat", input).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(mock.requests(&route).len(), 1, "AI無効時はLLMへ送信しない");
}

#[tokio::test]
async fn administration_encrypts_keys_and_never_reuses_them_at_changed_endpoints() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    mock.set_output(
        &route,
        json!({"message":"接続確認できました。","action":{"type":"reset"}}),
    );
    let admin = common::create_test_admin(&pool, "ai-key-admin").await;
    let app = app(&pool);
    let (status, saved) = request(&app, &admin, "PUT", "/admin/ai-settings", json!({"revision":null,"enabled":false,"provider":"openai","baseUrl":mock.base_url(&route),"model":"mock-model","apiKey":"first-secret-mock-key","speechApiKey":"speech-secret-mock-key"})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["hasApiKey"], true);
    assert_eq!(saved["hasSpeechApiKey"], true);
    for key in ["first-secret-mock-key", "speech-secret-mock-key"] {
        assert!(!saved.to_string().contains(key));
    }
    let encrypted: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_api_key FROM ai_settings WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !encrypted
            .windows(b"first-secret-mock-key".len())
            .any(|part| part == b"first-secret-mock-key")
    );
    let raw_config: String = sqlx::query_scalar("SELECT config FROM ai_settings WHERE id=1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!raw_config.to_string().contains("secret-mock-key"));
    let (status, fetched) = request(&app, &admin, "GET", "/admin/ai-settings", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched, saved);
    assert_eq!(
        request(
            &app,
            &admin,
            "POST",
            "/admin/ai-settings/check",
            saved.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        mock.requests(&route)[0].headers["authorization"],
        "Bearer first-secret-mock-key"
    );
    let mut changed = saved.clone();
    changed["baseUrl"] = json!(format!("{}/{route}/changed/v1", mock.origin));
    let (status, new_settings) = request(&app, &admin, "PUT", "/admin/ai-settings", changed).await;
    assert_eq!(status, StatusCode::OK, "{new_settings}");
    assert_eq!(new_settings["hasApiKey"], false);
    assert_eq!(
        new_settings["hasSpeechApiKey"], true,
        "LLMの接続先変更で独立した音声認識キーを変更しない"
    );
    let old_key: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT encrypted_api_key FROM ai_settings WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(old_key.is_none());
    assert_eq!(
        request(&app, &admin, "PUT", "/admin/ai-settings", saved)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            &admin,
            "POST",
            "/admin/ai-settings/check",
            new_settings.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let calls = mock.requests(&route);
    assert_eq!(calls.len(), 2);
    assert!(calls[1].headers.get("authorization").is_none());
    assert!(calls[1].path.contains("/changed/v1/"));
    let mut cleared = new_settings;
    cleared["clearSpeechApiKey"] = json!(true);
    let (status, cleared) = request(&app, &admin, "PUT", "/admin/ai-settings", cleared).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cleared["hasSpeechApiKey"], false);
    let speech_key: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT encrypted_speech_api_key FROM ai_settings WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(speech_key.is_none());
}

fn luna_connection_payload(mock: &MockServer, route: &str) -> Value {
    json!({
        "revision":null,
        "enabled":true,
        "provider":"openai",
        "baseUrl":mock.base_url(route),
        "model":"gpt-6-luna",
        "apiKey":"connection-regression-test-key",
        "maxOutputTokens":2048,
        "timeoutSeconds":60,
        "speechEnabled":false
    })
}

#[tokio::test]
async fn luna_connection_check_uses_completion_budget_and_validates_reset() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    mock.set_output(
        &route,
        json!({"message":"接続確認できました。","action":{"type":"reset"}}),
    );
    let admin = common::create_test_admin(&pool, "ai-luna-check-admin").await;
    let app = app(&pool);
    let (status, result) = request(
        &app,
        &admin,
        "POST",
        "/admin/ai-settings/check",
        luna_connection_payload(mock, &route),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result, json!({"ok":true}));
    let calls = mock.requests(&route);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].body["model"], "gpt-6-luna");
    assert_eq!(calls[0].body["max_completion_tokens"], 2048);
    assert!(calls[0].body.get("max_tokens").is_none());
    // この接続先はOpenAI互換のローカル模擬サーバー。推論量の送信は必須にしない。
}

#[tokio::test]
async fn connection_failures_explain_rejection_truncation_and_wrong_action_without_echoing_secrets()
{
    let pool = common::test_pool().await;
    let mock = mock_server();
    let admin = common::create_test_admin(&pool, "ai-check-failure-admin").await;
    let app = app(&pool);
    let cases = [
        (
            "unsupported_parameter",
            StatusCode::BAD_REQUEST,
            json!({"error":{"type":"invalid_request_error","code":"unsupported_parameter","param":"max_tokens","message":"TEST-SECRET-MARKER-MUST-NOT-LEAK: max_tokens is unsupported"}}),
        ),
        (
            "output_limit",
            StatusCode::OK,
            json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":null,"refusal":null}}],"usage":{"completion_tokens":2048,"completion_tokens_details":{"reasoning_tokens":2048}}}),
        ),
        (
            "wrong_action",
            StatusCode::OK,
            json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"message":"指定した座標へ移動します。","action":{"type":"focus","latitude":35.0,"longitude":139.0,"zoom":6}}).to_string()}}]}),
        ),
    ];
    for (case, upstream_status, raw_response) in cases {
        let route = Uuid::new_v4().simple().to_string();
        mock.set_response(&route, upstream_status, raw_response);
        let (status, response) = request(
            &app,
            &admin,
            "POST",
            "/admin/ai-settings/check",
            luna_connection_payload(mock, &route),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{case}: {response}");
        let error = response["error"].as_str().unwrap();
        assert!(
            !error.contains("TEST-SECRET-MARKER-MUST-NOT-LEAK"),
            "{case}: 上流のエラー原文を公開しない"
        );
        assert!(!error.contains("connection-regression-test-key"));
        match case {
            "unsupported_parameter" => {
                assert!(error.contains("400"), "{error}");
                assert!(error.contains("max_tokens"), "{error}");
            },
            "output_limit" => {
                assert!(error.contains("出力") && error.contains("上限"), "{error}");
            },
            "wrong_action" => {
                assert!(
                    error.contains("reset") && error.contains("接続確認"),
                    "{error}"
                );
            },
            _ => unreachable!(),
        }
        assert_eq!(
            mock.requests(&route).len(),
            1,
            "{case}: 失敗した接続確認を自動再送しない"
        );
    }
}

#[tokio::test]
async fn chat_rejects_foreign_layers_and_changed_accounts_before_contacting_llm() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    mock.set_output(&route, json!({"message":"接続できました。","action":null}));
    let admin = common::create_test_admin(&pool, "ai-scope-admin").await;
    let user = common::create_test_user(&pool, "ai-scope-user").await;
    let other = common::create_test_user(&pool, "ai-scope-other").await;
    let foreign_layer = common::master_layer_id(&pool, &other).await;
    let app = app(&pool);
    let (status, settings) = request(
        &app,
        &admin,
        "PUT",
        "/admin/ai-settings",
        json!({"revision":null,"enabled":true,"provider":"openai","baseUrl":mock.base_url(&route),"model":"mock-model","apiKey":"scope-security-mock-key"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settings}");

    for layer in [foreign_layer, Uuid::new_v4().to_string()] {
        let (status, error) = request(
            &app,
            &user,
            "POST",
            "/ai/chat",
            json!({"message":"このレイヤーを検索して","history":[],"context":{"layer_ids":[layer]}}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
        assert!(mock.requests(&route).is_empty());
    }

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/ai/chat")
                .header("content-type", "application/json")
                .header(
                    "cookie",
                    format!(
                        "access_token={}",
                        create_token(&user.to_owned(), 30, "access_token", 0).unwrap()
                    ),
                )
                .header("x-ai-account-id", other.to_string())
                .body(Body::from(
                    json!({"message":"以前のアカウントの会話","history":[],"context":{"layer_ids":null}})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(error, json!({"error":"ai_account_changed"}));
    assert!(mock.requests(&route).is_empty());

    let (status, chat) = request(
        &app,
        &user,
        "POST",
        "/ai/chat",
        json!({"message":"操作方法を教えて","history":[],"context":{"layer_ids":null}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(mock.requests(&route).len(), 1);
}

#[tokio::test]
async fn successful_upstream_responses_cannot_distribute_configured_keys_to_chat_users() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    let key = "model-reflection-secret-1ae3";
    let speech_key = "speech-reflection-secret-7ef2";
    let admin = common::create_test_admin(&pool, "ai-reflection-admin").await;
    let user = common::create_test_user(&pool, "ai-reflection-user").await;
    let app = app(&pool);
    let (status, settings) = request(
        &app,
        &admin,
        "PUT",
        "/admin/ai-settings",
        json!({"revision":null,"enabled":true,"provider":"openai","baseUrl":mock.base_url(&route),"model":"mock-model","apiKey":key,"speechApiKey":speech_key}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    for output in [
        json!({"message":format!("認証キー：{key}"),"action":null}),
        json!({"message":"検索します。","action":{"type":"filter","expression":{"op":"text","query1":key}}}),
        json!({"message":speech_key,"action":null}),
    ] {
        mock.set_output(&route, output);
        let (status, response) = request(
            &app,
            &user,
            "POST",
            "/ai/chat",
            json!({"message":"検索を手伝って","history":[],"context":{"layer_ids":null}}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{response}");
        assert!(response["error"].as_str().unwrap().contains("応答を破棄"));
        assert!(!response.to_string().contains(key));
        assert!(!response.to_string().contains(speech_key));
        assert!(response.get("action").is_none());
    }
    assert_eq!(mock.requests(&route).len(), 3);
}

#[tokio::test]
async fn protocol_two_preserves_applied_definitions_through_confirmed_save_and_reapplication() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    let admin = common::create_test_admin(&pool, "ai-v2-admin").await;
    let user = common::create_test_user(&pool, "ai-v2-user").await;
    insert_marker(&pool, &user, "学校", "OBJECT-PRIVATE-NOT-FOR-PROMPT").await;
    insert_marker(&pool, &user, "病院", "ANOTHER-PRIVATE-OBJECT").await;
    let app = app(&pool);
    let (status, settings) = request(&app,&admin,"PUT","/admin/ai-settings",
        json!({"revision":null,"enabled":true,"writeEnabled":true,"provider":"openai",
            "baseUrl":mock.base_url(&route),"model":"mock-model","apiKey":"v2-only-mock-credential"})).await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    let definition = json!({"type":"filter","expression":{"op":"or","children":[
        {"op":"text","query1":"学校"},{"op":"text","query1":"避難所"}]}});
    mock.set_output(
        &route,
        json!({"outcome":"action","message":"学校または避難所で絞ります。","action":definition}),
    );
    let (status, chat) = request(
        &app,
        &user,
        "POST",
        "/ai/chat",
        json!({
        "protocol_version":2,"message":"防災に関係するデータを集めて","history":[],
        "context":{"layer_ids":null},"state":{"filter":null,"color":null}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    let calls = mock.requests(&route);
    assert!(
        !calls[0]
            .body
            .to_string()
            .contains("OBJECT-PRIVATE-NOT-FOR-PROMPT")
    );
    let execute = |action: Value| {
        json!({"protocol_version":2,"revision":settings["revision"],
        "context":{"layer_ids":null},"action":action})
    };
    let (status, result) = request(
        &app,
        &user,
        "POST",
        "/ai/assist/execute",
        execute(chat["action"].clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["target_count"], 1);
    let applied = result["definition"].clone();

    let operation = Uuid::new_v4();
    let (status, prepared) = request(&app,&user,"POST","/ai/operations/prepare",json!({
        "operation_id":operation,"protocol_version":2,"revision":settings["revision"],
        "context":{"layer_ids":null},"action":{"type":"save_preset","name":"防災関連","kind":"filter"},
        "state":{"filter":applied,"color":null}})).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["status"], "prepared");
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM answer_map_saved_condition_model WHERE user_id=$1",
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, 0, "準備時点では保存条件を作成しない");
    let commit = json!({"operation_id":operation,"protocol_version":2,"revision":settings["revision"],"context":{"layer_ids":null}});
    let (status, completed) =
        request(&app, &user, "POST", "/ai/operations/commit", commit.clone()).await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], "completed");
    let (_, repeated) = request(&app, &user, "POST", "/ai/operations/commit", commit).await;
    assert_eq!(repeated, completed);

    let (status, listed) = request(
        &app,
        &user,
        "POST",
        "/ai/assist/execute",
        execute(json!({"type":"list_presets","kind":"filter"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["schema_version"], 2);
    assert_eq!(listed["items"][0]["definition"], applied);
    let (_, legacy) = request(&app, &user, "GET", "/form-answers/map-presets", Value::Null).await;
    assert_eq!(
        legacy["total"], 0,
        "旧クライアントへバージョン2の定義を返さない"
    );
    let id = completed["result"]["id"].clone();
    insert_marker(&pool, &user, "避難所", "NEW-DATA-MUST-STAY-LOCAL").await;
    let (status, restored) = request(
        &app,
        &user,
        "POST",
        "/ai/assist/execute",
        execute(json!({"type":"apply_preset","preset_id":id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        restored["target_count"], 2,
        "保存した定義は現在のデータを再検索する"
    );
    assert_eq!(restored["definition"], applied);
}

#[tokio::test]
async fn denial_and_old_protocol_never_execute_persistent_commands() {
    let pool = common::test_pool().await;
    let mock = mock_server();
    let route = Uuid::new_v4().simple().to_string();
    let admin = common::create_test_admin(&pool, "ai-protocol-admin").await;
    let user = common::create_test_user(&pool, "ai-protocol-user").await;
    let app = app(&pool);
    let (status, settings) = request(
        &app,
        &admin,
        "PUT",
        "/admin/ai-settings",
        json!({
        "revision":null,"enabled":true,"writeEnabled":true,"baseUrl":mock.base_url(&route),
        "model":"mock-model","apiKey":"protocol-only-mock-credential"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    mock.set_output(&route,json!({"outcome":"action","message":"作成を提案します。","action":{"type":"create_layer","name":"新レイヤ"}}));
    let (status, error) = request(
        &app,
        &user,
        "POST",
        "/ai/chat",
        json!({"message":"新レイヤを作成して","context":{"layer_ids":null}}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(
        error,
        json!({"code":"ai_operation_not_allowed","error":"要求された操作は許可されていません。"})
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM layer_model WHERE user_id=$1 AND NOT is_master")
            .bind(&user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);

    mock.set_output(
        &route,
        json!({"outcome":"denied","message":"自由な拒否文は表示しない",
        "action":{"type":"create_layer","name":"勝手に作成"}}),
    );
    let (status, denied) = request(
        &app,
        &user,
        "POST",
        "/ai/chat",
        json!({
        "protocol_version":2,"message":"データを削除して","context":{"layer_ids":null}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{denied}");
    assert_eq!(denied["message"], "要求された操作は許可されていません。");
    assert!(denied["action"].is_null());
    for (path, action, protocol) in [
        ("/ai/execute", json!({"type":"delete"}), None),
        ("/ai/assist/execute", json!({"type":"delete"}), Some(2)),
        (
            "/ai/assist/execute",
            json!({"type":"create_layer","name":"迂回"}),
            Some(2),
        ),
    ] {
        let mut body =
            json!({"revision":settings["revision"],"context":{"layer_ids":null},"action":action});
        if let Some(protocol) = protocol {
            body["protocol_version"] = json!(protocol);
        }
        let (status, error) = request(&app, &user, "POST", path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {error}");
        assert_eq!(error["error"], "要求された操作は許可されていません。");
        assert_eq!(error["code"], "ai_operation_not_allowed");
    }
}
