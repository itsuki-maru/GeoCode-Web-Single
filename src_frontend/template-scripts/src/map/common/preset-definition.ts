import { validateAiPresetDefinition } from "./answer-map-presets";

export interface Condition {
  field_id: string;
  field_type: string;
  op: string;
  value?: unknown;
  upper?: unknown;
}
export type Expression =
  | { op: "all" }
  | { op: "text"; query1: string; query2?: string }
  | { op: "attribute"; common_form_id: string; conditions: Condition[] }
  | { op: "and" | "or"; children: Expression[] }
  | { op: "not"; child: Expression };
export interface ColorRule {
  id: string;
  label: string;
  color: string;
  conditions: Condition[];
}
export type Definition =
  | { type: "filter"; expression: Expression }
  | { type: "color"; common_form_id: string; rules: ColorRule[] };

export const noValue = new Set(["empty", "filled", "missing"]);

// 有効数字と小数点位置を別々に保持し、PostgreSQL NUMERIC の境界を丸めずに比較する。
export function decimal(value: string) {
  const [mantissa = "", exponent = "0"] = value.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.replace(/^[+-]/, "").split(".");
  const raw = whole + fraction;
  const digits = raw.replace(/^0+/, "").replace(/0+$/, "");
  return {
    sign: digits ? (value.startsWith("-") ? -1 : 1) : 0,
    position: whole.length - (raw.match(/^0*/)?.[0].length ?? 0) + Number(exponent),
    digits,
  };
}

export function compareDecimals(a: ReturnType<typeof decimal>, b: ReturnType<typeof decimal>) {
  if (a.sign !== b.sign || a.sign === 0) return a.sign - b.sign;
  const order = a.position - b.position || (a.digits > b.digits ? 1 : a.digits < b.digits ? -1 : 0);
  return a.sign * order;
}

/** 保存条件の構造と、入力値の型・範囲を検証する。 */
export function validateAiEditorDefinition(value: unknown): Definition {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw Error("保存条件の形式を確認できませんでした。");
  }
  if (typeof encoded !== "string" || new TextEncoder().encode(encoded).length > 131072)
    throw Error("保存条件は128KiB以内にしてください。");
  const validated = validateAiPresetDefinition(value);
  const conditionValues = (conditions: Condition[]) => {
    for (const condition of conditions) {
      if (noValue.has(condition.op)) continue;
      const values = [condition.value, ...(condition.op === "between" ? [condition.upper] : [])];
      for (const item of values) {
        if (typeof item === "string" && new TextEncoder().encode(item).length > 5000)
          throw Error("検索値は5000バイト以内にしてください。");
        if (
          Array.isArray(item) &&
          item.some((v) => typeof v !== "string" || new TextEncoder().encode(v).length > 5000)
        )
          throw Error("選択値を確認してください。");
        if (condition.field_type === "number") {
          const raw = String(item);
          // Numberは有限性だけに使い、保持値・送信値へ変換しない。
          if (
            raw.length > 200 ||
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ||
            Math.abs(Number(raw.split(/[eE]/)[1] ?? 0)) > 1000 ||
            !Number.isFinite(Number(raw))
          )
            throw Error("数値の条件を確認してください。");
        }
        if (condition.field_type === "date") {
          if (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item))
            throw Error("日付はYYYY-MM-DD形式で入力してください。");
          const date = new Date(`${item}T00:00:00Z`);
          if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== item)
            throw Error("日付を確認してください。");
        }
      }
      if (condition.op === "between") {
        const from = String(condition.value);
        const to = String(condition.upper);
        if (condition.field_type === "number" && compareDecimals(decimal(from), decimal(to)) > 0)
          throw Error("数値範囲を確認してください。");
        if (condition.field_type === "date" && from > to)
          throw Error("日付範囲を確認してください。");
      }
    }
  };
  const inspect = (expression: Expression): void => {
    if (expression.op === "attribute") conditionValues(expression.conditions);
    else if (expression.op === "and" || expression.op === "or")
      expression.children.forEach(inspect);
    else if (expression.op === "not") inspect(expression.child);
  };
  const definition = validated as unknown as Definition;
  if (definition.type === "filter") inspect(definition.expression);
  else
    definition.rules.forEach((rule) => {
      if (new TextEncoder().encode(rule.id).length > 40) throw Error("分類IDを確認してください。");
      conditionValues(rule.conditions);
    });
  return definition;
}
