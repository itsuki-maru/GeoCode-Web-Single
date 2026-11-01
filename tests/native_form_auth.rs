#[allow(dead_code)]
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use sqlx::SqlitePool;
use tower::ServiceExt;

#[tokio::test]
async fn expired_access_cookie_can_be_refreshed_and_the_original_native_posts_succeed() {
    let pool = common::test_pool().await;
    use geocode_web_single::auth::create_token;
    let user = test_user(&pool, "native-retry").await;
    let layer = test_master(&pool, &user).await;
    let marker = uuid::Uuid::new_v4();
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
        ) VALUES (
            $1,
            $2,
            $3,
            'retry-target',
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(marker.to_string())
    .bind(user.to_string())
    .bind(layer.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            create_at,
            submitted_values,
            rendered_markdown
        ) VALUES ($1, $2, CURRENT_TIMESTAMP, '{}', '')
        "#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(marker.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let app = geocode_web_single::router::build_router(
        pool,
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let expired = create_token(&user.to_string(), -5, "access_token", 0).unwrap();
    let refresh = create_token(&user.to_string(), 30, "refresh_token", 0).unwrap();
    let body = "query=%7B%7D&parent_origin=http%3A%2F%2Flocalhost%3A5173&request_id=map-test";
    for path in [
        "/form-answers/map",
        "/form-answers/download",
        "/form-answers/map-print",
        "/form-answers/map-csv-download",
    ] {
        let uri = format!(
            "{path}?native_request_id=retry-test&native_parent_origin=http%3A%2F%2Flocalhost%3A5173"
        );
        let csv_query = serde_json::json!({"query":{"as_of":chrono::Utc::now()},"targets":[format!("marker:{marker}")],"conditions":[]});
        let mut encoded = reqwest::Url::parse("http://localhost/").unwrap();
        encoded
            .query_pairs_mut()
            .append_pair("query", &csv_query.to_string());
        let body = if path.ends_with("map-csv-download") {
            encoded.query().unwrap()
        } else {
            body
        };
        let post = |cookie: &str| {
            Request::builder()
                .method("POST")
                .uri(&uri)
                .header("cookie", cookie)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from(body.to_owned()))
                .unwrap()
        };
        let denied = app
            .clone()
            .oneshot(post(&format!("access_token={expired}")))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let denied_body =
            String::from_utf8(to_bytes(denied.into_body(), 8192).await.unwrap().to_vec()).unwrap();
        assert!(denied_body.contains("native-form-auth-error"));
        let check = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/account/auth")
                    .header("cookie", format!("access_token={expired}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(check.status(), StatusCode::UNAUTHORIZED);
        let updated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/account/refresh")
                    .header("cookie", format!("refresh_token={refresh}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let cookie = updated
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap())
            .find(|v| v.starts_with("access_token="))
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let check = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/account/auth")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(check.status(), StatusCode::OK);
        let result = app.clone().oneshot(post(cookie)).await.unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        if path.ends_with("download") {
            assert!(result.headers().contains_key("content-disposition"));
            let csv =
                String::from_utf8(to_bytes(result.into_body(), 100000).await.unwrap().to_vec())
                    .unwrap();
            assert!(csv.starts_with('\u{feff}'));
            assert!(csv.contains("retry-target"));
        } else if path.ends_with("map-print") {
            assert_eq!(result.headers()["cache-control"], "no-store");
            let html =
                String::from_utf8(to_bytes(result.into_body(), 100000).await.unwrap().to_vec())
                    .unwrap();
            assert!(html.contains("template-form-answer-map-print.js"));
            assert!(!html.contains("retry-target"));
        } else {
            let html =
                String::from_utf8(to_bytes(result.into_body(), 100000).await.unwrap().to_vec())
                    .unwrap();
            assert!(html.contains("form-answer-map"));
            assert!(html.contains("retry-target"));
        }
    }
}

#[tokio::test]
async fn successful_streams_and_other_errors_are_unchanged() {
    use axum::{Router, response::IntoResponse, routing::post};
    use futures_util::stream;
    let app = Router::new()
        .route(
            "/csv",
            post(|| async {
                (
                    [
                        ("content-type", "text/csv"),
                        ("content-disposition", "attachment; filename=answers.csv"),
                    ],
                    Body::from_stream(stream::iter([
                        Ok::<_, std::io::Error>("\u{feff}name\r\n"),
                        Ok("sample\r\n"),
                    ])),
                )
                    .into_response()
            }),
        )
        .route(
            "/denied",
            post(|| async { (StatusCode::FORBIDDEN, "denied") }),
        )
        .layer(axum::middleware::from_fn(
            geocode_web_single::middleware::native_form_auth::notify_auth_error,
        ));
    let query = "?native_request_id=abc&native_parent_origin=http%3A%2F%2Flocalhost";
    let csv = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/csv{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(csv.status(), StatusCode::OK);
    assert_eq!(
        csv.headers()["content-disposition"],
        "attachment; filename=answers.csv"
    );
    assert_eq!(
        to_bytes(csv.into_body(), 4096).await.unwrap(),
        "\u{feff}name\r\nsample\r\n"
    );
    let denied = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/denied{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(to_bytes(denied.into_body(), 4096).await.unwrap(), "denied");
}

#[tokio::test]
async fn native_auth_notification_is_opt_in_and_does_not_bypass_authentication() {
    let pool = common::test_pool().await;
    common::init_test_env();
    let app = geocode_web_single::router::build_router(
        pool,
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    for route in [
        "/form-answers/map",
        "/form-answers/download",
        "/form-answers/map-print",
        "/form-answers/map-csv-download",
    ] {
        for query in [
            "",
            "?native_request_id=abc",
            "?native_request_id=%3Cscript%3E&native_parent_origin=http%3A%2F%2Flocalhost",
        ] {
            let r = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("{route}{query}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(r.headers()["content-type"], "application/json");
            assert_eq!(
                to_bytes(r.into_body(), 4096).await.unwrap(),
                r#"{"error":"token_expired"}"#
            );
        }
        let r = app.clone().oneshot(Request::builder().method("POST")
            .uri(format!("{route}?native_request_id=abc-123&native_parent_origin=http%3A%2F%2Flocalhost%3A5173"))
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert!(
            r.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        let body =
            String::from_utf8(to_bytes(r.into_body(), 8192).await.unwrap().to_vec()).unwrap();
        assert!(body.contains("native-form-auth-error"));
        assert!(body.contains("abc-123"));
        assert!(body.contains("http://localhost:5173"));
    }
}

async fn test_user(pool: &SqlitePool, name: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap()
}
async fn test_master(pool: &SqlitePool, user: &uuid::Uuid) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::master_layer_id(pool, &user.to_string()).await).unwrap()
}
