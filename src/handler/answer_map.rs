//! 回答検索と同じ条件で、所有する対象だけを読み取り専用地図へ渡す。
use super::form_answers::{AnswerQuery, build_query, validate};
use crate::{
    error::AppError,
    model::{LayerObject, MarkerObject, ShapeObject, TileServers},
};
use axum::{
    Form,
    extract::Extension,
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};
use tera::{Context, Tera};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct AnswerMapPrintRequest {
    pub parent_origin: String,
    pub request_id: String,
}

/// 印刷の枠だけを返す。対象データは回答地図の確定済みスナップショットから受け取る。
pub async fn answer_map_print_handler(
    Extension(_user): Extension<String>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Form(request): Form<AnswerMapPrintRequest>,
) -> Result<Response, AppError> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        || !reqwest::Url::parse(&request.parent_origin).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.origin().ascii_serialization() == request.parent_origin
        })
    {
        return Err(AppError::Validation("印刷の要求情報が不正です。".into()));
    }
    let mut context = Context::new();
    context.insert("parentOrigin", &request.parent_origin);
    context.insert("requestId", &request.request_id);
    let html = tera
        .lock()
        .await
        .render("form-answer-map-print.html", &context)
        .map_err(|_| AppError::InternalServerError)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Html(html)).into_response())
}

#[derive(Deserialize)]
pub struct AnswerMapRequest {
    pub query: String,
    pub parent_origin: String,
    pub request_id: String,
    #[serde(default)]
    pub analysis: Option<String>,
    #[serde(default)]
    pub initial_view: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct InitialAnswerMapView {
    latitude: f64,
    longitude: f64,
    zoom: f64,
}

fn parse_initial_map_view(raw: Option<&str>) -> Option<InitialAnswerMapView> {
    let view: InitialAnswerMapView = serde_json::from_str(raw?).ok()?;
    (view.latitude.is_finite()
        && (-90.0..=90.0).contains(&view.latitude)
        && view.longitude.is_finite()
        && (-180.0..=180.0).contains(&view.longitude)
        && view.zoom.is_finite()
        && (0.0..=30.0).contains(&view.zoom))
    .then_some(view)
}

#[derive(Debug)]
pub struct AnswerMapData {
    pub answer_count: i64,
    pub target_count: i64,
    pub markers: Vec<MarkerObject>,
    pub shapes: Vec<ShapeObject>,
    pub layers: Vec<LayerObject>,
    pub popup_bodies: HashMap<String, Value>,
}

pub async fn load_answer_map(
    pool: &SqlitePool,
    user: &str,
    q: &AnswerQuery,
) -> Result<AnswerMapData, AppError> {
    validate(q)?;
    let at = q.as_of.unwrap_or_else(Utc::now);
    let mut tx = super::answer_sqlite::begin_read(pool).await?;
    let (answer_count, target_count): (i64, i64) = build_query(user, q, at)
        .push(
            r#"
            SELECT
                count(*),
                count(DISTINCT target_type || ':' || target_id)
            FROM filtered
            "#,
        )
        .build_query_as()
        .fetch_one(&mut *tx)
        .await?;
    if target_count == 0 {
        return Err(AppError::Validation(
            "地図に表示する対象がありません。回答一覧を更新してください。".into(),
        ));
    }
    let markers = build_query(user, q, at)
        .push(
            r#"
            SELECT
                m.id,
                m.layer_id,
                m.marker_name,
                m.latitude,
                m.longitude,
                m.detail,
                m.update_at
            FROM marker_info_model m
            WHERE m.user_id =
            "#,
        )
        .push_bind(user.to_owned())
        .push(
            r#"
            AND m.id IN (
                SELECT
                    target_id
                FROM filtered
                WHERE target_type = 'marker'
            )
            ORDER BY m.id
            "#,
        )
        .build_query_as::<MarkerObject>()
        .fetch_all(&mut *tx)
        .await?;
    let shapes = build_query(user, q, at)
        .push(
            r#"
            SELECT
                s.id,
                s.user_id,
                s.layer_id,
                s.shape_type,
                s.name,
                s.geojson,
                s.created_at,
                s.updated_at
            FROM shape_model s
            WHERE s.user_id =
            "#,
        )
        .push_bind(user.to_owned())
        .push(
            r#"
            AND s.id IN (
                SELECT
                    target_id
                FROM filtered
                WHERE target_type = 'shape'
            )
            ORDER BY s.id
            "#,
        )
        .build_query_as::<ShapeObject>()
        .fetch_all(&mut *tx)
        .await?;
    let layer_ids = markers
        .iter()
        .filter_map(|m| m.layer_id.clone())
        .chain(shapes.iter().map(|s| s.layer_id.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let layers = sqlx::query_as::<_, LayerObject>(
        r#"
        SELECT
            l.id,
            l.user_id,
            l.layer_name,
            l.is_master,
            l.restrict_free_text,
            l.marker_icon_id,
            i.uuid_filename AS marker_icon_filename
        FROM layer_model l
        LEFT JOIN marker_icon_model i ON i.id = l.marker_icon_id
        WHERE l.user_id = $1
            AND l.id IN (SELECT value FROM json_each($2))
        ORDER BY l.id
        "#,
    )
    .bind(user)
    .bind(json!(layer_ids))
    .fetch_all(&mut *tx)
    .await?;
    let popup_targets: Vec<_> = markers
        .iter()
        .map(|m| ("marker", m.id.clone(), m.detail.clone()))
        .chain(shapes.iter().map(|s| {
            (
                "shape",
                s.id.clone(),
                s.geojson
                    .pointer("/properties/memo")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        }))
        .collect();
    let popup_bodies =
        super::marker_forms::answer_edit::popup_bodies(&mut tx, user, &popup_targets).await?;
    tx.commit().await?;
    Ok(AnswerMapData {
        answer_count,
        target_count,
        markers,
        shapes,
        layers,
        popup_bodies,
    })
}

pub async fn answer_map_handler(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    Extension(tera): Extension<Arc<Mutex<Tera>>>,
    Form(request): Form<AnswerMapRequest>,
) -> Result<Response, AppError> {
    let mut context = Context::new();
    context.insert("parentOrigin", &request.parent_origin);
    context.insert("requestId", &request.request_id);
    let result = async {
        let mut q: AnswerQuery = serde_json::from_str(&request.query)
            .map_err(|_|AppError::Validation("地図の検索条件が不正です。".into()))?;
        q.as_of = Some(q.as_of.unwrap_or_else(Utc::now));
        let data = load_answer_map(&pool,&user,&q).await?;
        let targets: Vec<String> = data.markers.iter().map(|m|format!("marker:{}",m.id))
            .chain(data.shapes.iter().map(|s|format!("shape:{}",s.id))).collect();
        let tiles = sqlx::query_as::<_,TileServers>(
            r#"
            SELECT
                *
            FROM tileserver_model
            "#,
        ).fetch_all(&pool).await?;
        let mut layers: HashMap<String,Value> = data.layers.into_iter().map(|l|(l.id.to_string(),json!(l))).collect();
        let markers: HashMap<String,Value> = data.markers.into_iter().filter(|m|m.latitude.is_finite() && m.longitude.is_finite() && m.latitude.abs()<=90.0 && m.longitude.abs()<=180.0).map(|mut m| {
            let layer = m.layer_id.unwrap_or_else(|| Uuid::nil().to_string());
            layers.entry(layer.to_string()).or_insert_with(||json!({"id":layer,"layer_name":"レイヤなし","is_master":false}));
            m.layer_id=Some(layer);
            (m.id.to_string(),json!(m))
        }).collect();
        for shape in &data.shapes {
            layers.entry(shape.layer_id.to_string()).or_insert_with(||json!({"id":shape.layer_id,"layer_name":"レイヤなし","is_master":false}));
        }
        context.insert("tileServers", &tiles.into_iter().map(|t|(t.id.to_string(),t)).collect::<HashMap<_,_>>());
        context.insert("tileOverlays", &super::tile_overlays::selected_tiles(&pool,&user).await?);
        context.insert("tileVisibilityAccountId", &user);
        context.insert("geocoderCsis", &crate::config::CONFIG.geocoder.uses_csis());
        context.insert("is_cluster", &true);
        context.insert("latitude", &37.65);
        context.insert("longitude", &138.0);
        context.insert("zoom", &6);
        context.insert("layersFromAxum", &layers);
        context.insert("markersFromAxum", &markers);
        context.insert("shapesFromAxum", &data.shapes);
        context.insert("popupBodies", &data.popup_bodies);
        let mut preview = json!({"answerCount":data.answer_count,"targetCount":data.target_count,"parentOrigin":request.parent_origin,"requestId":request.request_id,"query":q,"targets":targets});
        if let Some(view) = parse_initial_map_view(request.initial_view.as_deref()) {
            preview["initialView"] = json!(view);
        }
        context.insert("answerPreview", &preview);
        Ok::<_,AppError>(())
    }.await;
    let (template, status) = match result {
        Ok(()) => {
            context = super::answer_map_transport::encode_context(context)
                .map_err(|_| AppError::InternalServerError)?;
            ("form-answer-map.html", StatusCode::OK)
        },
        Err(error) => {
            let (message, status) = match error {
                AppError::Validation(message) => (message, StatusCode::BAD_REQUEST),
                other => {
                    tracing::error!(error=%other,"answer map failed");
                    (
                        "地図を読み込めませんでした。もう一度お試しください。".into(),
                        StatusCode::INTERNAL_SERVER_ERROR,
                    )
                },
            };
            context.insert("message", &message);
            ("form-answer-map-error.html", status)
        },
    };
    let html = tera
        .lock()
        .await
        .render(template, &context)
        .map_err(|error| {
            tracing::error!(%error,"answer map rendering failed");
            AppError::InternalServerError
        })?;
    Ok((status, [(header::CACHE_CONTROL, "no-store")], Html(html)).into_response())
}

#[cfg(test)]
mod initial_map_view_tests {
    use super::*;

    #[test]
    fn accepts_center_and_zoom_from_the_parent_map() {
        let raw = json!({"latitude": 35.6812, "longitude": 139.7671, "zoom": 14.5});
        let view = parse_initial_map_view(Some(&raw.to_string())).unwrap();
        assert_eq!(json!(view), raw);
    }

    #[test]
    fn ignores_missing_or_invalid_views() {
        assert!(parse_initial_map_view(None).is_none());
        for raw in [
            "",
            "not-json",
            r#"{"latitude":91,"longitude":139,"zoom":10}"#,
            r#"{"latitude":35,"longitude":181,"zoom":10}"#,
            r#"{"latitude":35,"longitude":139,"zoom":31}"#,
            r#"{"latitude":"35","longitude":139,"zoom":10}"#,
            r#"{"latitude":35,"longitude":139}"#,
        ] {
            assert!(parse_initial_map_view(Some(raw)).is_none(), "{raw}");
        }
    }
}
