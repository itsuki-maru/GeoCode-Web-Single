use crate::model::{TileServers, is_valid_basemap_definition};
use sqlx::SqlitePool;

/// 全地図ページで同じ背景定義を読み、種類・スタイル情報の欠落を防ぐ。
pub async fn load_tile_servers(pool: &SqlitePool) -> Result<Vec<TileServers>, sqlx::Error> {
    let records = sqlx::query_as::<_, TileServers>(
        r#"
        SELECT
            id, layer_name, label, url, kind, style_url, attribution,
            include_foreign_tiles, min_zoom, max_zoom, create_at, updated_at
        FROM tileserver_model
        ORDER BY id
        "#,
    )
    .fetch_all(pool)
    .await?;
    if records.iter().any(|record| {
        !is_valid_basemap_definition(&record.kind, record.style_url.as_deref())
            || (record.id == 1 && record.kind != "raster")
    }) {
        // スタイルURLには公開用トークンが含まれる可能性があるため、エラーへ含めない。
        return Err(sqlx::Error::Protocol(
            "Invalid background map definition".into(),
        ));
    }
    Ok(records)
}
