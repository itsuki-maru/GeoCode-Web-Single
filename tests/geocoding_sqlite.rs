mod common;

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::{get, post},
};
use geocode_web_single::{
    auth::create_token,
    handler::geocoding::{GeocoderClient, search_handler},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

#[tokio::test]
async fn address_search_uses_sqlite_login_and_rejects_revoked_sessions() {
    common::init_test_env();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let upstream = Router::new().route("/search", get(move || {
        observed.fetch_add(1, Ordering::SeqCst);
        async { "<results><geodetic>wgs1984</geodetic><candidate><address>東京都/新宿区</address><latitude>35.69</latitude><longitude>139.70</longitude></candidate></results>" }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    unsafe {
        std::env::set_var("GEOCODER_PROVIDER", "csis");
        std::env::set_var(
            "GEOCODER_URL",
            format!("http://{}/search", listener.local_addr().unwrap()),
        );
        std::env::remove_var("GEOCODER_API_KEY");
    }
    let server = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "geocoder-user").await;
    let version: i64 = sqlx::query_scalar("SELECT auth_version FROM user_model WHERE id = ?")
        .bind(&user)
        .fetch_one(&pool)
        .await
        .unwrap();
    let token = create_token(&user, 5, "access_token", version).unwrap();
    let app = Router::new()
        .route("/geocode", post(search_handler))
        .layer(Extension(pool.clone()))
        .layer(Extension(GeocoderClient::default()));
    let request = |cookie: Option<&str>| {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/geocode")
            .header("content-type", "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", format!("access_token={cookie}"));
        }
        builder
            .body(Body::from(r#"{"address":"東京都新宿区"}"#))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(request(None)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = app.clone().oneshot(request(Some(&token))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["results"][0]["address"], "東京都/新宿区");
    assert_eq!(body["results"][0]["latitude"], 35.69);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    sqlx::query("UPDATE user_model SET auth_version = auth_version + 1 WHERE id = ?")
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        app.oneshot(request(Some(&token))).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}
