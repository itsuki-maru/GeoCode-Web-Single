import {
  answerConditionOperations,
  answerFieldKey,
  type AnswerColorSpecification,
  type AnswerConditionRow,
  type AnswerField,
  type AnswerMapFilter,
} from "./answer-coloring";

export type MapPresetDraft =
  | { kind: "filter"; definition: AnswerMapFilter }
  | { kind: "coloring"; definition: AnswerColorSpecification };

export type SavedMapPreset = MapPresetDraft & {
  id: string;
  name: string;
  schema_version: 1;
  display: {
    form_label: string | null;
    fields: { id: string; field_type: string; label: string }[];
  };
  create_at: string;
};

export interface MapPresetPage {
  items: SavedMapPreset[];
  total: number;
  page: number;
  page_size: number;
}

const supported = new Set(["text", "textarea", "number", "date", "select", "radio", "checkbox"]);
const noValue = new Set(["empty", "filled", "missing"]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 5000): value is string =>
  typeof value === "string" && value.length <= max;
const formId = (value: unknown): value is string => text(value, 128) && !!value.trim();

function validateConditions(value: unknown): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10) throw Error("回答条件は10件以内にしてください。");
  for (const condition of value) {
    if (
      !record(condition) ||
      !text(condition.field_id, 40) ||
      !/^[a-zA-Z0-9_]+$/.test(condition.field_id) ||
      typeof condition.field_type !== "string" ||
      !supported.has(condition.field_type) ||
      !answerConditionOperations(condition.field_type).some(
        (operation) => operation.value === condition.op,
      )
    )
      throw Error("保存された検索条件に不正な入力項目または比較方法があります。");
    if (noValue.has(String(condition.op))) continue;
    if (condition.field_type === "checkbox") {
      if (typeof condition.value !== "boolean")
        throw Error("はい／いいえの条件を確認してください。");
    } else if (condition.field_type === "select" || condition.field_type === "radio") {
      if (
        !Array.isArray(condition.value) ||
        !condition.value.length ||
        condition.value.length > 100 ||
        condition.value.some((item) => !text(item))
      )
        throw Error("選択値を確認してください。");
    } else {
      if (!text(condition.value) || !condition.value.trim())
        throw Error("条件の値を確認してください。");
      if (condition.op === "between" && (!text(condition.upper) || !condition.upper.trim()))
        throw Error("範囲の終了値を確認してください。");
    }
  }
}

/** 再利用可能な定義のみを検証し、対象、クエリの日時、結果は保存しない。 */
export function validatePresetDraft(draft: MapPresetDraft): void {
  if (!record(draft) || !record(draft.definition)) throw Error("保存する検索条件がありません。");
  const definition = draft.definition;
  if (draft.kind === "filter") {
    if (definition.common_form_id !== null && !formId(definition.common_form_id))
      throw Error("共通フォームを選択してください。");
    validateConditions(definition.conditions);
    if (definition.conditions.length && !definition.common_form_id)
      throw Error("共通フォームを選択してください。");
    return;
  }
  if (
    draft.kind !== "coloring" ||
    !formId(definition.common_form_id) ||
    !Array.isArray(definition.rules) ||
    !definition.rules.length ||
    definition.rules.length > 10
  )
    throw Error("共通フォームと1〜10件の分類を設定してください。");
  const ids = new Set<string>();
  for (const rule of definition.rules) {
    if (
      !record(rule) ||
      !text(rule.id, 100) ||
      !rule.id.trim() ||
      ids.has(rule.id) ||
      !text(rule.label, 100) ||
      !rule.label.trim() ||
      !text(rule.color, 7) ||
      !/^#[0-9a-f]{6}$/i.test(rule.color)
    )
      throw Error("分類名・色・分類の識別情報を確認してください。");
    ids.add(rule.id);
    validateConditions(rule.conditions);
    if (!rule.conditions.length) throw Error("各分類に条件を追加してください。");
  }
}

export function clonePresetDraft(draft: MapPresetDraft): MapPresetDraft {
  validatePresetDraft(draft);
  const condition = (value: Record<string, unknown>) => ({
    field_id: value.field_id,
    field_type: value.field_type,
    op: value.op,
    value: noValue.has(String(value.op)) ? null : (value.value ?? null),
    upper: value.op === "between" ? value.upper : null,
  });
  return JSON.parse(
    JSON.stringify(
      draft.kind === "filter"
        ? {
            kind: "filter",
            definition: {
              common_form_id: draft.definition.common_form_id,
              conditions: draft.definition.conditions.map(condition),
            },
          }
        : {
            kind: "coloring",
            definition: {
              common_form_id: draft.definition.common_form_id,
              rules: draft.definition.rules.map((rule) => ({
                id: rule.id,
                label: rule.label,
                color: rule.color,
                conditions: rule.conditions.map(condition),
              })),
            },
          },
    ),
  );
}

/** 呼び出し元が代入する前に全行を構築し、復元に失敗しても下書きが消えないようにする。 */
export function deserializePresetConditions(
  conditions: Record<string, unknown>[],
  fields: AnswerField[],
  nextId: () => number,
): AnswerConditionRow[] {
  validateConditions(conditions);
  return conditions.map((condition) => {
    const field = fields.find(
      (candidate) =>
        candidate.id === condition.field_id && candidate.field_type === condition.field_type,
    );
    if (!field)
      throw Error(
        "保存した条件の項目が見つかりません。現在のフォームと対象範囲を確認してください。",
      );
    const row: AnswerConditionRow = {
      id: nextId(),
      key: answerFieldKey(field),
      op: String(condition.op),
      value: "",
      upper: "",
      selected: [],
    };
    if (noValue.has(row.op)) return row;
    if (field.field_type === "select" || field.field_type === "radio") {
      const selected = condition.value as string[];
      if (selected.some((choice) => !field.choices.includes(choice)))
        throw Error(
          `「${field.label}」の選択肢が変更されています。保存した条件を確認してください。`,
        );
      row.selected = [...selected];
    } else if (field.field_type === "checkbox") row.value = condition.value ? "true" : "false";
    else row.value = condition.value as string;
    if (row.op === "between") row.upper = condition.upper as string;
    return row;
  });
}

export function isSavedMapPreset(value: unknown): value is SavedMapPreset {
  if (
    !record(value) ||
    !text(value.id, 128) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    [...value.name].length > 100 ||
    value.schema_version !== 1 ||
    !text(value.create_at, 100) ||
    !record(value.display) ||
    (value.display.form_label !== null && !text(value.display.form_label, 1000)) ||
    !Array.isArray(value.display.fields) ||
    value.display.fields.some(
      (field) =>
        !record(field) ||
        !text(field.id, 40) ||
        !text(field.field_type, 30) ||
        !text(field.label, 1000),
    )
  )
    return false;
  try {
    validatePresetDraft(value as SavedMapPreset);
    return true;
  } catch {
    return false;
  }
}

export function mapPresetKindLabel(kind: MapPresetDraft["kind"]): string {
  return kind === "filter" ? "地図上で絞り込み" : "地図で色分け";
}

export function describeMapPreset(preset: SavedMapPreset): string {
  const describe = (condition: Record<string, unknown>) => {
    const label =
      preset.display.fields.find(
        (field) => field.id === condition.field_id && field.field_type === condition.field_type,
      )?.label || String(condition.field_id);
    const operation =
      answerConditionOperations(String(condition.field_type)).find(
        (candidate) => candidate.value === condition.op,
      )?.label || String(condition.op);
    const value = noValue.has(String(condition.op))
      ? ""
      : Array.isArray(condition.value)
        ? condition.value.join("・")
        : typeof condition.value === "boolean"
          ? condition.value
            ? "はい"
            : "いいえ"
          : String(condition.value ?? "");
    return `${label} ${operation}${value ? ` ${value}` : ""}${condition.op === "between" ? `〜${condition.upper}` : ""}`;
  };
  return preset.kind === "filter"
    ? preset.definition.conditions.map(describe).join(" ／ ") || "回答条件なし"
    : preset.definition.rules
        .map((rule) => `${rule.label}：${rule.conditions.map(describe).join(" ／ ")}`)
        .join("\n");
}

export function mapPresetError(error: unknown, fallback: string): string {
  const response = record(error) && record(error.response) ? error.response : null;
  const data = response?.data;
  if (record(data) && typeof data.error === "string" && data.error.length < 500) return data.error;
  if (record(data) && typeof data.message === "string" && data.message.length < 500)
    return data.message;
  return fallback;
}
