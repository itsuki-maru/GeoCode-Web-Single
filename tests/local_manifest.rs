//! 共通HTMLをローカルmanifestへ向け、地図の依存資材を同梱HTTPから配信する。
#[allow(dead_code)]
mod common;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Extension, Path, Query},
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
    routing::get,
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
use std::collections::{BTreeMap, BTreeSet};
use tower::ServiceExt;

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
async fn localize_manifests_for_shared_desktop_mobile_entries_and_share_templates() {
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
async fn serve_manifests_and_icons_from_bundled_http_assets_only() {
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

fn template_asset_urls(html: &str) -> BTreeSet<String> {
    let mut urls = BTreeSet::new();
    for prefix in ["src=\"/assets/", "href=\"/assets/"] {
        for rest in html.split(prefix).skip(1) {
            let name = rest.split('"').next().unwrap();
            assert!(
                !name.contains("{{") && !name.contains("{%"),
                "asset URL must be resolved by the template: {name}"
            );
            urls.insert(format!("/assets/{name}"));
        }
    }
    urls
}

fn stylesheet_asset_urls(stylesheet: &str, css: &str) -> BTreeSet<String> {
    if stylesheet == "/assets/github.css" {
        // mainと同一の既存CSSに限り、下記の既知の装飾画像参照を除外する。
        assert_eq!(
            css.replace("\r\n", "\n"),
            include_str!("../src_frontend/frontend/public/github.css").replace("\r\n", "\n"),
            "the legacy CSS exceptions require the unchanged bundled source"
        );
    }
    let base = reqwest::Url::parse(&format!("http://embedded.invalid{stylesheet}")).unwrap();
    css.split("url(")
        .skip(1)
        .filter_map(|rest| {
            let raw = rest.split(')').next().unwrap().trim();
            let raw = raw.trim_matches(['\'', '"']);
            if raw.starts_with('#') || raw.starts_with("data:") {
                return None;
            }
            // Release v1.0.0から残る見出しアンカー/水平線の装飾画像。
            // mainにも画像が存在せず、今回のvendor資材コピーの回帰対象ではない。
            if stylesheet == "/assets/github.css"
                && matches!(
                    raw,
                    "../../images/modules/styleguide/para.png"
                        | "../../images/modules/pulls/dirty-shade.png"
                )
            {
                return None;
            }
            let url = base.join(raw).unwrap();
            assert_eq!(
                url.origin(),
                base.origin(),
                "bundled CSS must resolve its assets locally: {stylesheet}: {raw}"
            );
            assert!(
                url.path().starts_with("/assets/"),
                "CSS asset is outside the bundled route: {stylesheet}: {raw}"
            );
            Some(url.path().to_owned())
        })
        .collect()
}

#[tokio::test]
async fn serve_map_template_dependencies_and_css_images_from_bundled_http_assets() {
    let mut pending = BTreeSet::new();
    for html in [
        include_str!("../src/templates/map.html"),
        include_str!("../src/templates/map-mobile.html"),
        include_str!("../src/templates/map-anather.html"),
        include_str!("../src/templates/temporary-map.html"),
        include_str!("../src/templates/temporary-map-mobile.html"),
        include_str!("../src/templates/form-answer-map.html"),
        include_str!("../src/templates/form-answer-map-print.html"),
        include_str!("../src/templates/live-map.html"),
    ] {
        pending.extend(template_asset_urls(html));
        for style in html.split("<style").skip(1) {
            let css = style
                .split_once('>')
                .unwrap()
                .1
                .split("</style>")
                .next()
                .unwrap();
            pending.extend(stylesheet_asset_urls("/assets/template.css", css));
        }
    }
    // 各ページで必要なライブラリの参照を見落とし、空集合で成功しない。
    for required in [
        "leaflet.js",
        "leaflet.css",
        "leaflet.markercluster.js",
        "MarkerCluster.css",
        "MarkerCluster.Default.css",
        "marked.min.js",
        "xss.min.js",
    ] {
        assert!(
            pending.contains(&format!("/assets/{required}")),
            "{required}"
        );
    }
    let app = Router::new().route("/assets/{uri}", get(serve_static_file));
    let mut served = BTreeMap::<String, Vec<u8>>::new();
    while let Some(path) = pending.pop_first() {
        if served.contains_key(&path) {
            continue;
        }
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "GET {path}");
        let mime = match path.rsplit('.').next().unwrap() {
            "js" | "mjs" => "application/javascript",
            "css" => "text/css",
            "png" => "image/png",
            "svg" => "image/svg+xml",
            extension => panic!("unexpected map dependency: {extension}: {path}"),
        };
        assert_eq!(response.headers()[header::CONTENT_TYPE], mime, "{path}");
        let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        assert!(!bytes.is_empty(), "empty map dependency: {path}");
        if path.ends_with(".css") {
            pending.extend(stylesheet_asset_urls(
                &path,
                std::str::from_utf8(&bytes).unwrap(),
            ));
        }
        if path == "/assets/leaflet.js" {
            let leaflet = std::str::from_utf8(&bytes).unwrap();
            // Leaflet標準アイコンはHTML/CSSだけでなくJavaScriptから選ばれる。
            for image in ["marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"] {
                assert!(leaflet.contains(image), "Leaflet default image: {image}");
                pending.insert(format!("/assets/{image}"));
            }
        }
        if path.ends_with(".png") {
            let image = image::load_from_memory(&bytes)
                .unwrap_or_else(|error| panic!("invalid map image {path}: {error}"));
            assert!(image.width() > 0 && image.height() > 0, "{path}");
        }
        served.insert(path, bytes);
    }
    for image in ["layers.png", "layers-2x.png", "marker-icon.png"] {
        assert!(
            served.contains_key(&format!("/assets/{image}")),
            "Leaflet CSS must keep its image dependencies: {image}"
        );
    }
}
