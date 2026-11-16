//! 確認済みの永続操作。確認内容・所有者・設定版を操作IDに固定し、二重作成を防ぐ。
use super::{
    actions::{AiAction, MapContext},
    settings::AiConfig,
};
use crate::{
    error::AppError,
    handler::{
        ai::{acquire_request, validate_account},
        answer_map_presets::{self, CreatePreset, PresetKind},
        layers::{create_layer_tx, validate_layer_name},
    },
};
use axum::{
    Json,
    extract::{Extension, Path},
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction, types::Json as SqlJson};
use uuid::Uuid;

const DEFINITION_LIMIT: usize = 128 * 1024;
const MAX_PENDING: i64 = 100;
const OPERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WriteAction {
    CreateLayer { name: String },
    SavePreset { name: String, kind: PresetKind },
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppliedState {
    filter: Option<AiAction>,
    color: Option<AiAction>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareRequest {
    operation_id: Uuid,
    #[serde(default)]
    protocol_version: u8,
    revision: Uuid,
    action: WriteAction,
    context: MapContext,
    #[serde(default)]
    state: AppliedState,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitRequest {
    operation_id: Uuid,
    #[serde(default)]
    protocol_version: u8,
    revision: Uuid,
    context: MapContext,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum PreparedAction {
    CreateLayer {
        name: String,
    },
    SavePreset {
        name: String,
        kind: PresetKind,
        definition: AiAction,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedPayload {
    action: PreparedAction,
    context: MapContext,
}

#[derive(sqlx::FromRow)]
struct Operation {
    id: String,
    settings_revision: String,
    request_hash: String,
    payload: SqlJson<PreparedPayload>,
    result: Option<SqlJson<Value>>,
    expires_at: DateTime<Utc>,
}

const SELECT_OWN: &str = r#"
    SELECT
        id,
        settings_revision,
        request_hash,
        payload,
        result,
        expires_at
    FROM ai_operation_model
    WHERE id = $1
        AND user_id = $2
"#;
const SELECT_OWN_LOCKED: &str = r#"
    SELECT
        id,
        settings_revision,
        request_hash,
        payload,
        result,
        expires_at
    FROM ai_operation_model
    WHERE id = $1
        AND user_id = $2
"#;

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.to_owned())
}

fn require_protocol(version: u8) -> Result<(), AppError> {
    if version != 2 {
        return Err(AppError::AiOperationNotAllowed);
    }
    Ok(())
}

fn context(mut context: MapContext) -> Result<MapContext, AppError> {
    if let Some(ids) = &mut context.layer_ids {
        if ids.len() > 64 {
            return Err(invalid("対象レイヤーは重複なしの64件以内にしてください。"));
        }
        ids.sort_unstable();
        if ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid("対象レイヤーは重複なしの64件以内にしてください。"));
        }
    }
    Ok(context)
}

fn normalize(input: PrepareRequest) -> Result<(Uuid, Uuid, PreparedPayload, String), AppError> {
    require_protocol(input.protocol_version)?;
    if input
        .state
        .filter
        .as_ref()
        .is_some_and(|value| !matches!(value, AiAction::Filter { .. }))
        || input
            .state
            .color
            .as_ref()
            .is_some_and(|value| !matches!(value, AiAction::Color { .. }))
    {
        return Err(invalid("適用済み条件の種類が不正です。"));
    }
    let action = match input.action {
        WriteAction::CreateLayer { name } => PreparedAction::CreateLayer {
            name: validate_layer_name(&name)?,
        },
        WriteAction::SavePreset { name, kind } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
                return Err(invalid(
                    "条件名は制御文字を含まない1〜100文字で入力してください。",
                ));
            }
            let mut definition = match kind {
                PresetKind::Filter => input.state.filter,
                PresetKind::Coloring => input.state.color,
            }
            .ok_or_else(|| invalid("保存する適用済み条件がありません。"))?;
            super::assistant::normalize_action(&mut definition);
            definition.validate()?;
            if serde_json::to_vec(&definition)
                .map_err(|_| AppError::InternalServerError)?
                .len()
                > DEFINITION_LIMIT
            {
                return Err(invalid(
                    "保存する条件が大きすぎます。条件を分けてください。",
                ));
            }
            PreparedAction::SavePreset {
                name: name.to_owned(),
                kind,
                definition,
            }
        },
    };
    let payload = PreparedPayload {
        action,
        context: context(input.context)?,
    };
    let bytes = serde_json::to_vec(&json!({"revision":input.revision,"payload":payload}))
        .map_err(|_| AppError::InternalServerError)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    Ok((input.operation_id, input.revision, payload, hash))
}

impl PreparedAction {
    fn preset(&self) -> Result<Option<CreatePreset>, AppError> {
        match self {
            Self::CreateLayer { .. } => Ok(None),
            Self::SavePreset {
                name,
                kind,
                definition,
            } => Ok(Some(CreatePreset {
                name: name.clone(),
                kind: *kind,
                schema_version: 2,
                definition: serde_json::to_value(definition)
                    .map_err(|_| AppError::InternalServerError)?,
            })),
        }
    }

    fn summary(&self) -> Value {
        match self {
            Self::CreateLayer { name } => json!({
                "type":"create_layer","name":name,
                "description":format!("「{name}」のレイヤーを作成します。")
            }),
            Self::SavePreset {
                name,
                kind,
                definition,
            } => json!({
                "type":"save_preset","name":name,"kind":kind,"definition":definition,
                "description":format!("現在適用中の{}を「{name}」として保存します。",
                    if matches!(kind,PresetKind::Filter) {"絞り込み条件"} else {"色分け条件"})
            }),
        }
    }
}

impl Operation {
    fn view(&self) -> Value {
        if let Some(result) = &self.result {
            json!({"operation_id":self.id,"status":"completed","result":result.0})
        } else {
            json!({
                "operation_id":self.id,
                "status":if self.expires_at <= Utc::now() {"expired"} else {"prepared"},
                "summary":self.payload.action.summary(),"expires_at":self.expires_at
            })
        }
    }
}

async fn request_limit(pool: &SqlitePool) -> Result<usize, AppError> {
    // 結果照会は、APIキーの復号やAIの現在の有効状態に依存させない。
    let config: Option<SqlJson<AiConfig>> =
        sqlx::query_scalar("SELECT config FROM ai_settings WHERE id=1")
            .fetch_optional(pool)
            .await?;
    Ok(config
        .map(|config| config.0.max_requests_per_minute)
        .unwrap_or(20))
}

async fn lock_policy(tx: &mut Transaction<'_, Sqlite>, revision: Uuid) -> Result<(), AppError> {
    let row: Option<(String, SqlJson<AiConfig>)> =
        sqlx::query_as("SELECT revision,config FROM ai_settings WHERE id=1")
            .fetch_optional(&mut **tx)
            .await?;
    let (current, config) = row.ok_or(AppError::AiOperationNotAllowed)?;
    if !config.0.enabled || !config.0.write_enabled {
        return Err(AppError::AiOperationNotAllowed);
    }
    if current != revision.to_string() {
        return Err(AppError::Conflict);
    }
    Ok(())
}

async fn lock_user(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let token = crate::middleware::extract_cookie_value(headers, "access_token").unwrap_or("");
    let claims = crate::auth::verify_access_token(token)
        .map_err(|_| AppError::Unauthorized("再ログインしてください。".into()))?;
    if claims.sub != user {
        return Err(AppError::AiAccountConflict);
    }
    let active: bool = sqlx::query_scalar(
        r#"
            SELECT EXISTS(
                SELECT 1
                FROM user_model
                WHERE id = $1
                    AND auth_version = $2
                    AND is_locked = false
            )
            "#,
    )
    .bind(&user)
    .bind(claims.auth_version)
    .fetch_one(&mut **tx)
    .await?;
    if !active {
        return Err(AppError::Unauthorized("再ログインしてください。".into()));
    }
    Ok(())
}

async fn validate_scope_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    context: &MapContext,
) -> Result<(), AppError> {
    if let Some(ids) = &context.layer_ids {
        let count: i64 = sqlx::query_scalar(
            r#"
                SELECT
                    count(*)
                FROM layer_model
                WHERE user_id = $1
                    AND id IN (SELECT value FROM json_each($2))
                "#,
        )
        .bind(&user)
        .bind(serde_json::to_string(ids).unwrap())
        .fetch_one(&mut **tx)
        .await?;
        if count != ids.len() as i64 {
            return Err(AppError::NotFound);
        }
    }
    Ok(())
}

fn reply(value: Value) -> Response {
    ([(CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

pub async fn prepare(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, AppError> {
    validate_account(&user, &headers)?;
    if value
        .get("action")
        .and_then(|a| a.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| !matches!(kind, "create_layer" | "save_preset"))
    {
        return Err(AppError::AiOperationNotAllowed);
    }
    let request: PrepareRequest = serde_json::from_value(value)
        .map_err(|_| invalid("作成・保存の確認要求の形式が不正です。"))?;
    let (id, revision, payload, hash) = normalize(request)?;
    let _permit = acquire_request(&user, request_limit(&pool).await?)?;
    let result = tokio::time::timeout(OPERATION_TIMEOUT, async {
        if let Some(previous) = sqlx::query_as::<_, Operation>(SELECT_OWN)
            .bind(id.to_string())
            .bind(&user)
            .fetch_optional(&pool)
            .await?
        {
            if previous.request_hash != hash {
                return Err(AppError::Conflict);
            }
            if previous.result.is_some() {
                return Ok(previous.view());
            }
        }
        let mut tx = crate::handler::answer_sqlite::begin_write(&pool).await?;
        // BEGIN IMMEDIATEで設定・利用者・操作の確認から結果保存までの書き込みを直列化する。
        lock_policy(&mut tx, revision).await?;
        lock_user(&mut tx, &user, &headers).await?;
        validate_scope_tx(&mut tx, &user, &payload.context).await?;
        sqlx::query(
            r#"
            DELETE FROM ai_operation_model
            WHERE user_id = $1
                AND created_at COLLATE answer_time < datetime('now','-30 days')
            "#,
        )
        .bind(&user)
        .execute(&mut *tx)
        .await?;
        if let Some(previous) = sqlx::query_as::<_, Operation>(SELECT_OWN_LOCKED)
            .bind(id.to_string())
            .bind(&user)
            .fetch_optional(&mut *tx)
            .await?
        {
            if previous.request_hash != hash {
                return Err(AppError::Conflict);
            }
            if previous.result.is_none() && previous.expires_at <= Utc::now() {
                return Err(AppError::Conflict);
            }
            tx.commit().await?;
            return Ok(previous.view());
        }
        if let Some(preset) = payload.action.preset()? {
            answer_map_presets::validate_preset_tx(&mut tx, &user, &preset).await?;
        }
        let pending: i64 = sqlx::query_scalar(
            r#"
            SELECT
                count(*)
            FROM ai_operation_model
            WHERE user_id = $1
                AND result IS NULL
                AND expires_at COLLATE answer_time > CURRENT_TIMESTAMP
            "#,
        )
        .bind(&user)
        .fetch_one(&mut *tx)
        .await?;
        if pending >= MAX_PENDING {
            return Err(AppError::TooManyRequests(
                "未確定の操作が多すぎます。時間を置いて再試行してください。".into(),
            ));
        }
        let expires_at = Utc::now() + Duration::minutes(10);
        let inserted = sqlx::query(
            r#"
            INSERT INTO ai_operation_model (
                id,
                user_id,
                settings_revision,
                request_hash,
                payload,
                expires_at
            ) VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6
            )
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(id.to_string())
        .bind(&user)
        .bind(revision.to_string())
        .bind(hash)
        .bind(SqlJson(payload))
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(AppError::NotFound);
        }
        let operation = sqlx::query_as::<_, Operation>(SELECT_OWN)
            .bind(id.to_string())
            .bind(&user)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(operation.view())
    })
    .await
    .map_err(|_| {
        invalid("操作の確認が時間内に完了しませんでした。結果を確認してから再試行してください。")
    })??;
    Ok(reply(result))
}

pub async fn commit(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, AppError> {
    validate_account(&user, &headers)?;
    let request: CommitRequest =
        serde_json::from_value(value).map_err(|_| invalid("操作の確定要求の形式が不正です。"))?;
    require_protocol(request.protocol_version)?;
    let context = context(request.context)?;
    let _permit = acquire_request(&user, request_limit(&pool).await?)?;
    let result = tokio::time::timeout(OPERATION_TIMEOUT, async {
        let previous = sqlx::query_as::<_, Operation>(SELECT_OWN)
            .bind(request.operation_id.to_string())
            .bind(&user)
            .fetch_optional(&pool)
            .await?
            .ok_or(AppError::NotFound)?;
        if previous.settings_revision != request.revision.to_string()
            || previous.payload.context.layer_ids != context.layer_ids
        {
            return Err(AppError::Conflict);
        }
        if previous.result.is_some() {
            return Ok(previous.view());
        }
        let mut tx = crate::handler::answer_sqlite::begin_write(&pool).await?;
        lock_policy(&mut tx, request.revision).await?;
        lock_user(&mut tx, &user, &headers).await?;
        let operation = sqlx::query_as::<_, Operation>(SELECT_OWN_LOCKED)
            .bind(request.operation_id.to_string())
            .bind(&user)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
        if operation.settings_revision != request.revision.to_string()
            || operation.payload.context.layer_ids != context.layer_ids
        {
            return Err(AppError::Conflict);
        }
        if operation.result.is_some() {
            tx.commit().await?;
            return Ok(operation.view());
        }
        if operation.expires_at <= Utc::now() {
            return Err(AppError::Conflict);
        }
        validate_scope_tx(&mut tx, &user, &operation.payload.context).await?;
        let result = match &operation.payload.action {
            PreparedAction::CreateLayer { name } => {
                let id = create_layer_tx(&mut tx, &user, name).await?;
                json!({"type":"create_layer","id":id,"name":name})
            },
            PreparedAction::SavePreset { name, kind, .. } => {
                let preset = answer_map_presets::create_preset_tx(
                    &mut tx,
                    &user,
                    operation
                        .payload
                        .action
                        .preset()?
                        .ok_or(AppError::InternalServerError)?,
                )
                .await?;
                json!({"type":"save_preset","id":preset.id,"name":name,"kind":kind})
            },
        };
        sqlx::query(
            r#"
            UPDATE ai_operation_model
            SET
                result = $1,
                completed_at = CURRENT_TIMESTAMP
            WHERE id = $2
                AND user_id = $3
            "#,
        )
        .bind(SqlJson(&result))
        .bind(&operation.id)
        .bind(&user)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        // commit後の設定変更で成功を失敗扱いにしない。結果は同一トランザクションに記録済み。
        Ok(json!({"operation_id":operation.id,"status":"completed","result":result}))
    })
    .await
    .map_err(|_| {
        invalid("操作の応答が時間内に完了しませんでした。操作IDから結果を確認してください。")
    })??;
    Ok(reply(result))
}

pub async fn status(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    validate_account(&user, &headers)?;
    let _permit = acquire_request(&user, request_limit(&pool).await?)?;
    let operation = tokio::time::timeout(
        OPERATION_TIMEOUT,
        sqlx::query_as::<_, Operation>(SELECT_OWN)
            .bind(id.to_string())
            .bind(&user)
            .fetch_optional(&pool),
    )
    .await
    .map_err(|_| invalid("操作結果の取得が時間内に完了しませんでした。"))??
    .ok_or(AppError::NotFound)?;
    Ok(reply(operation.view()))
}
