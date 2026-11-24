import type { AiDefinition } from "../../ai/types";
import { isSavedMapPreset, type MapPresetDraft, type SavedMapPreset } from "./answer-map-presets";
import type { AnswerColorSpecification, AnswerMapFilter } from "./answer-coloring";

// 手動の数値入力欄は文字列を扱う。保存済みの高精度な文字列はそのまま維持する。
function editableConditions(conditions: Record<string, unknown>[]) {
  return conditions.map((condition) => {
    if (condition.field_type !== "number") return condition;
    return {
      ...condition,
      ...(typeof condition.value === "number" ? { value: String(condition.value) } : {}),
      ...(typeof condition.upper === "number" ? { upper: String(condition.upper) } : {}),
    };
  });
}

export function answerMapPresetInputs(
  preset: SavedMapPreset,
): MapPresetDraft | { kind: "expression"; definition: AiDefinition } {
  if (!isSavedMapPreset(preset)) throw Error("保存した検索条件の形式を確認してください。");
  if (preset.definition.type === "color") {
    const { common_form_id, rules } = preset.definition as AiDefinition & AnswerColorSpecification;
    return {
      kind: "coloring",
      definition: {
        common_form_id,
        rules: rules.map((rule) => ({ ...rule, conditions: editableConditions(rule.conditions) })),
      },
    };
  }
  const expression = preset.definition.expression as { op: string } & AnswerMapFilter;
  if (expression.op === "all")
    return { kind: "filter", definition: { common_form_id: null, conditions: [] } };
  if (expression.op === "attribute")
    return {
      kind: "filter",
      definition: {
        common_form_id: expression.common_form_id,
        conditions: editableConditions(expression.conditions),
      },
    };
  return { kind: "expression", definition: preset.definition };
}
