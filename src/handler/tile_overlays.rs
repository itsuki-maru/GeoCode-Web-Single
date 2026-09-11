use crate::{error::AppError, handler::live_map::require_superuser};
use axum::{
    Json,
    extract::{Extension, Path},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct TileOverlay {
    pub id: String,
    pub name: String,
    pub url: String,
    pub attribution: String,
    pub min_zoom: i32,
    pub max_zoom: i32,
    pub opacity: f64,
    pub sort_order: i32,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct TileOverlayInput {
    name: String,
    url: String,
    attribution: String,
    min_zoom: i32,
    max_zoom: i32,
    opacity: f64,
    sort_order: i32,
    enabled: bool,
}

impl TileOverlayInput {
    fn validate(&self) -> Result<(), AppError> {
        let url = self.url.trim();
        let expanded = url
            .replace("{z}", "0")
            .replace("{x}", "0")
            .replace("{y}", "0");
        let parsed = reqwest::Url::parse(&expanded).ok();
        if self.name.trim().is_empty()
            || self.name.chars().count() > 100
            || self.attribution.chars().count() > 1000
            || url.len() > 4096
            || !["{z}", "{x}", "{y}"]
                .iter()
                .all(|token| url.contains(token))
            || expanded.contains(['{', '}'])
            || !parsed.is_some_and(|u| {
                u.scheme() == "https"
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.fragment().is_none()
            })
            || !(0..=22).contains(&self.min_zoom)
            || !(self.min_zoom..=22).contains(&self.max_zoom)
            || !self.opacity.is_finite()
            || !(0.0..=1.0).contains(&self.opacity)
        {
            return Err(AppError::Validation(
                "表示名、HTTPSタイルURL（{z}/{x}/{y}）、ズーム範囲、不透明度を確認してください。"
                    .into(),
            ));
        }
        Ok(())
    }
}

pub async fn selected_tiles(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<Vec<TileOverlay>, AppError> {
    Ok(sqlx::query_as::<_, TileOverlay>(
        r#"
        SELECT t.* FROM tile_overlay_model t
        JOIN user_tile_overlay_model u
        ON u.tile_overlay_id = t.id
        WHERE u.user_id = $1 AND t.enabled
        ORDER BY t.sort_order, t.name, t.id"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?)
}

pub async fn admin_list(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<Vec<TileOverlay>>, AppError> {
    require_superuser(&user, &pool).await?;
    Ok(Json(
        sqlx::query_as::<_, TileOverlay>(
            "SELECT * FROM tile_overlay_model ORDER BY sort_order, name, id",
        )
        .fetch_all(&pool)
        .await?,
    ))
}

pub async fn admin_create(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Json(input): Json<TileOverlayInput>,
) -> Result<Json<TileOverlay>, AppError> {
    require_superuser(&user, &pool).await?;
    input.validate()?;
    Ok(Json(
        sqlx::query_as::<_, TileOverlay>(
            r#"
        INSERT INTO tile_overlay_model (
            id,
            name,
            url,
            attribution,
            min_zoom,
            max_zoom,
            opacity,
            sort_order,
            enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
        "#,
        )
        .bind(Uuid::now_v7().to_string())
        .bind(input.name.trim())
        .bind(input.url.trim())
        .bind(input.attribution.trim())
        .bind(input.min_zoom)
        .bind(input.max_zoom)
        .bind(input.opacity)
        .bind(input.sort_order)
        .bind(input.enabled)
        .fetch_one(&pool)
        .await?,
    ))
}

pub async fn admin_update(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
    Json(input): Json<TileOverlayInput>,
) -> Result<Json<TileOverlay>, AppError> {
    require_superuser(&user, &pool).await?;
    input.validate()?;
    let tile = sqlx::query_as::<_, TileOverlay>(
        r#"
        UPDATE tile_overlay_model
        SET
          name=$2,
          url=$3,
          attribution=$4,
          min_zoom=$5,
          max_zoom=$6,
          opacity=$7,
          sort_order=$8,
          enabled=$9,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
        RETURNING *"#,
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(input.url.trim())
    .bind(input.attribution.trim())
    .bind(input.min_zoom)
    .bind(input.max_zoom)
    .bind(input.opacity)
    .bind(input.sort_order)
    .bind(input.enabled)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(tile))
}

pub async fn admin_delete(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_superuser(&user, &pool).await?;
    sqlx::query("DELETE FROM tile_overlay_model WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await?;
    Ok(Json(serde_json::json!({"message":"Deleted"})))
}

#[derive(Serialize)]
pub struct TileChoices {
    available: Vec<TileOverlay>,
    selected: Vec<String>,
}

pub async fn user_list(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
) -> Result<Json<TileChoices>, AppError> {
    let available = sqlx::query_as::<_, TileOverlay>(
        r#"
        SELECT * FROM tile_overlay_model
        WHERE enabled
        ORDER BY sort_order, name, id
        "#,
    )
    .fetch_all(&pool)
    .await?;
    let selected = sqlx::query_scalar(
        r#"
            SELECT tile_overlay_id
            FROM user_tile_overlay_model WHERE user_id=$1
            "#,
    )
    .bind(&user)
    .fetch_all(&pool)
    .await?;
    Ok(Json(TileChoices {
        available,
        selected,
    }))
}

#[derive(Deserialize)]
pub struct SelectionInput {
    selected: bool,
}

pub async fn user_select(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
    Json(input): Json<SelectionInput>,
) -> Result<Json<Vec<TileOverlay>>, AppError> {
    if input.selected {
        // Acquire SQLite's write lock before checking the definition. This serializes
        // selection with disabling/deleting and avoids upgrading a read transaction.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let enabled: Option<bool> =
            sqlx::query_scalar("SELECT enabled FROM tile_overlay_model WHERE id=$1")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;
        if enabled != Some(true) {
            return Err(AppError::NotFound);
        }
        sqlx::query(
            "INSERT INTO user_tile_overlay_model (user_id, tile_overlay_id) VALUES($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(&user)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    } else {
        sqlx::query("DELETE FROM user_tile_overlay_model WHERE user_id=$1 AND tile_overlay_id=$2")
            .bind(&user)
            .bind(id)
            .execute(&pool)
            .await?;
    }
    Ok(Json(selected_tiles(&pool, &user).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> TileOverlayInput {
        TileOverlayInput {
            name: "洪水".into(),
            url: "https://example.com/{z}/{x}/{y}.png".into(),
            attribution: String::new(),
            min_zoom: 0,
            max_zoom: 18,
            opacity: 0.7,
            sort_order: 0,
            enabled: true,
        }
    }
    #[test]
    fn validates_template_and_options() {
        assert!(input().validate().is_ok());
        for url in [
            "http://example.com/{z}/{x}/{y}.png",
            "https://example.com/map",
            "https://example.com/{z}/{x}/{y}/{s}.png",
            "https://user:secret@example.com/{z}/{x}/{y}.png",
        ] {
            let mut p = input();
            p.url = url.into();
            assert!(p.validate().is_err());
        }
        let mut p = input();
        p.min_zoom = 19;
        assert!(p.validate().is_err());
        let mut p = input();
        p.opacity = 1.1;
        assert!(p.validate().is_err());
    }
}
