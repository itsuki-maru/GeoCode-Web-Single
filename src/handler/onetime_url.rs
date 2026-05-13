use crate::error::AppError;
use crate::model::{
    CreateUpdatedTemporaryUrlResponse, CurrentTemporaryUrlResponse, GenarateUrlPayload,
    LayerObjectFromRow, MarkerObjectFromRow, OnetimePasswordForm, ShapeObject, TemporaryUrl,
    TemporaryUrlFromDB, TileServers,
};
use crate::utils::vec_to_hashmap;
use axum::{
    Form, Json,
    extract::{Extension, Path, rejection::PathRejection},
    http::{StatusCode, header::HeaderMap},
    response::{Html, IntoResponse},
};
use bcrypt::{DEFAULT_COST, hash, verify};
use chrono::{NaiveDateTime, Utc};
use sqlx::query_as;
use sqlx::{query, sqlite::SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tera::{Context, Tera};
use tokio::sync::Mutex;
use uuid::Uuid;

// 一時URLの発行
pub async fn generate_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(payload): Json<GenarateUrlPayload>,
) -> Result<Json<CreateUpdatedTemporaryUrlResponse>, AppError> {
    // 共有レイヤが空の場合
    if payload.layers.is_empty() {
        return Err(AppError::BadRequest);
    }

    // payloadからレイヤーIDを取得
    let layer_ids: Vec<String> = payload.layers.clone();
    let markers_hash_map: HashMap<String, MarkerObjectFromRow> =
        get_markers_hash_map(&pool, user_id.clone(), layer_ids.clone()).await?;
    let layers_hash_map: HashMap<String, LayerObjectFromRow> =
        get_layer_hash_map(&pool, user_id.clone(), layer_ids.clone()).await?;
    let shapes_hash_map: HashMap<String, ShapeObject> = if payload.include_shapes {
        get_shapes_hash_map(&pool, user_id.clone(), layer_ids.clone()).await?
    } else {
        HashMap::new()
    };

    // 既に一時URLを発行しているユーザーか確認
    let record = query!(
        r#"
        SELECT COUNT(*) as count
        FROM temporary_urls
        WHERE user_id = $1"#,
        user_id,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    // 既に発行済みのURLがあるか確認するフラグ
    let is_issued = record.count > 0;

    // 新規データ作成
    let uuid = Uuid::now_v7().to_string();
    let url = format!("/onetime/{}", uuid);
    // パスワードをハッシュ化（設定されている場合）
    let password_hash = build_share_password_hash(payload.share_password.as_deref())?;
    let temp_url = TemporaryUrl::new(
        uuid,
        user_id.clone(),
        url,
        Duration::from_secs(payload.minutes * 60),
        password_hash,
        layers_hash_map,
        markers_hash_map,
        shapes_hash_map,
    )
    .map_err(|_e| {
        return AppError::InternalServerError;
    })?;

    // 発行済みの共有URLを更新処理
    if payload.update_url && is_issued {
        let update_url_response = update_temporary_url(&pool, temp_url).await?;
        Ok(Json(update_url_response))
    // 新規共有URL発行
    } else {
        // 既存データがあれば削除
        if is_issued {
            delete_temporary_url(&pool, user_id).await?;
        }

        let created_url_response = create_temporary_url(&pool, temp_url).await?;
        Ok(Json(created_url_response))
    }
}

//　現在の共有URLを取得するハンドラ
pub async fn current_url_handler(
    Extension(user_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<CurrentTemporaryUrlResponse>, AppError> {
    let current_url = query_as!(
        CurrentTemporaryUrlResponse,
        r#"
        SELECT id, url, expiration, password_hash IS NOT NULL as "is_password_protected: bool"
        FROM temporary_urls
        WHERE user_id = $1
        ORDER BY create_at DESC
        LIMIT 1
        "#,
        user_id
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let Some(current_url) = current_url else {
        return Err(AppError::NotFound);
    };

    if is_expired(&current_url.expiration.as_str()) {
        delete_temporary_url(&pool, user_id).await?;
        return Err(AppError::NotFound);
    }

    Ok(Json(current_url))
}

pub fn is_expired(expiration: &str) -> bool {
    // SQLite での文字列から日付型に戻す
    let expiration = NaiveDateTime::parse_from_str(expiration, "%Y-%m-%d %H:%M:%S%.f");
    match expiration {
        Ok(exp) => exp < Utc::now().naive_utc(),
        Err(_e) => false,
    }
}

// 新規共有URL作成ヘルパー関数
async fn create_temporary_url(
    pool: &SqlitePool,
    temporary_url: TemporaryUrl,
) -> Result<CreateUpdatedTemporaryUrlResponse, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let json_layers_data =
        serde_json::to_value(temporary_url.layers).map_err(|_| AppError::InternalServerError)?;
    let json_markers_data =
        serde_json::to_value(temporary_url.markers).map_err(|_| AppError::InternalServerError)?;
    let json_shapes_data =
        serde_json::to_value(temporary_url.shapes).map_err(|_| AppError::InternalServerError)?;
    let created_url_response = query_as!(
        CreateUpdatedTemporaryUrlResponse,
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
            create_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, url, expiration
        "#,
        temporary_url.id,
        temporary_url.user_id,
        temporary_url.url,
        temporary_url.expiration,
        temporary_url.password_hash,
        json_layers_data,
        json_markers_data,
        json_shapes_data,
        now,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;
    Ok(created_url_response)
}

// 既存共有URL更新ヘルパー関数
async fn update_temporary_url(
    pool: &SqlitePool,
    temporary_url: TemporaryUrl,
) -> Result<CreateUpdatedTemporaryUrlResponse, AppError> {
    let json_layers_data =
        serde_json::to_value(temporary_url.layers).map_err(|_| AppError::InternalServerError)?;
    let json_markers_data =
        serde_json::to_value(temporary_url.markers).map_err(|_| AppError::InternalServerError)?;
    let json_shapes_data =
        serde_json::to_value(temporary_url.shapes).map_err(|_| AppError::InternalServerError)?;
    let updated_url_response = query_as!(
        CreateUpdatedTemporaryUrlResponse,
        r#"
        UPDATE temporary_urls
        SET expiration = $1, password_hash = $2, layers = $3, markers = $4, shapes = $5
        WHERE user_id = $6
        RETURNING id, url, expiration
        "#,
        temporary_url.expiration,
        temporary_url.password_hash,
        json_layers_data,
        json_markers_data,
        json_shapes_data,
        temporary_url.user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;
    Ok(updated_url_response)
}

// 図形のハッシュマップを取得するヘルパー関数
async fn get_shapes_hash_map(
    pool: &SqlitePool,
    user_id: String,
    layer_ids: Vec<String>,
) -> Result<HashMap<String, ShapeObject>, AppError> {
    if layer_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = layer_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("${}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");

    let shapes_sql = format!(
        "SELECT id, user_id, layer_id, shape_type, name, geojson, created_at, updated_at FROM shape_model WHERE user_id = $1 AND layer_id IN ({}) ORDER BY created_at ASC",
        placeholders
    );

    let shapes = sqlx::query_as::<_, ShapeObject>(&shapes_sql).bind(&user_id);

    let mut shapes_query = shapes;
    for id in &layer_ids {
        shapes_query = shapes_query.bind(id);
    }

    let shapes = shapes_query.fetch_all(pool).await.map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(vec_to_hashmap(shapes, |s| s.id.clone()))
}

// マーカーのハッシュマップを取得するヘルパー関数
async fn get_markers_hash_map(
    pool: &SqlitePool,
    user_id: String,
    layer_ids: Vec<String>,
) -> Result<HashMap<String, MarkerObjectFromRow>, AppError> {
    let placeholders = layer_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("${}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");

    let markers_sql = format!(
        "SELECT id, layer_id, marker_name, latitude, longitude, detail FROM marker_info_model WHERE user_id = $1 AND layer_id IN ({})",
        placeholders
    );
    let mut markers_query = sqlx::query_as::<_, MarkerObjectFromRow>(&markers_sql).bind(&user_id);
    for id in &layer_ids {
        markers_query = markers_query.bind(id);
    }
    let markers: Vec<MarkerObjectFromRow> = markers_query.fetch_all(pool).await.map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());
    Ok(markers_hash_map)
}

// レイヤのハッシュマップを取得するヘルパー関数
async fn get_layer_hash_map(
    pool: &SqlitePool,
    user_id: String,
    layer_ids: Vec<String>,
) -> Result<HashMap<String, LayerObjectFromRow>, AppError> {
    let placeholders = layer_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("${}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");

    // レイヤ取得（パラメータバインド使用）
    // SQLite では　ANY が使えないため IN を使用
    let layers_sql = format!(
        "SELECT id, user_id, layer_name, is_master FROM layer_model WHERE user_id = $1 AND id IN ({})",
        placeholders
    );
    let mut layers_query = sqlx::query_as::<_, LayerObjectFromRow>(&layers_sql).bind(&user_id);
    for id in &layer_ids {
        layers_query = layers_query.bind(id);
    }
    let layers: Vec<LayerObjectFromRow> = layers_query.fetch_all(pool).await.map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let layers_hash_map = vec_to_hashmap(layers, |l| l.id.clone());
    Ok(layers_hash_map)
}

// 既存共有URLを削除するヘルパー関数（ユーザーは一つの共有URLしか持っていないため、user_idだけで削除）
async fn delete_temporary_url(pool: &SqlitePool, user_id: String) -> Result<(), AppError> {
    let _result = query!(
        r#"
        DELETE FROM temporary_urls
        WHERE user_id = $1
        "#,
        user_id
    )
    .execute(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    Ok(())
}

//     // マーカー取得（パラメータバインド使用）
//     // SQLite では　ANY が使えないため IN を使用
//     let layer_ids: Vec<String> = payload.layers.clone();

//     let placeholders = layer_ids
//         .iter()
//         .enumerate()
//         .map(|(i, _)| format!("${}", i + 2))
//         .collect::<Vec<_>>()
//         .join(", ");

//     let markers_sql = format!(
//         "SELECT id, layer_id, marker_name, latitude, longitude, detail FROM marker_info_model WHERE user_id = $1 AND layer_id IN ({})",
//         placeholders
//     );
//     let mut markers_query = sqlx::query_as::<_, MarkerObjectFromRow>(&markers_sql).bind(&user_id);
//     for id in &layer_ids {
//         markers_query = markers_query.bind(id);
//     }
//     let markers: Vec<MarkerObjectFromRow> = markers_query.fetch_all(&pool).await.map_err(|e| {
//         tracing::error!(error = %e, "database error.");
//         AppError::Sqlx(e)
//     })?;

//     let markers_hash_map = vec_to_hashmap(markers, |m| m.id.clone());

//     // レイヤ取得（パラメータバインド使用）
//     // SQLite では　ANY が使えないため IN を使用
//     let layers_sql = format!(
//         "SELECT id, user_id, layer_name, is_master FROM layer_model WHERE user_id = $1 AND id IN ({})",
//         placeholders
//     );
//     let mut layers_query = sqlx::query_as::<_, LayerObjectFromRow>(&layers_sql).bind(&user_id);
//     for id in &layer_ids {
//         layers_query = layers_query.bind(id);
//     }
//     let layers: Vec<LayerObjectFromRow> = layers_query.fetch_all(&pool).await.map_err(|e| {
//         tracing::error!(error = %e, "database error.");
//         AppError::Sqlx(e)
//     })?;

//     let json_layers_data =
//         serde_json::to_value(temp_url.layers).map_err(|_| AppError::InternalServerError)?;

//     let json_markers_data =
//         serde_json::to_value(temp_url.markers).map_err(|_| AppError::InternalServerError)?;

//     let created_url_response = sqlx::query_as!(
//         CreatedTemporaryUrlResponse,
//         r#"
//         INSERT INTO temporary_urls (
//             id,
//             user_id,
//             url,
//             expiration,
//             layers,
//             markers,
//             create_at
//         )
//         VALUES ($1, $2, $3, $4, $5, $6, $7)
//         RETURNING id, url, expiration
//         "#,
//         temp_url.id,
//         temp_url.user_id,
//         temp_url.url,
//         temp_url.expiration,
//         json_layers_data,
//         json_markers_data,
//         now,
//     )
//     .fetch_one(&pool)
//     .await
//     .map_err(|e| {
//         tracing::error!(error = %e, "database error.");
//         AppError::Sqlx(e)
//     })?;
//     Ok(Json(created_url_response))
// }

// 一時URLからmapを取得
pub async fn temporary_map_get_handler(
    headers: HeaderMap,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    url_id: Result<Path<String>, PathRejection>,
) -> Result<impl IntoResponse, AppError> {
    // User-Agent取り出し
    let user_agent = headers.get("user-agent").and_then(|ua| ua.to_str().ok());

    // User-Agentにmobileという文字が含まれているか確認
    let is_mobile = user_agent.map_or(false, |ua| ua.contains("Mobile"));

    // notfound.html用
    let viewport_content = if is_mobile { "0.7" } else { "1.0" };

    match url_id {
        // 正常な UUID が渡された場合
        Ok(Path(url_id)) => {
            let render_html = if is_mobile {
                "temporary-map-mobile.html"
            } else {
                "temporary-map.html"
            };

            let temp_url = sqlx::query_as!(
                TemporaryUrlFromDB,
                "SELECT * FROM temporary_urls WHERE id = $1",
                url_id
            )
            .fetch_one(&pool)
            .await;

            match temp_url {
                // DBから共有URLの取得に成功した場合
                Ok(temp_url) => {
                    // 共有URLが期限切れの場合
                    if temp_url.is_expired() {
                        query!("DELETE FROM temporary_urls WHERE id = $1", url_id)
                            .execute(&pool)
                            .await
                            .map_err(|_| AppError::InternalServerError)?;
                        return render_not_found_page(&tera, viewport_content).await;
                    } else if temp_url.password_hash.is_some() {
                        return render_password_required_page(&tera, viewport_content, None).await;
                    // 正常に 共有URLを返却できる場合
                    } else {
                        return render_temporary_map_page(&pool, &tera, render_html, temp_url)
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

    let temp_url = query_as!(
        TemporaryUrlFromDB,
        "SELECT * FROM temporary_urls WHERE id = $1",
        url_id
    )
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
        query!("DELETE FROM temporary_urls WHERE id = $1", url_id)
            .execute(&pool)
            .await
            .map_err(|_| AppError::InternalServerError)?;
        return render_not_found_page(&tera, viewport_content).await;
    }

    // パスワードが設定されている場合、認証を行う
    let Some(password_hash) = temp_url.password_hash.as_deref() else {
        // パスワードが設定されていない場合は直接表示
        return render_temporary_map_page(&pool, &tera, render_html, temp_url).await;
    };

    // パスワードが正しいか検証
    let is_valid = verify(&form.password, password_hash).unwrap_or(false);
    // パスワードが正しくない場合はメッセージを付けて認証ページを表示
    if !is_valid {
        return render_password_required_page(
            &tera,
            viewport_content,
            Some("パスワードが正しくありません。"),
        )
        .await;
    }

    // パスワードが正しい場合はマップを表示
    render_temporary_map_page(&pool, &tera, render_html, temp_url).await
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
) -> Result<axum::response::Response, AppError> {
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
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "database error.");
        AppError::Sqlx(e)
    })?;

    let layers = parse_json(&temp_url.layers)?;
    let markers = parse_json(&temp_url.markers)?;
    let shapes = parse_json(&temp_url.shapes)?;
    let tile_servers_hash_map = vec_to_hashmap(tile_servers, |t| t.id);

    let mut context = Context::new();
    context.insert("layers", &layers);
    context.insert("markersObj", &markers);
    context.insert("shapesObj", &shapes);
    context.insert("tileServers", &tile_servers_hash_map);

    let tera = tera.lock().await;
    match tera.render(render_html, &context) {
        Ok(rendered) => Ok(Html(rendered).into_response()),
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
        Ok(rendered) => Ok(Html(rendered).into_response()),
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
) -> Result<axum::response::Response, AppError> {
    let mut context = Context::new();
    context.insert("viewport_content", viewport_content);
    context.insert("error_message", &error_message.unwrap_or(""));

    let tera = tera.lock().await;
    match tera.render("temporary-password.html", &context) {
        Ok(rendered) => Ok(Html(rendered).into_response()),
        Err(e) => {
            tracing::error!("{}", e);
            Err(AppError::InternalServerError)
        },
    }
}
