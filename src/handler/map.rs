use crate::error::AppError;
use crate::model::{
    LayerObject, MapAnotherWindowQueryParams, MapReadQueryPrams, MarkerObject, ShapeObject,
    TileServers,
};
use crate::utils::vec_to_hashmap;
use axum::{
    extract::{Extension, Query},
    http::HeaderMap,
    response::{Html, IntoResponse},
};
use sqlx::query_as;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tera::{Context, Tera};
use tokio::sync::Mutex;

// HTML地図の取得ハンドラー
pub async fn map_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Query(params): Query<MapReadQueryPrams>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    // User-Agent取り出し
    let user_agent = headers.get("user-agent").and_then(|ua| ua.to_str().ok());

    // User-Agentに"Mobile"が含まれているか確認
    let is_mobile = user_agent.map_or(false, |ua| ua.contains("Mobile"));

    let tile_servers = query_as!(
        TileServers,
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
        "#
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let tile_servers_hash_map = vec_to_hashmap(tile_servers, |t| t.id);

    let marker_id = params.marker_id;
    let latitude = params.latitude.unwrap_or(39.200);
    let longitude = params.longitude.unwrap_or(138.500);
    let layer = params.layer;
    let is_master = params.is_master.unwrap_or(true);

    let render_html = if is_mobile {
        "map-mobile.html"
    } else {
        "map.html"
    };

    let mut context = Context::new();

    let zoom = match marker_id {
        Some(id) => {
            context.insert("markerId", &id);
            18
        },
        None => {
            context.insert("markerId", "0");
            6
        },
    };

    let markers = if is_master {
        query_as!(
            MarkerObject,
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
            "#,
            user_id,
        )
        .fetch_all(&pool)
        .await
    } else {
        query_as!(
            MarkerObject,
            r#"
            SELECT
                id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail
            FROM marker_info_model
            WHERE user_id = $1 AND layer_id = $2
            "#,
            user_id,
            layer,
        )
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());

    let layers = query_as!(
        LayerObject,
        r#"
        SELECT
            id,
            user_id,
            layer_name,
            is_master
        FROM layer_model
        WHERE user_id = $1
        "#,
        user_id,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let layers_hash_map = vec_to_hashmap(layers, |l| l.id.clone());

    let shapes = sqlx::query_as::<_, ShapeObject>(if is_master {
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
            ORDER BY created_at ASC
            "#
    } else {
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
            WHERE user_id = $1 AND layer_id = $2
            ORDER BY created_at ASC
            "#
    });
    let shapes = if is_master {
        shapes.bind(&user_id).fetch_all(&pool).await
    } else {
        shapes
            .bind(&user_id)
            .bind(layer.as_deref())
            .fetch_all(&pool)
            .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    context.insert("layer", &layer);
    context.insert("is_master", &is_master);
    context.insert("latitude", &latitude);
    context.insert("longitude", &longitude);
    context.insert("zoom", &zoom);
    context.insert("tileServers", &tile_servers_hash_map);
    context.insert("layersFromAxum", &layers_hash_map);
    context.insert("markersFromAxum", &markers_hash_map);
    context.insert("shapesFromAxum", &shapes);

    let tera = tera.lock().await;
    match tera.render(render_html, &context) {
        Ok(rendered) => Ok(Html(rendered).into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}

// 地図別画面HTMLの取得ハンドラー
pub async fn map_another_get_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Query(params): Query<MapAnotherWindowQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    // タイルサーバの一覧を取得
    let tile_servers = query_as!(
        TileServers,
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
        "#
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // タイルサーバをハッシュマップに変換
    let tile_servers_hash_map = vec_to_hashmap(tile_servers, |t| t.id);

    // マーカーをクラスタリングするかどうか
    let is_cluster = params.is_cluster.unwrap_or(true);

    // マーカーを取得
    let markers = query_as!(
        MarkerObject,
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
        "#,
        user_id,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // マーカーをハッシュマップに変換
    let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());

    // レイヤーを取得
    let layers = query_as!(
        LayerObject,
        r#"
        SELECT
            id,
            user_id,
            layer_name,
            is_master
        FROM layer_model
        WHERE user_id = $1
        "#,
        user_id,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // レイヤーをハッシュマップに変換
    let layers_hash_map = vec_to_hashmap(layers, |l| l.id.clone());

    // シェイプの一覧を取得
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
        ORDER BY created_at ASC
        "#,
    )
    .bind(&user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let mut context = Context::new();
    context.insert("tileServers", &tile_servers_hash_map);
    context.insert("is_cluster", &is_cluster);
    context.insert("layersFromAxum", &layers_hash_map);
    context.insert("markersFromAxum", &markers_hash_map);
    context.insert("shapesFromAxum", &shapes);

    let tera = tera.lock().await;
    match tera.render("map-anather.html", &context) {
        Ok(rendered) => Ok(Html(rendered).into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}
