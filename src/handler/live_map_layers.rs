use axum::{Json, extract::Extension};
use serde::Serialize;
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};

use crate::{error::AppError, model::MarkerObjectFromRow};

#[derive(Serialize, FromRow)]
pub struct Layer {
    pub id: String,
    pub layer_name: String,
    pub marker_icon_filename: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct Shape {
    id: String,
    layer_id: String,
    shape_type: String,
    name: Option<String>,
    geojson: serde_json::Value,
}

#[derive(Serialize)]
pub struct PublishedLayers {
    layers: Vec<Layer>,
    markers: Vec<MarkerObjectFromRow>,
    shapes: Vec<Shape>,
}

pub async fn candidates(
    Extension(admin_id): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<Vec<Layer>>, AppError> {
    super::live_map::require_superuser(&admin_id, &pool).await?;
    Ok(Json(
        sqlx::query_as::<_, Layer>(
            "SELECT l.id, l.layer_name, i.uuid_filename AS marker_icon_filename
         FROM layer_model l LEFT JOIN marker_icon_model i ON i.id=l.marker_icon_id
         WHERE l.user_id=$1 AND NOT l.is_master ORDER BY l.layer_name, l.id",
        )
        .bind(admin_id)
        .fetch_all(&pool)
        .await?,
    ))
}

// None means that the editor has not changed the publication settings.
pub async fn sync(
    transaction: &mut Transaction<'_, Sqlite>,
    map_id: &str,
    admin_id: &str,
    selection: Option<&[String]>,
) -> Result<(), AppError> {
    let Some(ids) = selection else {
        return Ok(());
    };
    let valid = sqlx::query_scalar::<_, String>(
        "SELECT id FROM layer_model WHERE id IN (SELECT value FROM json_each($1)) AND user_id=$2 AND NOT is_master",
    )
    .bind(serde_json::json!(ids).to_string())
    .bind(admin_id)
    .fetch_all(&mut **transaction)
    .await?;
    if valid.len() != ids.len() {
        return Err(AppError::Validation(
            "自分が所有する master 以外のレイヤを選択してください。".into(),
        ));
    }
    sqlx::query("DELETE FROM live_map_layer WHERE map_id=$1")
        .bind(map_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query("UPDATE live_map SET layers_configured_by=$2 WHERE id=$1")
        .bind(map_id)
        .bind(admin_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query("INSERT INTO live_map_layer(map_id, layer_id) SELECT $1, value FROM json_each($2)")
        .bind(map_id)
        .bind(serde_json::json!(ids).to_string())
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub async fn own_selection(
    pool: &SqlitePool,
    map_id: &str,
    admin_id: &str,
) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT l.id FROM live_map_layer ml JOIN live_map m ON m.id=ml.map_id
         JOIN layer_model l ON l.id=ml.layer_id
         WHERE m.id=$1 AND m.layers_configured_by=$2 AND l.user_id=$2 AND NOT l.is_master
         ORDER BY l.id",
    )
    .bind(map_id)
    .bind(admin_id)
    .fetch_all(pool)
    .await?)
}

pub async fn published(pool: &SqlitePool, public_id: &str) -> Result<PublishedLayers, AppError> {
    // Read a single snapshot, including current object contents, on each page load.
    let mut tx = pool.begin().await?;
    let layers = sqlx::query_as::<_, Layer>(
        r#"
        SELECT l.id, l.layer_name, i.uuid_filename AS marker_icon_filename
        FROM live_map m JOIN live_map_layer ml ON ml.map_id=m.id
        JOIN layer_model l ON l.id=ml.layer_id AND l.user_id=m.layers_configured_by AND NOT l.is_master
        LEFT JOIN marker_icon_model i ON i.id=l.marker_icon_id
        WHERE m.public_id=$1 AND m.revoked_at IS NULL AND julianday(m.expires_at)>julianday('now')
        ORDER BY l.layer_name, l.id
        "#,
    ).bind(public_id).fetch_all(&mut *tx).await?;
    let ids: Vec<String> = layers.iter().map(|l| l.id.clone()).collect();
    let markers = sqlx::query_as::<_, MarkerObjectFromRow>(
        r#"
        SELECT o.id, o.layer_id, o.marker_name, o.latitude, o.longitude, o.detail
        FROM marker_info_model o JOIN layer_model l ON l.id=o.layer_id AND l.user_id=o.user_id
        WHERE l.id IN (SELECT value FROM json_each($1)) ORDER BY o.id
        "#,
    )
    .bind(serde_json::json!(ids).to_string())
    .fetch_all(&mut *tx)
    .await?;
    let shapes = sqlx::query_as::<_, Shape>(
        r#"
        SELECT o.id, o.layer_id, o.shape_type, o.name, o.geojson
        FROM shape_model o JOIN layer_model l ON l.id=o.layer_id AND l.user_id=o.user_id
        WHERE l.id IN (SELECT value FROM json_each($1)) ORDER BY o.id
        "#,
    )
    .bind(serde_json::json!(ids).to_string())
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(PublishedLayers {
        layers,
        markers,
        shapes,
    })
}
