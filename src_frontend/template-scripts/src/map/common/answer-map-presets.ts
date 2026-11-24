import {
  answerConditionOperations,
  answerFieldKey,
  type AnswerColorSpecification,
  type AnswerConditionRow,
  type AnswerField,
  type AnswerMapFilter,
} from "./answer-coloring";
import { validateDefinition, type AiDefinition } from "../../ai/types";

export type MapPresetDraft =
  | { kind: "filter"; definition: AnswerMapFilter }
  | { kind: "coloring"; definition: AnswerColorSpecification };

export type SavedMapPreset = V2MapPresetDraft & {
  id: string;
  name: string;
  display: {
    form_label: string | null;
    fields: { id: string; field_type: string; label: string; form_id?: string }[];
  };
  create_at: string;
};

/** 手動・AIで共通の保存形式。名前とIDは保存時に付与する。 */
export type V2MapPresetDraft = {
  schema_version: 2;
  kind: "filter" | "coloring";
  definition: AiDefinition;
};
export type AnyMapPresetDraft = MapPresetDraft | V2MapPresetDraft;

export function toV2PresetDraft(value: AnyMapPresetDraft): V2MapPresetDraft {
  let definition: AiDefinition;
  if ("schema_version" in value) {
    if (value.schema_version !== 2) throw Error("保存条件の形式を確認してください。");
    definition = value.definition;
  } else {
    const draft = clonePresetDraft(value);
    if (draft.kind === "coloring") {
      definition = { type: "color", ...draft.definition };
    } else {
      definition = {
        type: "filter",
        expression: draft.definition.common_form_id
          ? { op: "attribute", ...draft.definition }
          : { op: "all" },
      };
    }
  }
  if (
    (value.kind === "filter" && definition.type !== "filter") ||
    (value.kind === "coloring" && definition.type !== "color") ||
    !["filter", "coloring"].includes(value.kind)
  )
    throw Error("保存する条件の種類を確認してください。");
  return {
    schema_version: 2,
    kind: value.kind,
    definition: validateAiPresetDefinition(definition),
  };
}

export interface MapPresetPage {
  items: SavedMapPreset[];
  total: number;
  page: number;
  page_size: number;
}

const supported = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "image",
]);
const noValue = new Set(["empty", "filled", "missing"]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 5000): value is string =>
  typeof value === "string" && value.length <= max;
const formId = (value: unknown): value is string => text(value, 128) && !!value.trim();

function validateConditions(value: unknown): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10) throw Error("登録条件は10件以内にしてください。");
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

export function validateAiPresetDefinition(value: unknown): AiDefinition {
  const definition = validateDefinition(value);
  const only = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const conditions = (values: unknown) => {
    if (!Array.isArray(values) || values.length > 10) throw Error("登録条件を確認してください。");
    for (const condition of values) {
      if (
        !record(condition) ||
        !only(condition, ["field_id", "field_type", "op", "value", "upper"]) ||
        !text(condition.field_id, 40) ||
        !/^[a-zA-Z0-9_]+$/.test(condition.field_id) ||
        typeof condition.field_type !== "string" ||
        !supported.has(condition.field_type) ||
        !answerConditionOperations(condition.field_type).some(
          (operation) => operation.value === condition.op,
        )
      )
        throw Error("登録条件を確認してください。");
      if (noValue.has(String(condition.op))) continue;
      if (condition.field_type === "checkbox") {
        if (typeof condition.value !== "boolean") throw Error("真偽条件を確認してください。");
      } else if (condition.field_type === "select" || condition.field_type === "radio") {
        if (
          !Array.isArray(condition.value) ||
          !condition.value.length ||
          condition.value.length > 100 ||
          condition.value.some((value) => typeof value !== "string")
        )
          throw Error("選択条件を確認してください。");
      } else {
        const validValue = (value: unknown) =>
          typeof value === "string" ||
          (condition.field_type === "number" &&
            typeof value === "number" &&
            Number.isFinite(value));
        if (
          !validValue(condition.value) ||
          (condition.op === "between" && !validValue(condition.upper))
        )
          throw Error("条件の値を確認してください。");
      }
    }
  };
  let leaves = 0;
  const expression = (value: unknown, depth: number) => {
    if (!record(value) || depth > 5) throw Error("検索式を確認してください。");
    switch (value.op) {
      case "all":
        if (!only(value, ["op"])) throw Error("検索式を確認してください。");
        leaves++;
        break;
      case "text":
        if (
          !only(value, ["op", "query1", "query2"]) ||
          typeof value.query1 !== "string" ||
          [...value.query1].length > 100 ||
          (value.query2 !== undefined &&
            (typeof value.query2 !== "string" || [...value.query2].length > 100))
        )
          throw Error("検索語を確認してください。");
        leaves++;
        break;
      case "attribute":
        if (!only(value, ["op", "common_form_id", "conditions"]) || !formId(value.common_form_id))
          throw Error("共通フォームを確認してください。");
        conditions(value.conditions);
        leaves++;
        break;
      case "and":
      case "or":
        if (
          !only(value, ["op", "children"]) ||
          !Array.isArray(value.children) ||
          !value.children.length ||
          value.children.length > 10
        )
          throw Error("検索式を確認してください。");
        value.children.forEach((child) => expression(child, depth + 1));
        break;
      case "not":
        if (!only(value, ["op", "child"])) throw Error("検索式を確認してください。");
        expression(value.child, depth + 1);
        break;
      default:
        throw Error("対応しない検索式です。");
    }
    if (leaves > 24) throw Error("検索条件が多すぎます。");
  };
  if (definition.type === "filter") {
    if (!only(definition, ["type", "expression"])) throw Error("検索式を確認してください。");
    expression(definition.expression, 0);
  } else {
    if (
      !only(definition, ["type", "common_form_id", "rules"]) ||
      !formId(definition.common_form_id)
    )
      throw Error("色分け条件を確認してください。");
    const ids = new Set<string>();
    for (const rule of definition.rules as unknown[]) {
      if (
        !record(rule) ||
        !only(rule, ["id", "label", "color", "conditions"]) ||
        !text(rule.id, 40) ||
        !rule.id ||
        ids.has(rule.id) ||
        typeof rule.label !== "string" ||
        !rule.label ||
        [...rule.label].length > 100 ||
        typeof rule.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(rule.color)
      )
        throw Error("分類条件を確認してください。");
      ids.add(rule.id);
      conditions(rule.conditions);
    }
  }
  return definition;
}

export function isSavedMapPreset(value: unknown): value is SavedMapPreset {
  if (
    !record(value) ||
    value.schema_version !== 2 ||
    !["filter", "coloring"].includes(String(value.kind)) ||
    !text(value.id, 128) ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    [...value.name].length > 100 ||
    !text(value.create_at, 100) ||
    !record(value.display) ||
    (value.display.form_label !== null && !text(value.display.form_label, 10000)) ||
    !Array.isArray(value.display.fields) ||
    value.display.fields.length > 240 ||
    value.display.fields.some(
      (field) =>
        !record(field) ||
        !text(field.id, 40) ||
        !text(field.field_type, 30) ||
        !text(field.label, 10000) ||
        (field.form_id !== undefined && !formId(field.form_id)),
    )
  )
    return false;
  try {
    const definition = validateAiPresetDefinition(value.definition);
    return (
      (value.kind === "filter" && definition.type === "filter") ||
      (value.kind === "coloring" && definition.type === "color")
    );
  } catch {
    return false;
  }
}

export function cloneSavedMapPreset(preset: SavedMapPreset): SavedMapPreset {
  if (!isSavedMapPreset(preset)) throw Error("保存条件を確認できませんでした。");
  return structuredClone(preset);
}

export function mapPresetKindLabel(kind: MapPresetDraft["kind"]): string {
  return kind === "filter" ? "地図上で絞り込み" : "地図で色分け";
}

export function describeMapPreset(preset: SavedMapPreset): string {
  const describe = (condition: Record<string, unknown>, form?: string) => {
    const label =
      preset.display.fields.find(
        (field) =>
          field.id === condition.field_id &&
          field.field_type === condition.field_type &&
          (!form || !field.form_id || field.form_id === form),
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
  const expression = (value: unknown): string => {
    const part = value as Record<string, unknown>;
    if (part.op === "all") return "すべての対象";
    if (part.op === "text")
      return (
        "名前・本文・メモに「" +
        String(part.query1) +
        "」" +
        (part.query2 ? "かつ「" + String(part.query2) + "」" : "")
      );
    if (part.op === "attribute")
      return (
        (part.conditions as Record<string, unknown>[])
          .map((condition) => describe(condition, String(part.common_form_id)))
          .join(" かつ ") || "指定フォームの登録あり"
      );
    if (part.op === "not") return "除外（" + expression(part.child) + "）";
    return (
      "（" +
      (part.children as unknown[]).map(expression).join(part.op === "or" ? " または " : " かつ ") +
      "）"
    );
  };
  if (preset.definition.type === "filter") return expression(preset.definition.expression);
  return (preset.definition.rules as Record<string, unknown>[])
    .map(
      (rule) =>
        String(rule.label) +
        "：" +
        ((rule.conditions as Record<string, unknown>[])
          .map((condition) => describe(condition, String(preset.definition.common_form_id)))
          .join(" ／ ") || "すべての対象"),
    )
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
