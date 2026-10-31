export interface AnswerField {
  id: string;
  label: string;
  field_type: string;
  choices: string[];
}
export interface AnswerConditionRow {
  id: number;
  key: string;
  op: string;
  value: string;
  upper: string;
  selected: string[];
}
export interface AnswerColorRule {
  id: string;
  label: string;
  color: string;
  conditions: Record<string, unknown>[];
}
export interface AnswerColorSpecification {
  common_form_id: string;
  rules: AnswerColorRule[];
}
export interface AnswerColoring {
  version: 1;
  rules: { id: string; label: string; color: string }[];
  targets: Record<string, string>;
}
export interface AnswerMapFilter {
  common_form_id: string | null;
  conditions: Record<string, unknown>[];
}

export const answerFieldKey = (field: AnswerField) => `${field.id}:${field.field_type}`;
export const answerConditionHasNoValue = (row: AnswerConditionRow) =>
  ["empty", "filled", "missing"].includes(row.op);

export function answerConditionOperations(kind: string | undefined) {
  const values =
    kind === "number" || kind === "date"
      ? [
          { value: "eq", label: kind === "date" ? "指定日" : "等しい" },
          { value: "gte", label: kind === "date" ? "以降" : "以上" },
          { value: "lte", label: kind === "date" ? "以前" : "以下" },
          { value: "between", label: kind === "date" ? "期間内" : "範囲内" },
        ]
      : kind === "select" || kind === "radio"
        ? [{ value: "in", label: "いずれか" }]
        : kind === "checkbox"
          ? [{ value: "eq", label: "等しい" }]
          : [
              { value: "contains", label: "含む" },
              { value: "eq", label: "等しい" },
            ];
  return [
    ...values,
    { value: "filled", label: "入力あり" },
    { value: "empty", label: "未入力" },
    { value: "missing", label: "項目なし" },
  ];
}

/** 数値は文字列のまま保持し、正確な小数の境界値は PostgreSQL で検証する。 */
export function serializeAnswerConditions(rows: AnswerConditionRow[], fields: AnswerField[]) {
  return rows.map((row) => {
    const field = fields.find((candidate) => answerFieldKey(candidate) === row.key);
    if (!field) throw Error("入力項目を選択してください。");
    if (!answerConditionOperations(field.field_type).some((op) => op.value === row.op))
      throw Error("比較方法を選択してください。");
    let value: unknown = null,
      upper: unknown = null;
    if (!answerConditionHasNoValue(row)) {
      if (field.field_type === "select" || field.field_type === "radio") {
        if (!row.selected.length) throw Error("選択値を指定してください。");
        value = [...row.selected];
      } else if (field.field_type === "checkbox") value = row.value === "true";
      else {
        if (!row.value.trim()) throw Error("条件の値を入力してください。");
        value = row.value.trim();
      }
      if (row.op === "between") {
        if (!row.upper.trim()) throw Error("範囲の終了値を入力してください。");
        upper = row.upper.trim();
      }
    }
    return { field_id: field.id, field_type: field.field_type, op: row.op, value, upper };
  });
}

/** API の両条件配列は、最新の回答を選択した後に、同じ行に対して評価する。 */
export function createColorRuleRequest(
  query: Record<string, unknown>,
  filter: AnswerMapFilter,
  commonFormId: string,
  rule: AnswerColorRule,
) {
  if (query.individual_only === true)
    throw Error("個別フォームの一覧では共通フォームによる色分けを利用できません。");
  if ([query.common_form_id, filter.common_form_id].some((id) => id && id !== commonFormId))
    throw Error("色分けには一覧・地図の絞り込みと同じ共通フォームを選択してください。");
  const baseConditions = Array.isArray(query.conditions) ? query.conditions : [];
  const moveCount = Math.max(0, filter.conditions.length + rule.conditions.length - 10);
  if (
    baseConditions.length + filter.conditions.length + rule.conditions.length > 20 ||
    rule.conditions.length > 10 ||
    baseConditions.length + moveCount > 10
  )
    throw Error("一覧・地図の絞り込み・各分類の条件は、合計20件以内にしてください。");
  // 新しい分類条件はすべて外側の配列に保持する。map-filter はそこでフィールド定義と
  // 正確な NUMERIC の境界値を検証する。条件の空きを作るために基本クエリへ移せるのは、
  // すでに検証済みの map-filter 条件だけとする。
  return {
    query: {
      ...query,
      common_form_id: commonFormId,
      conditions: [...baseConditions, ...filter.conditions.slice(0, moveCount)],
    },
    common_form_id: commonFormId,
    conditions: [...filter.conditions.slice(moveCount), ...rule.conditions],
    options_only: false,
  };
}

export function validateColorTargets(
  value: unknown,
  allowed: ReadonlySet<string>,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    new Set(value).size !== value.length
  )
    throw Error("色分けの対象情報が不正です。直前の表示を維持しています。");
}
