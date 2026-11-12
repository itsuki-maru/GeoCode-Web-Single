//! 共通フロントのHTMLをバックエンドでローカルmanifestへ向け、同梱資材だけで配信する。
#[allow(dead_code)]
mod common;
use axum::{
    Json,
    body::to_bytes,
    extract::{Extension, Path, Query},
    http::{HeaderMap, header},
    response::IntoResponse,
};
use geocode_web_single::{
    build_tera_extension,
    handler::{
        assets::serve_static_file,
        onetime_url::{generate_url_handler, temporary_map_get_handler},
    },
    index_handler,
    model::GenarateUrlPayload,
};

fn headers(mobile: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        if mobile { "Mobile" } else { "Desktop" }.parse().unwrap(),
    );
    headers
}
fn assert_manifest(html: &str, mobile: bool) {
    let file = if mobile {
        "/assets/manifest.json"
    } else {
        "/assets/manifest-tab.json"
    };
    assert!(
        html.contains(file),
        "同梱manifestの参照がありません: {file}"
    );
    assert!(!html.contains("href=\"https://geocode-web-mobile-app.pages.dev/assets/manifest"));
}

#[tokio::test]
async fn 共通_pc_mobileエントリと共有テンプレートの_manifestをローカル化する() {
    let pool = common::test_pool().await;
    let user = common::create_test_user(&pool, "local-manifest-user").await;
    let layer = common::master_layer_id(&pool, &user).await;
    let Json(created) = generate_url_handler(
        Extension(user),
        Extension(pool.clone()),
        None,
        Json(GenarateUrlPayload {
            minutes: 60,
            layers: vec![layer],
            update_url: false,
            share_password: None,
            include_shapes: true,
            include_tile_overlays: false,
            snapshot: None,
        }),
    )
    .await
    .unwrap();
    let tera = build_tera_extension().unwrap();
    let id = created.id;
    for mobile in [false, true] {
        assert_manifest(&index_handler(headers(mobile)).await.unwrap().0, mobile);
        let response = temporary_map_get_handler(
            headers(mobile),
            Extension(pool.clone()),
            Extension(tera.clone()),
            Query(serde_json::from_value(serde_json::json!({})).unwrap()),
            Ok(Path(id.clone())),
        )
        .await
        .unwrap()
        .into_response();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        assert_manifest(std::str::from_utf8(&bytes).unwrap(), mobile);
    }
    pool.close().await;
}

#[tokio::test]
async fn manifestとアイコンを同梱_http資材だけで取得できる() {
    for file in ["manifest-tab.json", "manifest.json"] {
        let response = serve_static_file(Path(file.to_string())).await.unwrap();
        assert_eq!(response.headers()["content-type"], "application/json");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(manifest["start_url"], "/");
        for icon in manifest["icons"].as_array().unwrap() {
            let path = icon["src"]
                .as_str()
                .unwrap()
                .strip_prefix("/assets/")
                .unwrap();
            let response = serve_static_file(Path(path.to_owned())).await.unwrap();
            assert_eq!(response.headers()["content-type"], "image/png");
        }
    }
}
