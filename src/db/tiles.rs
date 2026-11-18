use crate::model::{TileServers, is_valid_basemap_definition, is_valid_basemap_provider};
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};

#[derive(Clone, Copy)]
pub enum BasemapScope {
    Normal,
    Temporary,
    Live,
}

impl BasemapScope {
    pub(crate) const ALL: [Self; 3] = [Self::Normal, Self::Temporary, Self::Live];

    pub(crate) fn allows(self, tile: &TileServers) -> bool {
        tile.enabled
            && match self {
                Self::Normal => true,
                Self::Temporary => tile.allow_temporary_share,
                Self::Live => tile.allow_live_map,
            }
    }

    pub(crate) fn allows_fallback(self, tile: &TileServers) -> bool {
        self.allows(tile) && tile.kind == "raster" && tile.provider == "generic"
    }
}

#[derive(sqlx::FromRow)]
struct CatalogRow {
    #[sqlx(flatten)]
    tile: TileServers,
    temporary_id: Option<i64>,
    live_id: Option<i64>,
}

pub(crate) struct BasemapCatalog {
    pub tiles: Vec<TileServers>,
    temporary_id: Option<i64>,
    live_id: Option<i64>,
}

impl BasemapCatalog {
    pub fn fallback(&self, scope: BasemapScope) -> Option<i64> {
        let preferred = match scope {
            BasemapScope::Normal => None,
            BasemapScope::Temporary => self.temporary_id,
            BasemapScope::Live => self.live_id,
        }
        .unwrap_or(1);
        self.tiles
            .iter()
            .filter(|tile| scope.allows_fallback(tile))
            .min_by_key(|tile| (tile.id != preferred, tile.id))
            .map(|tile| tile.id)
    }

    pub fn into_available(mut self, scope: BasemapScope) -> AvailableTileServers {
        let fallback_id = self.fallback(scope);
        self.tiles.retain(|tile| scope.allows(tile));
        AvailableTileServers {
            tiles: self.tiles,
            fallback_id,
        }
    }
}

pub(crate) async fn load_basemap_catalog(
    executor: impl SqliteExecutor<'_>,
) -> Result<BasemapCatalog, sqlx::Error> {
    let records = sqlx::query_as::<_, CatalogRow>(
        r#"
        SELECT
            t.*,
            f.temporary_id,
            f.live_id
        FROM tileserver_model t
        LEFT JOIN background_map_fallbacks f ON f.id = 1
        ORDER BY t.id
        "#,
    )
    .fetch_all(executor)
    .await?;
    let (temporary_id, live_id) = records
        .first()
        .map(|row| (row.temporary_id, row.live_id))
        .unwrap_or_default();
    let tiles: Vec<_> = records.into_iter().map(|row| row.tile).collect();
    if tiles.iter().any(|record| {
        !is_valid_basemap_definition(&record.kind, record.style_url.as_deref())
            || !is_valid_basemap_provider(
                &record.kind,
                &record.provider,
                record.google_map_type.as_deref(),
            )
            || (record.id == 1 && (record.kind != "raster" || record.provider != "generic"))
    }) {
        // スタイルURLには公開用トークンが含まれる可能性があるため、エラーへ含めない。
        return Err(sqlx::Error::Protocol(
            "Invalid background map definition".into(),
        ));
    }
    Ok(BasemapCatalog {
        tiles,
        temporary_id,
        live_id,
    })
}

pub async fn load_tile_servers(pool: &SqlitePool) -> Result<Vec<TileServers>, sqlx::Error> {
    Ok(load_basemap_catalog(pool).await?.tiles)
}

pub struct AvailableTileServers {
    pub tiles: Vec<TileServers>,
    pub fallback_id: Option<i64>,
}

/// 地図の用途に応じた候補と代替背景を、同じDB読み取りから決定する。
pub async fn load_available_tile_servers(
    executor: impl SqliteExecutor<'_>,
    scope: BasemapScope,
) -> Result<AvailableTileServers, sqlx::Error> {
    Ok(load_basemap_catalog(executor).await?.into_available(scope))
}

/// 呼び出し元は書き込み開始時に排他を取り、採番と挿入を一括で確定する。
pub(crate) async fn next_background_id(
    connection: &mut SqliteConnection,
) -> Result<Option<i64>, sqlx::Error> {
    let last_id: i64 = sqlx::query_scalar(
        r#"
        SELECT last_id
        FROM background_map_sequence
        WHERE id = 1
        "#,
    )
    .fetch_one(connection)
    .await?;
    Ok(last_id.checked_add(1))
}

pub(crate) async fn load_google_tile_type(
    pool: &SqlitePool,
    id: i64,
    scope: BasemapScope,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT
            google_map_type
        FROM tileserver_model
        WHERE id = $1
            AND provider = 'google'
            AND enabled
            AND (NOT $2 OR allow_temporary_share)
            AND (NOT $3 OR allow_live_map)
        "#,
    )
    .bind(id)
    .bind(matches!(scope, BasemapScope::Temporary))
    .bind(matches!(scope, BasemapScope::Live))
    .fetch_optional(pool)
    .await
}
