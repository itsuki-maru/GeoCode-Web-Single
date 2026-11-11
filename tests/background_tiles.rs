#[allow(dead_code)]
mod common;

use geocode_web_single::{
    db::load_tile_servers,
    model::{TileServers, is_valid_basemap_definition, is_valid_basemap_style_url},
};
use serde_json::json;
use sqlx::SqlitePool;

const BACKGROUND_MIGRATION: &str =
    include_str!("../migrations/20261111090000_add_background_tile_kind.sql");

#[test]
fn スタイル_url_を検証し種別のない旧ラスタ定義を読める() {
    for url in [
        "https://tiles.example.test/style.json",
        "HTTPS://tiles.example.test/v1/style.json?key=public",
        "/styles/v1.json",
        "/",
    ] {
        assert!(is_valid_basemap_style_url(url), "{url}");
        assert!(is_valid_basemap_definition("vector", Some(url)));
    }
    for url in [
        "",
        "http://tiles.example.test/style.json",
        "//other.test/style.json",
        "/\\other.test/style.json",
        "styles/v1.json",
        "https://user:secret@tiles.example.test/style.json",
        "https://tiles.example.test/style.json#fragment",
        "https://tiles.example.test/\nstyle.json",
        "https://tiles.example.test/\u{0085}style.json",
        " https://tiles.example.test/style.json",
    ] {
        assert!(!is_valid_basemap_style_url(url), "{url:?}");
    }
    assert!(!is_valid_basemap_style_url(&format!(
        "/{}",
        "あ".repeat(1366)
    )));
    assert!(is_valid_basemap_definition("raster", None));
    assert!(!is_valid_basemap_definition(
        "raster",
        Some("/styles/v1.json")
    ));
    assert!(!is_valid_basemap_definition("vector", None));
    assert!(!is_valid_basemap_definition("unknown", None));
    let legacy: TileServers = serde_json::from_value(json!({
        "id":1,"layer_name":"旧背景","label":"旧背景","url":"/tile/{z}/{x}/{y}.png",
        "attribution":"出典","include_foreign_tiles":false,"min_zoom":null,"max_zoom":null,
        "create_at":"2026-01-01T00:00:00","updated_at":"2026-01-01T00:00:00"
    }))
    .unwrap();
    assert_eq!(legacy.kind, "raster");
    assert!(legacy.style_url.is_none());
    assert_eq!(legacy.url, "/tile/{z}/{x}/{y}.png");
}

#[tokio::test]
async fn 背景列の追加で既存ラスタと保存済み共有_json_を保持する() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE tileserver_model (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
         INSERT INTO tileserver_model VALUES (1, '/tile/{z}/{x}/{y}.png'), (7, 'https://custom.test/{z}/{x}/{y}.jpg');
         CREATE TABLE temporary_urls (id INTEGER PRIMARY KEY, map_snapshot TEXT);
         INSERT INTO temporary_urls VALUES (1, '{\"version\":1,\"tileServers\":{\"1\":{\"url\":\"/old/{z}/{x}/{y}.png\"}}}'), (2, NULL);",
    ).execute(&pool).await.unwrap();
    let before: Vec<Option<String>> =
        sqlx::query_scalar("SELECT map_snapshot FROM temporary_urls ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    sqlx::raw_sql(BACKGROUND_MIGRATION)
        .execute(&pool)
        .await
        .unwrap();
    let rows: Vec<(i64, String, String, Option<String>)> =
        sqlx::query_as("SELECT id, url, kind, style_url FROM tileserver_model ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            (1, "/tile/{z}/{x}/{y}.png".into(), "raster".into(), None),
            (
                7,
                "https://custom.test/{z}/{x}/{y}.jpg".into(),
                "raster".into(),
                None
            ),
        ]
    );
    let after: Vec<Option<String>> =
        sqlx::query_scalar("SELECT map_snapshot FROM temporary_urls ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(after, before);
    sqlx::query("INSERT INTO tileserver_model (id,url) VALUES (8,'/new.png')")
        .execute(&pool)
        .await
        .unwrap();
    let defaults: (String, Option<String>) =
        sqlx::query_as("SELECT kind,style_url FROM tileserver_model WHERE id=8")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(defaults, ("raster".into(), None));
    for (id, kind, style) in [
        (1, "vector", Some("/style.json")),
        (7, "unknown", None),
        (7, "vector", None),
        (7, "vector", Some(" ")),
        (7, "raster", Some("/style.json")),
    ] {
        assert!(
            sqlx::query("UPDATE tileserver_model SET kind=$1,style_url=$2 WHERE id=$3")
                .bind(kind)
                .bind(style)
                .bind(id)
                .execute(&pool)
                .await
                .is_err()
        );
    }
    assert!(
        sqlx::query("UPDATE tileserver_model SET kind='vector',style_url=$1 WHERE id=7")
            .bind(format!("/{}", "a".repeat(4096)))
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query("UPDATE tileserver_model SET kind='vector',style_url='/styles/v1.json' WHERE id=7")
        .execute(&pool)
        .await
        .unwrap();
}

async fn insert_backgrounds(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO tileserver_model (id,layer_name,label,url,attribution,include_foreign_tiles,min_zoom,max_zoom,create_at,updated_at,kind,style_url)
         VALUES (1,'raster','従来背景','/tile/{z}/{x}/{y}.png','出典',false,5,18,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'raster',NULL),
                (2,'vector','新背景','/fallback/{z}/{x}/{y}.png','出典',false,5,18,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'vector','/styles/v1.json')",
    ).execute(pool).await.unwrap();
}

#[tokio::test]
async fn 背景取得はラスタとベクタの種別とスタイルと画像_url_を保持する() {
    let pool = common::test_pool().await;
    insert_backgrounds(&pool).await;
    let rows = load_tile_servers(&pool).await.unwrap();
    assert_eq!(rows.iter().map(|row| row.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(rows[0].kind, "raster");
    assert!(rows[0].style_url.is_none());
    assert_eq!(rows[0].url, "/tile/{z}/{x}/{y}.png");
    assert_eq!(rows[1].kind, "vector");
    assert_eq!(rows[1].style_url.as_deref(), Some("/styles/v1.json"));
    assert_eq!(rows[1].url, "/fallback/{z}/{x}/{y}.png");
}

#[tokio::test]
async fn 背景取得は不正スタイル_url_を公開せずに拒否する() {
    let pool = common::test_pool().await;
    insert_backgrounds(&pool).await;
    sqlx::query("UPDATE tileserver_model SET style_url='http://invalid.test/style.json?secret=private' WHERE id=2")
        .execute(&pool).await.unwrap();
    let error = load_tile_servers(&pool).await.unwrap_err().to_string();
    assert!(error.contains("Invalid background map definition"));
    assert!(!error.contains("private") && !error.contains("invalid.test"));
}
