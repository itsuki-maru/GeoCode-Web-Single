use crate::error::AppError;
use crate::model::{
    CreateUpdatedTemporaryUrlResponse, CurrentTemporaryUrlResponse, GenarateUrlPayload,
    LayerObjectFromRow, MapStateParams, MarkerObjectFromRow, OnetimePasswordForm, ShapeObject,
    TemporaryUrl, TemporaryUrlFromDB, TileServers,
};
use crate::utils::vec_to_hashmap;
use axum::{
    Form, Json,
    extract::{Extension, Path, Query, rejection::PathRejection},
    http::{StatusCode, header::HeaderMap},
    response::{Html, IntoResponse},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{NaiveDateTime, Utc};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tera::{Context, Tera};
use tokio::sync::Mutex;
use uuid::Uuid;

mod snapshot;

// 通常共有と全画面地図共有を、同じ1枠へ原子的に保存する。
pub async fn generate_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<GenarateUrlPayload>,
) -> Result<Json<CreateUpdatedTemporaryUrlResponse>, AppError> {
    if payload.layers.is_empty() && payload.snapshot.is_none() {
        return Err(AppError::BadRequest);
    }
    let seconds = payload
        .minutes
        .checked_mul(60)
        .ok_or(AppError::BadRequest)?;
    let password_hash = build_share_password_hash(payload.share_password.as_deref())?;
    let captured = payload
        .snapshot
        .map(|value| snapshot::parse(value, &user_id))
        .transpose()?;
    let mut tx = super::answer_sqlite::begin_write(&pool).await?;
    let owner_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM user_model
            WHERE id = $1
        )
        "#,
    )
    .bind(&user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !owner_exists {
        return Err(AppError::NotFound);
    }
    let (layers, markers, shapes, map_snapshot) = if let Some(captured) = captured {
        snapshot::authorize(&mut tx, &user_id, &captured).await?;
        let requested: std::collections::HashSet<_> = payload.layers.iter().cloned().collect();
        if requested != captured.layers.keys().cloned().collect() {
            return Err(AppError::Validation(
                "共有するレイヤグループが一致しません。地図を開き直してください。".into(),
            ));
        }
        (
            captured.layers,
            captured.markers,
            captured.shapes,
            Some(captured.metadata),
        )
    } else {
        let layer_ids = payload.layers;
        let markers = get_markers_hash_map(&mut tx, &user_id, &layer_ids).await?;
        let layers = get_layer_hash_map(&mut tx, &user_id, &layer_ids).await?;
        let shapes = if payload.include_shapes {
            get_shapes_hash_map(&mut tx, &user_id, &layer_ids).await?
        } else {
            HashMap::new()
        };
        (layers, markers, shapes, None)
    };
    let id = Uuid::now_v7().to_string();
    let url = format!("/onetime/{id}");
    let mut temporary_url = TemporaryUrl::new(
        id,
        user_id,
        url,
        Duration::from_secs(seconds),
        password_hash,
        layers,
        markers,
        shapes,
        payload.include_tile_overlays,
    )
    .map_err(|_| AppError::BadRequest)?;
    temporary_url.map_snapshot = map_snapshot;
    let response = save_temporary_url(&mut tx, temporary_url, payload.update_url).await?;
    tx.commit().await?;
    Ok(Json(response))
}

pub async fn current_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<CurrentTemporaryUrlResponse>, AppError> {
    let mut tx = super::answer_sqlite::begin_write(&pool).await?;
    let current = sqlx::query_as::<_, CurrentTemporaryUrlResponse>(
        r#"
        SELECT
            id,
            url,
            expiration,
            password_hash IS NOT NULL AS is_password_protected
        FROM temporary_urls
        WHERE user_id = $1
        ORDER BY create_at DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(current) = current else {
        return Err(AppError::NotFound);
    };
    if is_expired(&current.expiration) {
        sqlx::query(
            r#"
            DELETE FROM temporary_urls
            WHERE user_id = $1
            "#,
        )
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    Ok(Json(current))
}

pub fn is_expired(expiration: &str) -> bool {
    // SQLiteの既存日時形式と小数秒の精度を維持する。
    NaiveDateTime::parse_from_str(expiration, "%Y-%m-%d %H:%M:%S%.f")
        .map(|expiration| expiration < Utc::now().naive_utc())
        .unwrap_or(false)
}

async fn save_temporary_url(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    temporary_url: TemporaryUrl,
    update_url: bool,
) -> Result<CreateUpdatedTemporaryUrlResponse, AppError> {
    let existing: Option<String> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM temporary_urls
        WHERE user_id = $1
        ORDER BY create_at DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(&temporary_url.user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let layers =
        serde_json::to_string(&temporary_url.layers).map_err(|_| AppError::InternalServerError)?;
    let markers =
        serde_json::to_string(&temporary_url.markers).map_err(|_| AppError::InternalServerError)?;
    let shapes =
        serde_json::to_string(&temporary_url.shapes).map_err(|_| AppError::InternalServerError)?;
    let map_snapshot = temporary_url
        .map_snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| AppError::InternalServerError)?;
    if let Some(id) = existing.filter(|_| update_url) {
        // 過去の並行発行で複数残っていた場合も、この操作で1枠へ戻す。
        sqlx::query(
            r#"
            DELETE FROM temporary_urls
            WHERE user_id = $1
                AND id <> $2
            "#,
        )
        .bind(&temporary_url.user_id)
        .bind(&id)
        .execute(&mut **tx)
        .await?;
        Ok(sqlx::query_as::<_, CreateUpdatedTemporaryUrlResponse>(
            r#"
            UPDATE temporary_urls
            SET
                expiration = $1,
                password_hash = $2,
                layers = $3,
                markers = $4,
                shapes = $5,
                include_tile_overlays = $6,
                map_snapshot = $7
            WHERE id = $8
            RETURNING
                id,
                url,
                expiration
            "#,
        )
        .bind(temporary_url.expiration)
        .bind(temporary_url.password_hash)
        .bind(layers)
        .bind(markers)
        .bind(shapes)
        .bind(temporary_url.include_tile_overlays)
        .bind(map_snapshot)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?)
    } else {
        // DELETEとINSERTは同じトランザクション内。INSERT失敗時は旧URLも復元する。
        sqlx::query(
            r#"
            DELETE FROM temporary_urls
            WHERE user_id = $1
            "#,
        )
        .bind(&temporary_url.user_id)
        .execute(&mut **tx)
        .await?;
        Ok(sqlx::query_as::<_, CreateUpdatedTemporaryUrlResponse>(
            r#"
            INSERT INTO temporary_urls (
                id,
                user_id,
                url,
                expiration,
                password_hash,
                layers,
                markers,
                shapes,
                include_tile_overlays,
                map_snapshot,
                create_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING
                id,
                url,
                expiration
            "#,
        )
        .bind(temporary_url.id)
        .bind(temporary_url.user_id)
        .bind(temporary_url.url)
        .bind(temporary_url.expiration)
        .bind(temporary_url.password_hash)
        .bind(layers)
        .bind(markers)
        .bind(shapes)
        .bind(temporary_url.include_tile_overlays)
        .bind(map_snapshot)
        .bind(Utc::now().naive_utc())
        .fetch_one(&mut **tx)
        .await?)
    }
}

async fn get_shapes_hash_map(
    connection: &mut sqlx::SqliteConnection,
    user_id: &str,
    layer_ids: &[String],
) -> Result<HashMap<String, ShapeObject>, AppError> {
    let shapes = sqlx::query_as::<_, ShapeObject>(
        r#"
        SELECT
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        FROM shape_model
        WHERE user_id = $1
            AND layer_id IN (SELECT value FROM json_each($2))
        ORDER BY created_at ASC
        "#,
    )
    .bind(user_id)
    .bind(serde_json::to_string(layer_ids).map_err(|_| AppError::InternalServerError)?)
    .fetch_all(connection)
    .await?;
    Ok(vec_to_hashmap(shapes, |shape| shape.id.clone()))
}

async fn get_markers_hash_map(
    connection: &mut sqlx::SqliteConnection,
    user_id: &str,
    layer_ids: &[String],
) -> Result<HashMap<String, MarkerObjectFromRow>, AppError> {
    let markers = sqlx::query_as::<_, MarkerObjectFromRow>(
        r#"
        SELECT
            id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail
        FROM marker_info_model
        WHERE user_id = $1
            AND layer_id IN (SELECT value FROM json_each($2))
        "#,
    )
    .bind(user_id)
    .bind(serde_json::to_string(layer_ids).map_err(|_| AppError::InternalServerError)?)
    .fetch_all(connection)
    .await?;
    Ok(vec_to_hashmap(markers, |marker| marker.id.clone()))
}

async fn get_layer_hash_map(
    connection: &mut sqlx::SqliteConnection,
    user_id: &str,
    layer_ids: &[String],
) -> Result<HashMap<String, LayerObjectFromRow>, AppError> {
    let layers = sqlx::query_as::<_, LayerObjectFromRow>(
        r#"
        SELECT
            l.id,
            l.user_id,
            l.layer_name,
            l.is_master,
            l.restrict_free_text,
            l.marker_icon_id,
            m.uuid_filename AS marker_icon_filename
        FROM layer_model l
        LEFT JOIN marker_icon_model m ON m.id = l.marker_icon_id
        WHERE l.user_id = $1
            AND l.id IN (SELECT value FROM json_each($2))
        "#,
    )
    .bind(user_id)
    .bind(serde_json::to_string(layer_ids).map_err(|_| AppError::InternalServerError)?)
    .fetch_all(connection)
    .await?;
    Ok(vec_to_hashmap(layers, |layer| layer.id.clone()))
}

async fn delete_temporary_url(pool: &SqlitePool, user_id: String) -> Result<(), AppError> {
    let mut tx = super::answer_sqlite::begin_write(pool).await?;
    sqlx::query(
        r#"
        DELETE FROM temporary_urls
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

// 閲覧開始後に延長されたURLを、古い期限切れ判定で削除しない。
async fn delete_expired_temporary_url(
    pool: &SqlitePool,
    id: &str,
    expiration: &str,
) -> Result<(), AppError> {
    let mut tx = super::answer_sqlite::begin_write(pool).await?;
    sqlx::query(
        r#"
        DELETE FROM temporary_urls
        WHERE id = $1
            AND expiration = $2
        "#,
    )
    .bind(id)
    .bind(expiration)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

// 一時URLからmapを取得
pub async fn temporary_map_get_handler(
    headers: HeaderMap,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Query(params): Query<MapStateParams>,
    url_id: Result<Path<String>, PathRejection>,
) -> Result<impl IntoResponse, AppError> {
    // User-Agent取り出し
    let user_agent = headers.get("user-agent").and_then(|ua| ua.to_str().ok());

    // User-Agentにmobileという文字が含まれているか確認
    let is_mobile = user_agent.map_or(false, |ua| ua.contains("Mobile"));

    // notfound.html用
    let viewport_content = if is_mobile { "0.7" } else { "1.0" };

    // レイヤのチェック有無
    let is_checked = resolve_is_checked(params.is_checked.as_deref());
    let is_overlay_tile = resolve_is_checked(params.is_overlay_tile.as_deref());
    let initial_view = resolve_initial_view(&params);
    let is_map_ui_hidden = resolve_is_map_ui_hidden(params.is_map_ui_hidden.as_deref());
    let map_state_query =
        build_map_state_query(is_checked, initial_view, is_map_ui_hidden, is_overlay_tile);

    match url_id {
        // 正常な UUID が渡された場合
        Ok(Path(url_id)) => {
            let render_html = if is_mobile {
                "temporary-map-mobile.html"
            } else {
                "temporary-map.html"
            };

            let temp_url = sqlx::query_as::<_, TemporaryUrlFromDB>(
                r#"
                SELECT
                    id,
                    user_id,
                    url,
                    expiration,
                    password_hash,
                    layers,
                    markers,
                    shapes,
                    create_at,
                    include_tile_overlays,
                    map_snapshot
                FROM temporary_urls
                WHERE id = $1
                "#,
            )
            .bind(&url_id)
            .fetch_one(&pool)
            .await;

            match temp_url {
                // DBから共有URLの取得に成功した場合
                Ok(temp_url) => {
                    // 共有URLが期限切れの場合
                    if temp_url.is_expired() {
                        delete_expired_temporary_url(&pool, &temp_url.id, &temp_url.expiration)
                            .await?;
                        return render_not_found_page(&tera, viewport_content).await;
                    } else if temp_url.password_hash.is_some() {
                        return render_password_required_page(
                            &tera,
                            viewport_content,
                            None,
                            url_id,
                            is_checked,
                            &map_state_query,
                        )
                        .await;
                    // 正常に 共有URLを返却できる場合
                    } else {
                        return render_temporary_map_page(
                            &pool,
                            &tera,
                            render_html,
                            temp_url,
                            is_checked,
                            initial_view,
                            is_map_ui_hidden,
                            is_overlay_tile,
                        )
                        .await;
                    }
                },
                // DBから共有URLの取得に失敗した場合
                Err(_) => {
                    return render_not_found_page(&tera, viewport_content).await;
                },
            }
        },
        // 不正な UUID が渡された場合
        Err(_rejection) => {
            return render_not_found_page(&tera, viewport_content).await;
        },
    }
}

// 共有パスワード認証を行うハンドラー
pub async fn temporary_map_auth_handler(
    headers: HeaderMap,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Query(params): Query<MapStateParams>,
    Path(url_id): Path<String>,
    Form(form): Form<OnetimePasswordForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_agent = headers.get("user-agent").and_then(|ua| ua.to_str().ok());
    let is_mobile = user_agent.map_or(false, |ua| ua.contains("Mobile"));
    let viewport_content = if is_mobile { "0.7" } else { "1.0" };
    let render_html = if is_mobile {
        "temporary-map-mobile.html"
    } else {
        "temporary-map.html"
    };

    let is_checked = resolve_is_checked(params.is_checked.as_deref());
    let is_overlay_tile = resolve_is_checked(params.is_overlay_tile.as_deref());
    let initial_view = resolve_initial_view(&params);
    let is_map_ui_hidden = resolve_is_map_ui_hidden(params.is_map_ui_hidden.as_deref());
    let map_state_query =
        build_map_state_query(is_checked, initial_view, is_map_ui_hidden, is_overlay_tile);

    let temp_url = sqlx::query_as::<_, TemporaryUrlFromDB>(
        r#"
        SELECT
            id,
            user_id,
            url,
            expiration,
            password_hash,
            layers,
            markers,
            shapes,
            create_at,
            include_tile_overlays,
            map_snapshot
        FROM temporary_urls
        WHERE id = $1
        "#,
    )
    .bind(&url_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // 存在しない場合 NotFound を返す
    let Some(temp_url) = temp_url else {
        return render_not_found_page(&tera, viewport_content).await;
    };

    // 期限切れの場合、削除して NotFound を返す
    if temp_url.is_expired() {
        delete_expired_temporary_url(&pool, &temp_url.id, &temp_url.expiration).await?;
        return render_not_found_page(&tera, viewport_content).await;
    }

    // パスワードが設定されている場合、認証を行う
    let Some(password_hash) = temp_url.password_hash.as_deref() else {
        // パスワードが設定されていない場合は直接表示
        return render_temporary_map_page(
            &pool,
            &tera,
            render_html,
            temp_url,
            is_checked,
            initial_view,
            is_map_ui_hidden,
            is_overlay_tile,
        )
        .await;
    };

    // パスワードが正しいか検証
    let is_valid = verify(&form.password, password_hash).unwrap_or(false);
    // パスワードが正しくない場合はメッセージを付けて認証ページを表示
    if !is_valid {
        return render_password_required_page(
            &tera,
            viewport_content,
            Some("パスワードが正しくありません。"),
            url_id,
            is_checked,
            &map_state_query,
        )
        .await;
    }

    // パスワードが正しい場合はマップを表示
    render_temporary_map_page(
        &pool,
        &tera,
        render_html,
        temp_url,
        is_checked,
        initial_view,
        is_map_ui_hidden,
        is_overlay_tile,
    )
    .await
}

const DEFAULT_TEMPORARY_MAP_LATITUDE: f64 = 39.2;
const DEFAULT_TEMPORARY_MAP_LONGITUDE: f64 = 138.5;
const DEFAULT_TEMPORARY_MAP_ZOOM: i32 = 6;
const MIN_TEMPORARY_MAP_ZOOM: i32 = 0;
const MAX_TEMPORARY_MAP_ZOOM: i32 = 22;

#[derive(Clone, Copy)]
struct TemporaryMapInitialView {
    latitude: f64,
    longitude: f64,
    zoom: i32,
}

fn resolve_is_checked(is_checked: Option<&str>) -> bool {
    !matches!(is_checked, Some(value) if value.eq_ignore_ascii_case("false"))
}

fn resolve_is_map_ui_hidden(is_map_ui_hidden: Option<&str>) -> bool {
    !matches!(is_map_ui_hidden, Some(value) if value.eq_ignore_ascii_case("false"))
}

fn resolve_initial_view(params: &MapStateParams) -> TemporaryMapInitialView {
    TemporaryMapInitialView {
        latitude: params
            .lat
            .filter(|lat| lat.is_finite() && (-90.0..=90.0).contains(lat))
            .unwrap_or(DEFAULT_TEMPORARY_MAP_LATITUDE),
        longitude: params
            .lng
            .filter(|lng| lng.is_finite() && (-180.0..=180.0).contains(lng))
            .unwrap_or(DEFAULT_TEMPORARY_MAP_LONGITUDE),
        zoom: params
            .zoom
            .filter(|zoom| (MIN_TEMPORARY_MAP_ZOOM..=MAX_TEMPORARY_MAP_ZOOM).contains(zoom))
            .unwrap_or(DEFAULT_TEMPORARY_MAP_ZOOM),
    }
}

fn build_map_state_query(
    is_checked: bool,
    initial_view: TemporaryMapInitialView,
    is_map_ui_hidden: bool,
    is_overlay_tile: bool,
) -> String {
    format!(
        "is_checked={}&lat={}&lng={}&zoom={}&isMapUiHidden={}&is_overlay_tile={}",
        is_checked,
        initial_view.latitude,
        initial_view.longitude,
        initial_view.zoom,
        is_map_ui_hidden,
        is_overlay_tile
    )
}

// 一時URLの削除（ユーザーは一つの共有URLしか持っていないため、user_idだけで削除）
pub async fn invalidate_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<StatusCode, AppError> {
    delete_temporary_url(&pool, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// 共有パスワードのハッシュ化（パスワードが空の場合はNoneを返す）
fn build_share_password_hash(raw_password: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(password) = raw_password.map(str::trim) else {
        return Ok(None);
    };

    if password.is_empty() {
        return Ok(None);
    }

    if password.len() < 4 {
        return Err(AppError::Validation(
            "共有パスワードは4文字以上で設定してください。".into(),
        ));
    }

    if password.len() > 64 {
        return Err(AppError::Validation(
            "共有パスワードは64文字以内で設定してください。".into(),
        ));
    }

    hash(password, DEFAULT_COST)
        .map(Some)
        .map_err(|_| AppError::InternalServerError)
}

// 一時URLのマップページをレンダリングする
async fn render_temporary_map_page(
    pool: &SqlitePool,
    tera: &Arc<Mutex<Tera>>,
    render_html: &str,
    temp_url: TemporaryUrlFromDB,
    is_checked: bool,
    initial_view: TemporaryMapInitialView,
    is_map_ui_hidden: bool,
    is_overlay_tile: bool,
) -> Result<axum::response::Response, AppError> {
    let shared_snapshot = temp_url
        .map_snapshot
        .as_deref()
        .map(parse_json)
        .transpose()?;
    let mut context = Context::new();
    if let Some(snapshot) = &shared_snapshot {
        // スナップショット共有では、保存後のタイル設定を追加取得しない。
        context.insert("tileServers", &snapshot["tileServers"]);
        context.insert("tileOverlays", &snapshot["tileOverlays"]);
    } else {
        let tile_servers = sqlx::query_as::<_, TileServers>(
            r#"
            SELECT
                id,
                layer_name,
                label,
                url,
                attribution,
                include_foreign_tiles,
                min_zoom,
                max_zoom,
                create_at,
                updated_at
            FROM tileserver_model
            "#,
        )
        .fetch_all(pool)
        .await?;
        let tile_servers = vec_to_hashmap(tile_servers, |server| server.id);
        context.insert("tileServers", &tile_servers);
        let tile_overlays = if temp_url.include_tile_overlays {
            crate::handler::tile_overlays::selected_tiles(pool, &temp_url.user_id).await?
        } else {
            Vec::new()
        };
        context.insert("tileOverlays", &tile_overlays);
    }
    let layers = parse_json(&temp_url.layers)?;
    let markers = parse_json(&temp_url.markers)?;
    let shapes = parse_json(&temp_url.shapes)?;
    context.insert("layers", &layers);
    context.insert("markersObj", &markers);
    context.insert("shapesObj", &shapes);
    context.insert("shareSnapshot", &shared_snapshot);
    context.insert("geocoderCsis", &crate::config::CONFIG.geocoder.uses_csis());
    context.insert(
        "geocoderShareToken",
        &crate::handler::geocoding::share_token(&temp_url)?,
    );
    context.insert("isOverlayTile", &is_overlay_tile);
    context.insert("isChecked", &is_checked);
    context.insert("latitude", &initial_view.latitude);
    context.insert("longitude", &initial_view.longitude);
    context.insert("zoom", &initial_view.zoom);
    context.insert("isMapUiHidden", &is_map_ui_hidden);

    let tera = tera.lock().await;
    match tera.render(render_html, &context) {
        Ok(rendered) => Ok((
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Html(rendered),
        )
            .into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}

fn parse_json(s: &str) -> Result<serde_json::Value, AppError> {
    serde_json::from_str(s).map_err(|_e| AppError::InternalServerError)
}

// 404ページをレンダリングする
async fn render_not_found_page(
    tera: &Arc<Mutex<Tera>>,
    viewport_content: &str,
) -> Result<axum::response::Response, AppError> {
    let mut context = Context::new();
    let statuscode = "Not Found".to_string();
    let message = "コンテンツが見つかりません。共有の期限切れやURLの入力間違いの可能性があります。"
        .to_string();

    context.insert("viewport_content", viewport_content);
    context.insert("statuscode", &statuscode);
    context.insert("message", &message);

    let tera = tera.lock().await;
    match tera.render("notfound.html", &context) {
        Ok(rendered) => Ok((
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Html(rendered),
        )
            .into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}

// 共有パスワードが必要なページをレンダリングする
async fn render_password_required_page(
    tera: &Arc<Mutex<Tera>>,
    viewport_content: &str,
    error_message: Option<&str>,
    url_id: String,
    is_checked: bool,
    map_state_query: &str,
) -> Result<axum::response::Response, AppError> {
    let mut context = Context::new();
    context.insert("viewport_content", viewport_content);
    context.insert("error_message", &error_message.unwrap_or(""));
    context.insert("url_id", &url_id);
    context.insert("isChecked", &is_checked);
    context.insert("mapStateQuery", map_state_query);

    let tera = tera.lock().await;
    match tera.render("temporary-password.html", &context) {
        Ok(rendered) => Ok((
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Html(rendered),
        )
            .into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}
