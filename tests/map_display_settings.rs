#[allow(dead_code)]
mod common;

use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use geocode_web_single::{auth::create_token, build_tera_extension, router::build_router};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn response_json(response: Response) -> Value {
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn 管理者のみがクラスタ解除の最小ズームを保存でき地図は最新値を使う() {
    let pool = common::test_pool().await;
    let admin = common::create_test_admin(&pool, "map-settings-admin").await;
    let user = common::create_test_user(&pool, "map-settings-user").await;
    let admin_token = create_token(&admin, 30, "access_token", 0).unwrap();
    let user_token = create_token(&user, 30, "access_token", 0).unwrap();
    let tera = build_tera_extension().unwrap();
    tera.lock()
        .await
        .add_raw_templates([
            ("map.html", include_str!("../src/templates/map.html")),
            (
                "map-mobile.html",
                include_str!("../src/templates/map-mobile.html"),
            ),
            (
                "map-anather.html",
                include_str!("../src/templates/map-anather.html"),
            ),
        ])
        .unwrap();
    let app = build_router(pool.clone(), tera, None);
    let url = "/admin/map-display-settings";
    let read = |token: &str| {
        let mut request = Request::builder().uri(url);
        if !token.is_empty() {
            request = request.header(header::COOKIE, format!("access_token={token}"));
        }
        app.clone().oneshot(request.body(Body::empty()).unwrap())
    };
    let save = |token: &str, zoom| {
        app.clone().oneshot(
            Request::builder()
                .method(Method::PUT)
                .uri(url)
                .header(header::COOKIE, format!("access_token={token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "clusteringMinZoom": zoom }).to_string()))
                .unwrap(),
        )
    };

    assert_eq!(read("").await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        read(&user_token).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        save(&user_token, 10).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    for invalid_zoom in [-1, 23] {
        assert_eq!(
            save(&admin_token, invalid_zoom).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }

    for zoom in [15, 0, 22, 12] {
        let expected = json!({ "clusteringMinZoom": zoom });
        if zoom != 15 {
            let response = save(&admin_token, zoom).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response_json(response).await, expected);
        }
        let response = read(&admin_token).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await, expected);

        for (path, agent) in [
            ("/map", "Desktop"),
            ("/map", "Fixture Mobile"),
            ("/map-another", "Desktop"),
        ] {
            let page = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::COOKIE, format!("access_token={user_token}"))
                        .header(header::USER_AGENT, agent)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(page.status(), StatusCode::OK);
            assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
            let body = to_bytes(page.into_body(), 2_000_000).await.unwrap();
            assert!(
                std::str::from_utf8(&body)
                    .unwrap()
                    .contains(&format!("clusteringMinZoom: {zoom},"))
            );
        }
    }

    // 保存値が不正でも、従来の既定値で地図を利用できる。
    sqlx::query(
        "UPDATE application_settings SET setting_value = 'invalid' WHERE setting_key = 'clustering_min_zoom'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let response = read(&admin_token).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({ "clusteringMinZoom": 15 })
    );
}
