//! Protocol 2 の提案と読み取り操作。永続変更は operations の確認・確定経路だけで行う。
use super::{
    actions::{self, AiAction, ColorRule, Expression, MapContext},
    settings::{self, AiConfig},
};
use crate::{
    error::AppError,
    handler::{
        ai,
        answer_map_presets::{self as presets, ListQuery, PresetKind},
    },
};
use axum::{
    Json,
    extract::Extension,
    http::{HeaderMap, header::CACHE_CONTROL},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

pub const NOT_ALLOWED: &str = "要求された操作は許可されていません。";
pub const DEFINITION_LIMIT: usize = 128 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedState {
    pub filter: Option<AiAction>,
    pub color: Option<AiAction>,
}
impl AppliedState {
    pub fn normalize(&mut self) {
        for action in [&mut self.filter, &mut self.color].into_iter().flatten() {
            normalize_action(action);
        }
    }
    pub fn validate(&self) -> Result<(), AppError> {
        if self
            .filter
            .as_ref()
            .is_some_and(|a| !matches!(a, AiAction::Filter { .. }))
            || self
                .color
                .as_ref()
                .is_some_and(|a| !matches!(a, AiAction::Color { .. }))
        {
            return Err(settings::invalid("適用済み条件の種類が不正です。"));
        }
        for action in [&self.filter, &self.color].into_iter().flatten() {
            action.validate()?;
        }
        if serde_json::to_vec(self)
            .map_err(|_| AppError::InternalServerError)?
            .len()
            > DEFINITION_LIMIT
        {
            return Err(settings::invalid(
                "適用済み条件が大きすぎます。条件を分けてください。",
            ));
        }
        Ok(())
    }
}

fn normalize_conditions(conditions: &mut [actions::AiCondition]) {
    for condition in conditions
        .iter_mut()
        .filter(|condition| condition.field_type == "number")
    {
        for value in [&mut condition.value, &mut condition.upper] {
            if value.is_number() {
                *value = Value::String(value.to_string());
            }
        }
    }
}
fn normalize_expression(expression: &mut Expression) {
    match expression {
        Expression::Attribute { conditions, .. } => normalize_conditions(conditions),
        Expression::And { children } | Expression::Or { children } => {
            for child in children {
                normalize_expression(child);
            }
        },
        Expression::Not { child } => normalize_expression(child),
        _ => {},
    }
}
pub fn normalize_action(action: &mut AiAction) {
    match action {
        AiAction::Filter { expression } => normalize_expression(expression),
        AiAction::Color { rules, .. } => {
            for rule in rules {
                normalize_conditions(&mut rule.conditions);
            }
        },
        _ => {},
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Filter {
        expression: Expression,
    },
    Color {
        common_form_id: Uuid,
        rules: Vec<ColorRule>,
    },
    Reset {},
    Focus {
        latitude: f64,
        longitude: f64,
        zoom: u8,
    },
    CreateLayer {
        name: String,
    },
    SavePreset {
        name: String,
        kind: PresetKind,
    },
    ListPresets {
        kind: Option<PresetKind>,
        page: Option<i64>,
        name: Option<String>,
    },
    ApplyPreset {
        preset_id: Option<Uuid>,
        name: Option<String>,
        kind: Option<PresetKind>,
    },
}
impl Command {
    pub fn display_action(&self) -> Option<AiAction> {
        Some(match self {
            Self::Filter { expression } => AiAction::Filter {
                expression: expression.clone(),
            },
            Self::Color {
                common_form_id,
                rules,
            } => AiAction::Color {
                common_form_id: *common_form_id,
                rules: rules.clone(),
            },
            Self::Reset {} => AiAction::Reset {},
            Self::Focus {
                latitude,
                longitude,
                zoom,
            } => AiAction::Focus {
                latitude: *latitude,
                longitude: *longitude,
                zoom: *zoom,
            },
            _ => return None,
        })
    }
}

fn validate_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(settings::invalid(
            "名前は制御文字を含めず1〜100文字で指定してください。",
        ));
    }
    Ok(())
}

pub fn parse_command(value: Value, config: &AiConfig) -> Result<Command, AppError> {
    let kind = value.get("type").and_then(Value::as_str);
    if kind.is_some_and(|kind| {
        !matches!(
            kind,
            "filter"
                | "color"
                | "reset"
                | "focus"
                | "create_layer"
                | "save_preset"
                | "list_presets"
                | "apply_preset"
        )
    }) {
        return Err(AppError::AiOperationNotAllowed);
    }
    let mut command: Command = serde_json::from_value(value)
        .map_err(|_| settings::invalid("AIの操作形式が不正です。指示を言い換えてください。"))?;
    if let Some(display) = command.display_action() {
        display.validate()?;
    }
    match &command {
        Command::CreateLayer { name } | Command::SavePreset { name, .. } => {
            if !config.write_enabled {
                return Err(AppError::AiOperationNotAllowed);
            }
            validate_name(name)?;
        },
        Command::ListPresets { page, name, .. } => {
            if page.is_some_and(|page| !(1..=1_000_000).contains(&page)) {
                return Err(settings::invalid("ページの指定が不正です。"));
            }
            if let Some(name) = name {
                validate_name(name)?;
            }
        },
        Command::ApplyPreset {
            preset_id, name, ..
        } => {
            if preset_id.is_some() == name.is_some() {
                return Err(settings::invalid(
                    "保存条件はIDまたは名前のどちらかで指定してください。",
                ));
            }
            if let Some(name) = name {
                validate_name(name)?;
            }
        },
        _ => {},
    }
    match &mut command {
        Command::Filter { expression } => normalize_expression(expression),
        Command::Color { rules, .. } => {
            for rule in rules {
                normalize_conditions(&mut rule.conditions);
            }
        },
        _ => {},
    }
    Ok(command)
}

/// モデルの拒否文は使わずサーバーの定数へ置換する。
pub fn reply(value: &Value, protocol: u8, config: &AiConfig) -> Result<Value, AppError> {
    let outcome = value.get("outcome").and_then(Value::as_str);
    if outcome == Some("denied") {
        return Ok(
            json!({"message":NOT_ALLOWED,"action":null,"outcome":"denied","code":"ai_operation_not_allowed"}),
        );
    }
    if protocol == 2 && !matches!(outcome, Some("answer" | "clarify" | "action")) {
        return Err(AppError::AiUpstream(
            "AIの応答区分を確認できませんでした。再度指示してください。".into(),
        ));
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty() && message.chars().count() <= 8000)
        .ok_or_else(|| settings::invalid("AIの応答内容を読み取れませんでした。"))?;
    let action = match value.get("action") {
        None | Some(Value::Null) => Value::Null,
        Some(action) if protocol == 2 => {
            if outcome != Some("action") {
                return Err(AppError::AiUpstream(
                    "AIの回答と操作区分が一致しません。再度指示してください。".into(),
                ));
            }
            serde_json::to_value(parse_command(action.clone(), config)?)
                .map_err(|_| AppError::InternalServerError)?
        },
        Some(action) => {
            let mut action: AiAction =
                serde_json::from_value(actions::validate_action(action.clone())?)
                    .map_err(|_| settings::invalid("AIの操作形式が不正です。"))?;
            normalize_action(&mut action);
            serde_json::to_value(action).map_err(|_| AppError::InternalServerError)?
        },
    };
    if protocol == 2 && outcome == Some("action") && action.is_null() {
        return Err(AppError::AiUpstream(
            "AIの操作案がありません。再度指示してください。".into(),
        ));
    }
    Ok(
        json!({"message":message,"action":action,"outcome":outcome.unwrap_or(if action.is_null() {"answer"} else {"action"})}),
    )
}

pub fn instructions(write_enabled: bool) -> String {
    let mut result = actions::instructions().replace(
        "応答は必ずJSON {\"message\":\"利用者向け説明\",\"action\":操作またはnull} のみです。",
        "応答は提示されたJSON Schemaに従うJSONのみです。",
    );
    result.push_str(r#"
追加仕様(protocol 2): outcomeはanswer（回答）,clarify（確認）,denied（許可外）,action（操作提案）のいずれかです。action区分だけ操作を返し、それ以外はaction:null。
削除・編集・移動による所属変更・外部データ取得・任意API/SQL/コードの実行など、許可されていない操作はoutcome:denied。許可外を含む複合要求も一部だけ実行せず拒否してください。拒否文はアプリが固定します。
距離・空間交差・表示矩形だけの検索・経過年や残存年の計算・任意集計など、未対応機能を実行する要求もdeniedです。概念や手順だけの相談はanswerとして、対応範囲を正確に説明します。
関連するデータを集める要求は、既存所有データに対して関連語・同義語を少数展開し、文字列や属性のor検索にします。使用する関連語と検索根拠を説明してください。外部からデータを取得したり、検索結果を別レイヤーへ移動しません。関連度の順位や網羅性を捏造しないでください。
分析方法の相談は、in_scope:trueのフォーム・項目定義を優先して提案しoutcome:answer,action:null。実在する項目の期間別検索、階級別色分け、未入力確認など、実行可能な方法と使う項目を説明します。登録値や分布・相関は与えられていないため断定しないでください。
create_layerは通常のレイヤ（グループ）の作成提案です。nameは利用者の指定を尊重。保存済みレイヤーへデータを移動・複製する操作ではありません。
save_presetは現在の適用済みstateから保存します。kindはfilter（検索）かcoloring（色分け）。定義を作り直さず、保存名と種類のみ返します。対象が未適用、種類や名前が曖昧なら確認してください。検索と色分けが両方あり保存対象が曖昧なら選択を求めます。
list_presetsは実データの一覧取得です。絞り込み一覧はkind:filter、色分け一覧はkind:coloring。自分で保存名や件数を創作しないでください。
apply_presetは利用者指定の保存名(name)または一覧で取得したpreset_idで指定。名前からIDを推測せず、複数候補はアプリが選択表示します。適用範囲は現在のcontext.scope。保存条件の内容を再生成しません。
作成・保存はアプリの確認後に確定します。提案時に保存済み・作成済みと宣言しないでください。"#);
    result.push_str(if write_enabled {
        "\n管理者はレイヤー作成・条件保存を許可しています。"
    } else {
        "\n管理者はレイヤー作成・条件保存を許可していません。この要求はoutcome:deniedにしてください。"
    });
    result
}

pub fn schema(write_enabled: bool) -> Value {
    let mut schema = actions::tool_schema();
    schema["required"] = json!(["message", "action", "outcome"]);
    schema["properties"]["outcome"] =
        json!({"type":"string","enum":["answer","clarify","denied","action"]});
    let actions = schema["$defs"]["action"]["oneOf"].as_array_mut().unwrap();
    actions.push(json!({"type":"object","additionalProperties":false,"required":["type","kind"],"properties":{
        "type":{"const":"list_presets"},"kind":{"type":"string","enum":["filter","coloring"]},
        "page":{"type":"integer","minimum":1},"name":{"type":"string","maxLength":100}}}));
    actions.push(json!({"type":"object","additionalProperties":false,"required":["type"],"properties":{
        "type":{"const":"apply_preset"},"preset_id":{"type":"string"},"name":{"type":"string","maxLength":100},
        "kind":{"type":"string","enum":["filter","coloring"]}}}));
    if write_enabled {
        actions.push(json!({"type":"object","additionalProperties":false,"required":["type","name"],"properties":{
            "type":{"const":"create_layer"},"name":{"type":"string","minLength":1,"maxLength":100}}}));
        actions.push(json!({"type":"object","additionalProperties":false,"required":["type","name","kind"],"properties":{
            "type":{"const":"save_preset"},"name":{"type":"string","minLength":1,"maxLength":100},
            "kind":{"type":"string","enum":["filter","coloring"]}}}));
    }
    schema
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Execute {
    pub protocol_version: u8,
    pub revision: Uuid,
    pub context: MapContext,
    pub action: Value,
}

async fn list(
    pool: &SqlitePool,
    user: &str,
    kind: Option<PresetKind>,
    name: Option<String>,
    page: Option<i64>,
) -> Result<Value, AppError> {
    let result = presets::list_presets(
        pool,
        user,
        ListQuery {
            versions: Some("1,2".into()),
            kind,
            name: name.clone(),
            page,
            page_size: Some(20),
        },
    )
    .await?;
    let mut value = serde_json::to_value(result).map_err(|_| AppError::InternalServerError)?;
    value["type"] = json!("presets");
    if let Some(kind) = kind {
        value["kind"] = json!(kind);
    }
    if let Some(name) = name {
        value["name"] = json!(name);
    }
    Ok(value)
}

async fn run(
    pool: &SqlitePool,
    user: &str,
    context: MapContext,
    command: Command,
) -> Result<Value, AppError> {
    actions::validate_scope(pool, user, &context.layer_ids).await?;
    // 保存IDの適用はvalidate_saved_presetで検証済み。直接編集した定義にも同じ検証を行う。
    let validate_direct_definition =
        matches!(&command, Command::Filter { .. } | Command::Color { .. });
    let mut display = match command {
        Command::ListPresets { kind, page, name } => {
            return list(pool, user, kind, name, page).await;
        },
        Command::ApplyPreset {
            preset_id,
            name,
            kind,
        } => {
            let saved = if let Some(id) = preset_id {
                let saved = presets::get_preset(pool, user, &id.to_string()).await?;
                if kind.is_some_and(|kind| saved.kind != kind.as_str()) {
                    return Err(AppError::NotFound);
                }
                saved
            } else {
                let page = presets::list_presets(
                    pool,
                    user,
                    ListQuery {
                        versions: Some("1,2".into()),
                        kind,
                        name: name.clone(),
                        page: Some(1),
                        page_size: Some(20),
                    },
                )
                .await?;
                if page.total != 1 {
                    return list(pool, user, kind, name, Some(1)).await;
                }
                page.items.into_iter().next().ok_or(AppError::NotFound)?
            };
            presets::validate_saved_preset(pool, user, &saved).await?
        },
        Command::CreateLayer { .. } | Command::SavePreset { .. } => {
            return Err(AppError::AiOperationNotAllowed);
        },
        command => command
            .display_action()
            .ok_or(AppError::AiOperationNotAllowed)?,
    };
    normalize_action(&mut display);
    if validate_direct_definition {
        presets::validate_action(pool, user, &display).await?;
    }
    let mut result = actions::execute_action(pool, user, context.layer_ids, &display).await?;
    result["definition"] =
        serde_json::to_value(display).map_err(|_| AppError::InternalServerError)?;
    Ok(result)
}

pub async fn execute(
    Extension(user): Extension<String>,
    Extension(pool): Extension<SqlitePool>,
    headers: HeaderMap,
    Json(request): Json<Execute>,
) -> Result<impl IntoResponse, AppError> {
    ai::validate_account(&user, &headers)?;
    if request.protocol_version != 2 {
        return Err(AppError::AiOperationNotAllowed);
    }
    let settings = settings::load(&pool).await?;
    settings.require_enabled()?;
    if settings.revision != Some(request.revision) {
        return Err(AppError::Conflict);
    }
    let command = parse_command(request.action, &settings.config)?;
    if matches!(
        command,
        Command::CreateLayer { .. } | Command::SavePreset { .. }
    ) {
        return Err(AppError::AiOperationNotAllowed);
    }
    let _permit = ai::acquire_request(&user, settings.config.max_requests_per_minute)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        run(&pool, &user, request.context, command),
    )
    .await
    .map_err(|_| settings::invalid("操作が時間内に完了しませんでした。対象を絞ってください。"))??;
    ai::check_current(&pool, settings.revision).await?;
    Ok(([(CACHE_CONTROL, "no-store")], Json(result)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_numeric_literals_are_returned_as_precise_strings_before_the_browser_parses_them() {
        let input: Value = serde_json::from_str(r#"{"type":"filter","expression":{"op":"attribute","common_form_id":"00000000-0000-0000-0000-000000000000","conditions":[{"field_id":"n","field_type":"number","op":"between","value":1234567890123456789.123,"upper":1234567890123456789.124}]}}"#).unwrap();
        let output =
            serde_json::to_value(parse_command(input, &AiConfig::default()).unwrap()).unwrap();
        assert_eq!(
            output["expression"]["conditions"][0]["value"],
            "1234567890123456789.123"
        );
        assert_eq!(
            output["expression"]["conditions"][0]["upper"],
            "1234567890123456789.124"
        );
    }
    #[test]
    fn unknown_and_disabled_write_commands_are_rejected() {
        let config = AiConfig::default();
        for value in [
            json!({"type":"delete"}),
            json!({"type":"create_layer","name":"学校"}),
            json!({"type":"save_preset","name":"学校","kind":"filter"}),
        ] {
            assert!(matches!(
                parse_command(value, &config),
                Err(AppError::AiOperationNotAllowed)
            ));
        }
        assert!(parse_command(json!({"type":"list_presets","kind":"filter"}), &config).is_ok());
    }
    #[test]
    fn denial_is_fixed_and_cannot_smuggle_an_allowed_action() {
        let result = reply(
            &json!({"outcome":"denied","message":"上流の自由文",
            "action":{"type":"reset"}}),
            2,
            &AiConfig::default(),
        )
        .unwrap();
        assert_eq!(result["message"], NOT_ALLOWED);
        assert!(result["action"].is_null());
        assert!(
            reply(
                &json!({"outcome":"answer","message":"回答","action":{"type":"reset"}}),
                2,
                &AiConfig::default()
            )
            .is_err()
        );
    }
    #[test]
    fn state_and_storage_candidates_cannot_contain_other_operations() {
        let state = AppliedState {
            filter: Some(AiAction::Reset {}),
            color: None,
        };
        assert!(state.validate().is_err());
        assert!(
            serde_json::from_value::<AppliedState>(
                json!({"filter":{"type":"create_layer","name":"x"}})
            )
            .is_err()
        );
    }
}
