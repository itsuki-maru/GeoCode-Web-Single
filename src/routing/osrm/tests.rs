use super::*;
use crate::routing::Coordinate;
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, Uri},
    response::{Redirect, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::{convert::Infallible, time::Duration};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use uuid::Uuid;

async fn test_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    pool
}

fn input(travel_mode: TravelMode) -> ComputeInput {
    ComputeInput {
        background_id: 1,
        origin: Coordinate {
            lat: 35.6812347,
            lng: 139.7671251,
        },
        destination: Coordinate {
            lat: 35.684,
            lng: 139.769,
        },
        travel_mode,
    }
}

fn route() -> Value {
    json!({"code": "Ok", "routes": [{"distance": 652.5, "duration": 72.3, "geometry": "??AA"}]})
}

async fn serve(mock: Router) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    (url, task)
}

#[tokio::test]
async fn route_requests_use_each_mode_endpoint_and_longitude_first() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mock = |path| {
        Router::new()
            .route(
                path,
                get(
                    |State(calls): State<Arc<Mutex<Vec<Uri>>>>, uri: Uri| async move {
                        calls.lock().await.push(uri);
                        Json(route())
                    },
                ),
            )
            .with_state(calls.clone())
    };
    let (drive_url, drive_server) = serve(mock("/route/v1/driving/{coords}")).await;
    let (walk_url, walk_server) = serve(mock("/routed-foot/route/v1/foot/{coords}")).await;
    let service = Osrm::new(
        UpstreamPolicy::new(Some(&format!("{drive_url},{walk_url}"))),
        None,
    );
    for (mode, url) in [
        (TravelMode::Drive, drive_url),
        (TravelMode::Walk, format!("{walk_url}/routed-foot/")),
    ] {
        let request = input(mode);
        let endpoint = service.upstream.validate_base_url(&url).unwrap();
        let found = service
            .fetch_route(&endpoint, mode, &request.origin, &request.destination, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(found).unwrap(),
            json!({"distanceMeters": 653, "durationSeconds": 72.3, "encodedPolyline": "??AA", "warnings": []})
        );
    }
    let calls = calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].path(),
        "/route/v1/driving/139.767125,35.681235;139.769000,35.684000"
    );
    assert_eq!(
        calls[1].path(),
        "/routed-foot/route/v1/foot/139.767125,35.681235;139.769000,35.684000"
    );
    for call in calls.iter() {
        assert_eq!(call.query(), Some(ROUTE_QUERY));
    }
    drive_server.abort();
    walk_server.abort();
}

#[tokio::test]
async fn upstream_responses_distinguish_no_route_and_failures() {
    let mock = Router::new().route(
        "/{case}/route/v1/driving/{coords}",
        get(|uri: Uri| async move {
            let case = uri.path().split('/').nth(1).unwrap();
            match case {
                "no-route" => {
                    (StatusCode::BAD_REQUEST, Json(json!({"code":"NoRoute"}))).into_response()
                },
                "no-segment" => {
                    (StatusCode::BAD_REQUEST, Json(json!({"code":"NoSegment"}))).into_response()
                },
                "wrong-status" => Json(json!({"code":"NoRoute"})).into_response(),
                "error" => (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"code":"InvalidQuery"})),
                )
                    .into_response(),
                "rate" => StatusCode::TOO_MANY_REQUESTS.into_response(),
                "gateway" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                "invalid-json" => "invalid JSON".into_response(),
                "bad-distance" => Json(
                    json!({"code":"Ok","routes":[{"distance":-1,"duration":10,"geometry":"??AA"}]}),
                )
                .into_response(),
                "bad-geometry" => Json(
                    json!({"code":"Ok","routes":[{"distance":10,"duration":10,"geometry":"<>"}]}),
                )
                .into_response(),
                "missing-route" => Json(json!({"code":"Ok"})).into_response(),
                "oversize" => "x".repeat(MAX_RESPONSE_BYTES + 1).into_response(),
                "oversize-stream" => {
                    let chunks = (0..3).map(|_| {
                        Ok::<_, Infallible>(Bytes::from(vec![b' '; MAX_RESPONSE_BYTES / 2]))
                    });
                    Response::new(Body::from_stream(futures_util::stream::iter(chunks)))
                },
                "redirect" => Redirect::temporary("/ok/route/v1/driving/coords").into_response(),
                "ok" => Json(route()).into_response(),
                _ => unreachable!(),
            }
        }),
    );
    let (url, server) = serve(mock).await;
    let service = Osrm::new(UpstreamPolicy::new(Some(&url)), None);
    let input = input(TravelMode::Drive);
    for (case, expected) in [
        ("no-route", StatusCode::OK),
        ("no-segment", StatusCode::OK),
        ("rate", StatusCode::TOO_MANY_REQUESTS),
        ("wrong-status", StatusCode::BAD_GATEWAY),
        ("error", StatusCode::BAD_GATEWAY),
        ("gateway", StatusCode::BAD_GATEWAY),
        ("invalid-json", StatusCode::BAD_GATEWAY),
        ("bad-distance", StatusCode::BAD_GATEWAY),
        ("bad-geometry", StatusCode::BAD_GATEWAY),
        ("missing-route", StatusCode::BAD_GATEWAY),
        ("oversize", StatusCode::BAD_GATEWAY),
        ("oversize-stream", StatusCode::BAD_GATEWAY),
        ("redirect", StatusCode::BAD_GATEWAY),
    ] {
        let endpoint = Url::parse(&format!("{url}/{case}")).unwrap();
        match service
            .fetch_route(
                &endpoint,
                input.travel_mode,
                &input.origin,
                &input.destination,
                None,
            )
            .await
        {
            Ok(route) => {
                assert_eq!(expected, StatusCode::OK, "{case}");
                assert!(route.is_none(), "{case}");
            },
            Err(error) => assert_eq!(
                error.into_route_error().into_response().status(),
                expected,
                "{case}"
            ),
        }
    }
    server.abort();
}

#[tokio::test]
async fn upstream_timeout_is_reported_as_a_gateway_failure() {
    let (url, server) = serve(Router::new().route(
        "/route/v1/driving/{coords}",
        get(std::future::pending::<StatusCode>),
    ))
    .await;
    let service = Osrm::new(
        UpstreamPolicy::with_timeout(Some(&url), Duration::from_millis(50)),
        None,
    );
    let endpoint = service.upstream.validate_base_url(&url).unwrap();
    let request = input(TravelMode::Drive);
    let result = service
        .fetch_route(
            &endpoint,
            TravelMode::Drive,
            &request.origin,
            &request.destination,
            None,
        )
        .await;
    assert!(matches!(
        result,
        Err(RouteFetchError::Request(AppError::BadGateway))
    ));
    server.abort();
}

// 認証後の計算処理で、対象外の背景や移動手段が上流へ送られないことを確認する。
#[tokio::test]
async fn compute_checks_input_background_and_modes_before_calling_osrm() {
    let pool = test_pool().await;
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
            id, layer_name, label, url, attribution, create_at, updated_at,
            provider, google_map_type, kind, style_url, enabled
        ) VALUES
            (1, 'osm', 'OSM', '/tile/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'generic', NULL, 'raster', NULL, true),
            (2, 'google', 'Google', '/google-maps/tiles/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'google', 'roadmap', 'raster', NULL, true),
            (3, 'disabled', 'Disabled', '/tile/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'generic', NULL, 'raster', NULL, false),
            (4, 'vector', 'Vector', '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'generic', NULL, 'vector', '/style.json', true)
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let calls = Arc::new(Mutex::new(0));
    let (url, server) = serve(
        Router::new()
            .route(
                "/route/v1/driving/{coords}",
                get(|State(calls): State<Arc<Mutex<u32>>>| async move {
                    *calls.lock().await += 1;
                    Json(route())
                }),
            )
            .with_state(calls.clone()),
    )
    .await;
    let service = Arc::new(Osrm::new(UpstreamPolicy::new(Some(&url)), None));
    let account = Uuid::new_v4().to_string();
    let compute = |input| {
        compute_osrm(
            Extension(account.clone()),
            Extension(pool.clone()),
            Extension(service.clone()),
            Json(input),
        )
    };
    assert!(service.available_modes(&pool).await.unwrap().is_empty());
    assert!(matches!(
        compute(input(TravelMode::Drive)).await,
        Err(AppError::Forbidden(_))
    ));
    sqlx::query("UPDATE osrm_settings SET revision = $1, drive_base_url = $2 WHERE id = 1")
        .bind(Uuid::new_v4().to_string())
        .bind(Url::parse(&url).unwrap().as_str())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        service.available_modes(&pool).await.unwrap(),
        [TravelMode::Drive]
    );
    for background_id in [2, 3, 5] {
        let mut request = input(TravelMode::Drive);
        request.background_id = background_id;
        assert!(matches!(
            compute(request).await,
            Err(AppError::Forbidden(_))
        ));
    }
    assert!(matches!(
        compute(input(TravelMode::Walk)).await,
        Err(AppError::Forbidden(_))
    ));
    let mut invalid = input(TravelMode::Drive);
    invalid.destination.lat = 91.0;
    assert!(matches!(compute(invalid).await, Err(AppError::BadRequest)));
    assert_eq!(*calls.lock().await, 0);

    for background_id in [1, 4] {
        let mut request = input(TravelMode::Drive);
        request.background_id = background_id;
        let response = compute(request).await.unwrap().into_response();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), MAX_RESPONSE_BYTES)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["route"]["encodedPolyline"], "??AA");
    }
    assert_eq!(*calls.lock().await, 2);
    server.abort();
}

async fn settings_body(response: impl IntoResponse) -> Value {
    let response = response.into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn mode_key(
    pool: &SqlitePool,
    mode: TravelMode,
    process: &Osrm,
) -> Result<Option<HeaderValue>, AppError> {
    Ok(settings::load_endpoint(pool, process, mode)
        .await?
        .and_then(|(_, key)| key))
}

// WALの複数接続で、同じ版に対する同時更新の一方だけが成功することも確認する。
#[tokio::test]
async fn managed_keys_are_scoped_to_modes_and_changes_take_effect_without_restart() {
    let directory = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(directory.path().join("osrm.sqlite"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await
        .unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    let admin = crate::db::create_user_with_master_layer(&pool, "osrm-admin", "test-hash", true)
        .await
        .unwrap()
        .id;
    let origin = Some("http://osrm:5000,http://osrm-walk:5000");
    let drive_url = "http://osrm:5000/routed-car";
    let walk_url = "http://osrm-walk:5000/routed-foot";
    let changed_url = "http://osrm:5000/routed-car-changed";
    let encryption_key = STANDARD.encode([7; 32]);
    let service = Arc::new(Osrm::new(
        UpstreamPolicy::new(origin),
        Some(&encryption_key),
    ));
    let second_process = Osrm::new(UpstreamPolicy::new(origin), Some(&encryption_key));
    let get = |service: Arc<Osrm>| {
        osrm_admin_get(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Extension(service),
        )
    };
    let update = |service: Arc<Osrm>, body: Value| {
        osrm_admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Extension(service),
            Ok(Json(serde_json::from_value(body).unwrap())),
        )
    };
    let initial = settings_body(get(service.clone()).await.unwrap()).await;
    assert_eq!(
        initial,
        json!({
            "revision": null,
            "keyStorageConfigured": true,
            "drive": {"baseUrl": null, "hasApiKey": false, "keyUsable": false},
            "walk": {"baseUrl": null, "hasApiKey": false, "keyUsable": false}
        })
    );
    assert!(matches!(
        update(
            service.clone(),
            json!({"revision": null, "walk":{"baseUrl": walk_url}})
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(update(service.clone(), json!({"revision": null, "drive":{"baseUrl": drive_url}, "walk":{"baseUrl": format!("{drive_url}/")}})).await, Err(AppError::Validation(_))));
    assert!(matches!(
        update(
            service.clone(),
            json!({"revision": null, "drive":{"baseUrl": "http://unlisted:5000"}})
        )
        .await,
        Err(AppError::Validation(_))
    ));

    let drive_key = "osrm-admin-drive-fixture";
    let walk_key = "osrm-admin-walk-fixture";
    let saved = settings_body(
        update(
            service.clone(),
            json!({
                "revision": null,
                "drive": {"baseUrl": drive_url, "key": {"action": "set", "apiKey": drive_key}},
                "walk": {"baseUrl": walk_url, "key": {"action": "set", "apiKey": walk_key}}
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(saved["drive"]["keyUsable"], true);
    assert_eq!(saved["walk"]["keyUsable"], true);
    assert_eq!(saved["drive"]["baseUrl"], drive_url);
    assert_eq!(saved["walk"]["baseUrl"], walk_url);
    assert_eq!(
        second_process.available_modes(&pool).await.unwrap(),
        [TravelMode::Drive, TravelMode::Walk]
    );
    let walk_only_allowed = Osrm::new(
        UpstreamPolicy::new(Some("http://osrm-walk:5000")),
        Some(&encryption_key),
    );
    assert!(
        walk_only_allowed
            .available_modes(&pool)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        settings::load_endpoint(&pool, &walk_only_allowed, TravelMode::Walk).await,
        Err(AppError::BadGateway)
    ));
    assert!(!saved.to_string().contains(drive_key));
    assert!(!saved.to_string().contains(walk_key));
    let (encrypted_drive, encrypted_walk): (Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT encrypted_drive_key, encrypted_walk_key FROM osrm_settings WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !encrypted_drive
            .windows(drive_key.len())
            .any(|part| part == drive_key.as_bytes())
    );
    assert!(
        !encrypted_walk
            .windows(walk_key.len())
            .any(|part| part == walk_key.as_bytes())
    );
    // URL列を追加する以前の設定行を再現する。
    sqlx::query(
        "UPDATE osrm_settings SET drive_base_url = NULL, walk_base_url = NULL WHERE id = 1",
    )
    .execute(&pool)
    .await
    .unwrap();
    let legacy = settings_body(get(service.clone()).await.unwrap()).await;
    assert_eq!(
        legacy["drive"],
        json!({"baseUrl": null, "hasApiKey": true, "keyUsable": false})
    );
    assert!(
        second_process
            .available_modes(&pool)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        update(
            service.clone(),
            json!({
                "revision": legacy["revision"], "drive": {"baseUrl": changed_url}
            })
        )
        .await,
        Err(AppError::Validation(_))
    ));
    let saved = settings_body(
        update(
            service.clone(),
            json!({
                "revision": legacy["revision"], "drive": {"baseUrl": format!("{drive_url}/")},
                "walk": {"baseUrl": walk_url}
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(saved["drive"]["baseUrl"], drive_url);
    assert_eq!(saved["drive"]["keyUsable"], true);
    let retained: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_drive_key FROM osrm_settings WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained, encrypted_drive);
    assert_eq!(
        mode_key(&pool, TravelMode::Drive, &second_process)
            .await
            .unwrap()
            .unwrap(),
        drive_key
    );
    assert_eq!(
        mode_key(&pool, TravelMode::Walk, &second_process)
            .await
            .unwrap()
            .unwrap(),
        walk_key
    );

    let rotated = "osrm-admin-drive-rotated";
    let (won, competing) = tokio::join!(
        update(
            service.clone(),
            json!({"revision": saved["revision"], "drive": {"baseUrl": drive_url, "key": {"action": "set", "apiKey": rotated}}})
        ),
        update(
            service.clone(),
            json!({"revision": saved["revision"], "drive": {"baseUrl": drive_url, "key": {"action": "set", "apiKey": rotated}}})
        ),
    );
    let latest = match (won, competing) {
        (Ok(response), Err(AppError::Conflict)) | (Err(AppError::Conflict), Ok(response)) => {
            settings_body(response).await
        },
        _ => panic!("同時更新は片方だけ成功する"),
    };
    assert_eq!(
        mode_key(&pool, TravelMode::Drive, &second_process)
            .await
            .unwrap()
            .unwrap(),
        rotated
    );
    assert_eq!(
        mode_key(&pool, TravelMode::Walk, &second_process)
            .await
            .unwrap()
            .unwrap(),
        walk_key
    );

    assert!(matches!(
        update(
            service.clone(),
            json!({"revision": latest["revision"], "drive": {"baseUrl": changed_url}})
        )
        .await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        update(
            service.clone(),
            json!({"revision": latest["revision"], "drive": {"baseUrl": null}})
        )
        .await,
        Err(AppError::Validation(_))
    ));

    let no_cipher = Arc::new(Osrm::new(UpstreamPolicy::new(origin), None));
    let cleared = settings_body(
        update(
            no_cipher.clone(),
            json!({
                "revision": latest["revision"], "drive": {"baseUrl": changed_url, "key": {"action": "clear"}}
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(cleared["keyStorageConfigured"], false);
    assert_eq!(cleared["drive"]["hasApiKey"], false);
    assert_eq!(cleared["drive"]["baseUrl"], changed_url);
    assert_eq!(cleared["walk"]["hasApiKey"], true);
    assert_eq!(cleared["walk"]["keyUsable"], false);
    let (endpoint, key) = settings::load_endpoint(&pool, &second_process, TravelMode::Drive)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(endpoint.as_str(), changed_url);
    assert!(key.is_none());
    assert!(matches!(
        mode_key(&pool, TravelMode::Walk, &no_cipher).await,
        Err(AppError::BadGateway)
    ));
    let disabled = settings_body(update(no_cipher, json!({"revision": cleared["revision"], "drive": {"baseUrl": null}, "walk": {"baseUrl": null}})).await.unwrap()).await;
    assert_eq!(disabled["walk"]["baseUrl"], Value::Null);
    assert_eq!(disabled["walk"]["hasApiKey"], false);
    assert!(
        second_process
            .available_modes(&pool)
            .await
            .unwrap()
            .is_empty()
    );
    pool.close().await;
}

// 未保存の候補に対する疎通確認で、保存済み設定とキーが変わらないことを確認する。
#[tokio::test]
async fn connection_check_uses_candidate_key_without_changing_saved_settings() {
    let pool = test_pool().await;
    let admin = crate::db::create_user_with_master_layer(&pool, "osrm-admin", "test-hash", true)
        .await
        .unwrap()
        .id;
    let mock = Router::new()
        .route(
            "/route/v1/driving/{coords}",
            get(|headers: HeaderMap| async move {
                match headers
                    .get("X-API-Key")
                    .and_then(|value| value.to_str().ok())
                {
                    Some("saved") => Json(route()).into_response(),
                    Some(_) => (StatusCode::FORBIDDEN, "fixture-upstream-secret").into_response(),
                    None => (StatusCode::UNAUTHORIZED, "fixture-upstream-secret").into_response(),
                }
            }),
        )
        .route(
            "/candidate/route/v1/driving/{coords}",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers["X-API-Key"], "candidate");
                (StatusCode::BAD_REQUEST, Json(json!({"code":"NoSegment"})))
            }),
        );
    let (url, server) = serve(mock).await;
    let encryption_key = STANDARD.encode([7; 32]);
    let service = Arc::new(Osrm::new(
        UpstreamPolicy::new(Some(&url)),
        Some(&encryption_key),
    ));
    let saved = settings_body(
        osrm_admin_update(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Extension(service.clone()),
            Ok(Json(
                serde_json::from_value(json!({
                    "revision": null, "drive": {"baseUrl": url, "key": {"action": "set", "apiKey": "saved"}}
                }))
                .unwrap(),
            )),
        )
        .await
        .unwrap(),
    )
    .await;
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (id, layer_name, label, url, attribution, create_at, updated_at)
        VALUES (1, 'osm', 'OSM', '/tile/{z}/{x}/{y}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    ).execute(&pool).await.unwrap();
    let normal_route = |service: Arc<Osrm>| {
        compute_osrm(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Extension(service),
            Json(input(TravelMode::Drive)),
        )
    };
    assert_eq!(
        settings_body(normal_route(service.clone()).await.unwrap()).await["route"]["encodedPolyline"],
        "??AA"
    );
    let check = |service: Arc<Osrm>, base_url: &str, action: Value| {
        osrm_admin_check(
            Extension(admin.clone()),
            Extension(pool.clone()),
            Extension(service),
            Ok(Json(
                serde_json::from_value(json!({
                    "revision": saved["revision"], "travelMode": "DRIVE", "baseUrl": base_url,
                    "origin": {"lat":35.6812347, "lng":139.7671251},
                    "destination": {"lat":35.684, "lng":139.769},
                    "key": action
                }))
                .unwrap(),
            )),
        )
    };
    let no_cipher = Arc::new(Osrm::new(UpstreamPolicy::new(Some(&url)), None));
    let candidate_url = format!("{url}/candidate");
    assert!(
        matches!(check(service.clone(), &candidate_url, Value::Null).await, Err(AppError::Validation(message)) if message.contains("APIキーを入力し直すか削除"))
    );
    assert!(matches!(
        check(service.clone(), "http://unlisted-osrm:5000", Value::Null).await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(
        settings_body(
            check(
                no_cipher.clone(),
                &candidate_url,
                json!({
                    "action": "set", "apiKey": "candidate"
                })
            )
            .await
            .unwrap()
        )
        .await,
        json!({"routeFound": false})
    );
    assert!(matches!(
        check(no_cipher, &url, Value::Null).await,
        Err(AppError::Validation(_))
    ));
    for candidate in [
        json!({"action":"clear"}),
        json!({"action":"set", "apiKey":"invalid"}),
    ] {
        let Err(AppError::Validation(message)) = check(service.clone(), &url, candidate).await
        else {
            panic!("上流の認証エラーは詳細を公開せずに返す");
        };
        assert!(message.contains("OSRMの認証に失敗"));
        assert!(!message.contains("fixture-upstream-secret"));
    }
    assert_eq!(
        settings_body(check(service.clone(), &url, Value::Null).await.unwrap()).await,
        json!({"routeFound": true})
    );
    assert_eq!(
        settings_body(
            osrm_admin_get(
                Extension(admin.clone()),
                Extension(pool.clone()),
                Extension(service.clone())
            )
            .await
            .unwrap()
        )
        .await,
        saved
    );
    osrm_admin_update(
        Extension(admin.clone()),
        Extension(pool.clone()),
        Extension(service.clone()),
        Ok(Json(
            serde_json::from_value(json!({
                "revision": saved["revision"], "drive": {"baseUrl": url, "key": {"action": "clear"}}
            }))
            .unwrap(),
        )),
    )
    .await
    .unwrap();
    assert!(matches!(
        normal_route(service).await,
        Err(AppError::BadGateway)
    ));
    server.abort();
}
