use crate::{
    db::{
        BasemapScope,
        tiles::{BasemapCatalog, load_basemap_catalog, next_background_id},
    },
    error::AppError,
    handler::live_map::require_superuser,
    local_tiles::LocalTiles,
    model::{TileServers, is_valid_basemap_definition, is_valid_basemap_provider},
};
use axum::{
    Json,
    extract::{Extension, Path},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

#[derive(Deserialize)]
pub struct BackgroundMapInput {
    layer_name: String,
    label: String,
    url: String,
    attribution: String,
    include_foreign_tiles: bool,
    min_zoom: Option<i64>,
    max_zoom: Option<i64>,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    style_url: Option<String>,
    #[serde(default = "default_provider")]
    provider: String,
    google_map_type: Option<String>,
    enabled: Option<bool>,
    allow_temporary_share: Option<bool>,
    allow_live_map: Option<bool>,
}

fn default_kind() -> String {
    "raster".into()
}

fn default_provider() -> String {
    "generic".into()
}

/// 本体DBの書き込みトランザクション中に呼び出し、catalogの検査から本体DBへの
/// コミットまでの間に、利用停止処理の参照確認が通過することを防ぐ。
pub(crate) async fn validate_local_tile_url(
    service: Option<&Arc<LocalTiles>>,
    url: &str,
) -> Result<(), AppError> {
    if !crate::local_tiles::service::references_local_tiles(url) {
        return Ok(());
    }
    let service = service.ok_or_else(|| {
        AppError::ServiceUnavailable("ローカル地図の管理DBを利用できません。".into())
    })?;
    service.validate_background_url(url).await.map_err(|error| {
        if error.status == 400 {
            AppError::Validation(error.message)
        } else {
            AppError::ServiceUnavailable(error.message)
        }
    })
}
fn clean_attribution(value: &str) -> Result<String, AppError> {
    let cleaned = ammonia::Builder::default()
        .tags(HashSet::from([
            "a", "br", "span", "strong", "em", "b", "i", "u", "small", "sup", "sub",
        ]))
        .tag_attributes(HashMap::from([("a", HashSet::from(["href", "title"]))]))
        .generic_attributes(HashSet::new())
        .url_schemes(HashSet::from(["http", "https"]))
        .url_relative(ammonia::UrlRelative::Deny)
        .add_clean_content_tags(&["iframe", "object", "embed", "svg", "math", "template"])
        .link_rel(None)
        .clean(value)
        .to_string();
    if cleaned.chars().count() > 255 {
        return Err(AppError::Validation(
            "出典はHTMLの安全化後も255文字以内になるように入力してください。".into(),
        ));
    }
    Ok(cleaned)
}

fn valid_image_url(value: &str) -> bool {
    if value.is_empty()
        || value.chars().count() > 255
        || value.chars().any(char::is_control)
        || value.contains(['\\', '#'])
    {
        return false;
    }
    let mut expanded = value.to_owned();
    for (token, replacement) in [
        ("{s}", "a"),
        ("{r}", ""),
        ("{z}", "0"),
        ("{x}", "0"),
        ("{y}", "0"),
        ("{-y}", "0"),
    ] {
        expanded = expanded.replace(token, replacement);
    }
    if expanded.contains(['{', '}']) {
        return false;
    }
    if expanded.starts_with('/') {
        return !expanded.starts_with("//");
    }
    if !expanded
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        && !expanded
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return false;
    }
    reqwest::Url::parse(&expanded).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

impl BackgroundMapInput {
    fn validate(mut self, id: Option<i64>) -> Result<Self, AppError> {
        // 配信元のスタイルURLと出典HTMLを保持し、テキスト項目の前後の空白を除去する。
        if self.layer_name.chars().any(char::is_control)
            || self.label.chars().any(char::is_control)
            || self.url.chars().any(char::is_control)
            || self.attribution.contains('\0')
        {
            return Err(AppError::Validation(
                "背景地図の入力に使用できない制御文字が含まれています。".into(),
            ));
        }
        self.layer_name = self.layer_name.trim().to_owned();
        self.label = self.label.trim().to_owned();
        self.url = self.url.trim().to_owned();
        if self.layer_name.is_empty()
            || self.label.is_empty()
            || self.layer_name.chars().count() > 255
            || self.label.chars().count() > 255
            || self.attribution.chars().count() > 255
        {
            return Err(AppError::Validation(
                "背景名・表示名は必須です。背景名・表示名・出典は255文字以内で入力してください。"
                    .into(),
            ));
        }
        if !is_valid_basemap_provider(&self.kind, &self.provider, self.google_map_type.as_deref()) {
            return Err(AppError::Validation(
                "背景の配信元とGoogle地図の種類を確認してください。".into(),
            ));
        }
        if self.provider == "google" {
            self.url = "/google-maps/tiles/{z}/{x}/{y}".into();
            self.attribution.clear();
        }
        if !valid_image_url(&self.url) {
            return Err(AppError::Validation(
                "画像タイルURLは255文字以内のHTTP・HTTPS URLまたは同一サイトの絶対パスを指定してください。認証情報・フラグメント・未対応の置換文字は使用できません。"
                    .into(),
            ));
        }
        if self.kind == "raster" && self.style_url.as_deref() == Some("") {
            self.style_url = None;
        }
        if !is_valid_basemap_definition(&self.kind, self.style_url.as_deref())
            || self
                .style_url
                .as_deref()
                .is_some_and(|style| style.trim() != style)
        {
            return Err(AppError::Validation(
                "種別とスタイルURLを確認してください。ベクタは前後空白のないHTTPS URLまたは同一サイトの絶対パス（4096バイト以内）が必須です。ラスタにスタイルURLは指定できません。"
                    .into(),
            ));
        }
        if id == Some(1) && (self.kind != "raster" || self.provider != "generic") {
            return Err(AppError::Validation(
                "既定の背景地図（ID 1）はラスタのまま使用してください。".into(),
            ));
        }
        let min = self.min_zoom.unwrap_or(5);
        let max = self.max_zoom.unwrap_or(18);
        if !(0..=22).contains(&min) || !(min..=22).contains(&max) {
            return Err(AppError::Validation(
                "ズームは0〜22の整数で、最小値が最大値以下になるように指定してください。空欄は最小5・最大18です。"
                    .into(),
            ));
        }
        Ok(self)
    }
}

#[derive(Serialize)]
pub struct BackgroundMapList {
    pub backgrounds: Vec<TileServers>,
    pub fallbacks: BackgroundMapFallbacks,
}

#[derive(Serialize)]
pub struct BackgroundMapFallbacks {
    pub normal: Option<String>,
    pub temporary: Option<String>,
    pub live: Option<String>,
}

impl BackgroundMapFallbacks {
    fn from_catalog(catalog: &BasemapCatalog) -> Self {
        let fallback_id = |scope| catalog.fallback(scope).map(|id| id.to_string());
        Self {
            normal: fallback_id(BasemapScope::Normal),
            temporary: fallback_id(BasemapScope::Temporary),
            live: fallback_id(BasemapScope::Live),
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateFallbacks {
    temporary: String,
    live: String,
}

fn scope_label(scope: BasemapScope) -> &'static str {
    match scope {
        BasemapScope::Normal => "通常地図",
        BasemapScope::Temporary => "共有URL",
        BasemapScope::Live => "ライブマップ",
    }
}

fn fallback_required(scope: BasemapScope) -> AppError {
    AppError::Validation(format!(
        "{}のフォールバックには、その地図で使用可能な有効なラスタ背景が必要です。",
        scope_label(scope)
    ))
}

fn validate_fallbacks(catalog: &BasemapCatalog) -> Result<(), AppError> {
    for scope in BasemapScope::ALL {
        if catalog.fallback(scope).is_none() {
            return Err(fallback_required(scope));
        }
    }
    Ok(())
}

pub async fn admin_list(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<BackgroundMapList>, AppError> {
    require_superuser(&user, &pool).await?;
    let catalog = load_basemap_catalog(&pool).await?;
    Ok(Json(BackgroundMapList {
        fallbacks: BackgroundMapFallbacks::from_catalog(&catalog),
        backgrounds: catalog.tiles,
    }))
}

pub async fn admin_update_fallbacks(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(input): Json<UpdateFallbacks>,
) -> Result<Json<BackgroundMapFallbacks>, AppError> {
    require_superuser(&user, &pool).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let catalog = load_basemap_catalog(&mut *tx).await?;
    let resolve = |value: &str, scope: BasemapScope| -> Result<i64, AppError> {
        let id: i64 = value.parse().map_err(|_| fallback_required(scope))?;
        catalog
            .tiles
            .iter()
            .any(|tile| tile.id == id && scope.allows_fallback(tile))
            .then_some(id)
            .ok_or_else(|| fallback_required(scope))
    };
    let temporary = resolve(&input.temporary, BasemapScope::Temporary)?;
    let live = resolve(&input.live, BasemapScope::Live)?;
    sqlx::query(
        r#"
        INSERT INTO background_map_fallbacks (id, temporary_id, live_id)
        VALUES (1, $1, $2)
        ON CONFLICT (id) DO UPDATE
        SET
            temporary_id = excluded.temporary_id,
            live_id = excluded.live_id
        "#,
    )
    .bind(temporary)
    .bind(live)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(BackgroundMapFallbacks {
        normal: catalog
            .fallback(BasemapScope::Normal)
            .map(|id| id.to_string()),
        temporary: Some(temporary.to_string()),
        live: Some(live.to_string()),
    }))
}

pub async fn admin_create(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    local_tiles: Option<Extension<Arc<LocalTiles>>>,
    Json(input): Json<BackgroundMapInput>,
) -> Result<Json<TileServers>, AppError> {
    require_superuser(&user, &pool).await?;
    let mut input = input.validate(None)?;
    input.attribution = clean_attribution(&input.attribution)?;
    // catalogの遅延初期化では本体DBの接続を調べる。本体プールの接続が1本でも
    // 待ち合わないように、書き込みの排他を確保する前に初期化する。
    validate_local_tile_url(
        local_tiles.as_ref().map(|extension| &extension.0),
        &input.url,
    )
    .await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    validate_local_tile_url(
        local_tiles.as_ref().map(|extension| &extension.0),
        &input.url,
    )
    .await?;
    // 読み取り前に書き込み権を確保し、ID・識別名の割り当てと更新を直列化する。
    if (input.kind == "vector" || input.provider == "google")
        && load_basemap_catalog(&mut *tx)
            .await?
            .fallback(BasemapScope::Normal)
            .is_none()
    {
        return Err(fallback_required(BasemapScope::Normal));
    }
    if sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM tileserver_model
            WHERE layer_name = $1
        )
        "#,
    )
    .bind(&input.layer_name)
    .fetch_one(&mut *tx)
    .await?
    {
        return Err(AppError::Conflict);
    }
    let id = next_background_id(&mut tx)
        .await?
        .ok_or_else(|| AppError::Validation("登録できる背景地図のID上限に達しました。".into()))?;
    let tile = sqlx::query_as::<_, TileServers>(
        r#"
        INSERT INTO tileserver_model (
            id,
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            kind,
            style_url,
            provider,
            google_map_type,
            enabled,
            allow_temporary_share,
            allow_live_map,
            create_at,
            updated_at
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(input.layer_name)
    .bind(input.label)
    .bind(input.url)
    .bind(input.attribution)
    .bind(input.include_foreign_tiles)
    .bind(input.min_zoom)
    .bind(input.max_zoom)
    .bind(input.kind)
    .bind(input.style_url)
    .bind(input.provider)
    .bind(input.google_map_type)
    .bind(input.enabled.unwrap_or(true))
    .bind(input.allow_temporary_share.unwrap_or(true))
    .bind(input.allow_live_map.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await?;
    validate_fallbacks(&load_basemap_catalog(&mut *tx).await?)?;
    tx.commit().await?;
    Ok(Json(tile))
}

pub async fn admin_update(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<i64>,
    local_tiles: Option<Extension<Arc<LocalTiles>>>,
    Json(input): Json<BackgroundMapInput>,
) -> Result<Json<TileServers>, AppError> {
    require_superuser(&user, &pool).await?;
    let mut input = input.validate(Some(id))?;
    validate_local_tile_url(
        local_tiles.as_ref().map(|extension| &extension.0),
        &input.url,
    )
    .await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    validate_local_tile_url(
        local_tiles.as_ref().map(|extension| &extension.0),
        &input.url,
    )
    .await?;
    let catalog = load_basemap_catalog(&mut *tx).await?;
    let previous = catalog
        .tiles
        .iter()
        .find(|tile| tile.id == id)
        .ok_or(AppError::NotFound)?;
    // 他の項目を編集した場合は、既存ラスタの出典HTMLを原文のまま保持する。
    // 新規・変更したHTMLは、Leafletの出典表示へ渡す前に安全化する。
    if previous.attribution != input.attribution {
        input.attribution = clean_attribution(&input.attribution)?;
    }
    // 旧データの重複識別名は編集可能とし、新しいDOM IDの重複を防ぐ。
    if previous.layer_name != input.layer_name
        && catalog
            .tiles
            .iter()
            .any(|tile| tile.layer_name == input.layer_name)
    {
        return Err(AppError::Conflict);
    }
    let tile = sqlx::query_as::<_, TileServers>(
        r#"
        UPDATE tileserver_model
        SET
            layer_name = $2,
            label = $3,
            url = $4,
            attribution = $5,
            include_foreign_tiles = $6,
            min_zoom = $7,
            max_zoom = $8,
            kind = $9,
            style_url = $10,
            provider = $11,
            google_map_type = $12,
            enabled = $13,
            allow_temporary_share = $14,
            allow_live_map = $15,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(input.layer_name)
    .bind(input.label)
    .bind(input.url)
    .bind(input.attribution)
    .bind(input.include_foreign_tiles)
    .bind(input.min_zoom)
    .bind(input.max_zoom)
    .bind(input.kind)
    .bind(input.style_url)
    .bind(input.provider)
    .bind(input.google_map_type)
    .bind(input.enabled.unwrap_or(previous.enabled))
    .bind(
        input
            .allow_temporary_share
            .unwrap_or(previous.allow_temporary_share),
    )
    .bind(input.allow_live_map.unwrap_or(previous.allow_live_map))
    .fetch_one(&mut *tx)
    .await?;
    for scope in BasemapScope::ALL {
        if catalog.fallback(scope) == Some(id) && !scope.allows_fallback(&tile) {
            return Err(AppError::Validation(format!(
                "{}のフォールバックに使用中の背景地図は無効化・利用停止・種別変更できません。",
                scope_label(scope)
            )));
        }
    }
    validate_fallbacks(&load_basemap_catalog(&mut *tx).await?)?;
    tx.commit().await?;
    Ok(Json(tile))
}

pub async fn admin_delete(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    require_superuser(&user, &pool).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let catalog = load_basemap_catalog(&mut *tx).await?;
    if !catalog.tiles.iter().any(|tile| tile.id == id) {
        return Err(AppError::NotFound);
    }
    for scope in BasemapScope::ALL {
        if catalog.fallback(scope) == Some(id) {
            return Err(AppError::Validation(format!(
                "{}のフォールバックに使用中の背景地図は削除できません。",
                scope_label(scope)
            )));
        }
    }
    validate_fallbacks(&catalog)?;
    sqlx::query(
        r#"
        DELETE FROM tileserver_model
        WHERE id = $1
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::valid_image_url;

    #[test]
    fn accepts_http_same_origin_and_leaflet_placeholder_image_urls() {
        for url in [
            "/tile/{z}/{x}/{y}.png",
            "HTTP://tiles.example.test/fixed.png",
            "https://{s}.tiles.example.test/{z}/{x}/{-y}{r}.png?key=public",
            "/画像.png",
        ] {
            assert!(valid_image_url(url), "{url}");
        }
        for url in [
            "",
            "//tiles.example.test/a.png",
            "relative/{z}.png",
            "https://user:secret@tiles.example.test/a.png",
            "https://tiles.example.test/a.png#fragment",
            "https://tiles.example.test/a\nb.png",
            "/\\tiles.example.test/a.png",
            "data:image/png,xxx",
            "javascript:alert(1)",
            "https://tiles.example.test/{unknown}.png",
        ] {
            assert!(!valid_image_url(url), "{url:?}");
        }
    }
}
