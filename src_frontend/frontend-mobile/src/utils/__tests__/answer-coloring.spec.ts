import { describe, expect, it } from "vitest";
import {
  createColorRuleRequest,
  serializeAnswerConditions,
  validateColorTargets,
} from "../answer-coloring";

const condition = (value: string) => ({
  field_id: "n",
  field_type: "number",
  op: "gte",
  value,
  upper: null,
});
const rule = {
  id: "a",
  label: "分類",
  color: "#2166ac",
  conditions: [condition("9007199254740993.1")],
};
describe("回答色分けのAPI条件", () => {
  it("20条件を二つのAPI配列へ分配し、同じ回答・履歴モードと数値精度を維持する", () => {
    const query = {
      mode: "history",
      as_of: "2026-10-20T00:00:00Z",
      common_form_id: "form",
      conditions: Array.from({ length: 10 }, (_, n) => condition(String(n))),
    };
    const filter = {
      common_form_id: "form",
      conditions: Array.from({ length: 9 }, (_, n) => condition(String(n + 10))),
    };
    const request = createColorRuleRequest(query, filter, "form", rule);
    expect(request.query).toMatchObject({
      mode: "history",
      as_of: query.as_of,
      conditions: query.conditions,
    });
    expect(request.conditions).toHaveLength(10);
    expect(request.conditions.at(-1)).toEqual(rule.conditions[0]);
    expect(query.conditions).toHaveLength(10);
    expect(filter.conditions).toHaveLength(9);
    expect(() =>
      createColorRuleRequest(
        query,
        { ...filter, conditions: [...filter.conditions, condition("20")] },
        "form",
        rule,
      ),
    ).toThrow("合計20件以内");
  });
  it("フォームの矛盾を上書きせず、個別フォームの一覧も拒否する", () => {
    expect(() =>
      createColorRuleRequest(
        { common_form_id: "other" },
        { common_form_id: null, conditions: [] },
        "form",
        rule,
      ),
    ).toThrow("同じ共通フォーム");
    expect(() =>
      createColorRuleRequest({}, { common_form_id: "other", conditions: [] }, "form", rule),
    ).toThrow("同じ共通フォーム");
    expect(() =>
      createColorRuleRequest(
        { individual_only: true },
        { common_form_id: null, conditions: [] },
        "form",
        rule,
      ),
    ).toThrow("個別フォーム");
  });
  it("同じ回答に適用する条件を移して、10件ずつの上限に収める", () => {
    const request = createColorRuleRequest(
      { conditions: [condition("0")] },
      { common_form_id: "form", conditions: Array.from({ length: 10 }, () => condition("1")) },
      "form",
      rule,
    );
    expect(request.query.conditions).toHaveLength(2);
    expect(request.conditions).toHaveLength(10);
    expect(request.conditions.at(-1)).toEqual(rule.conditions[0]);
    expect(request.query.common_form_id).toBe("form");
  });
  it("高精度の数値範囲は必ず外側に保持して既存APIの厳密検証を利用する", () => {
    const range = {
      ...condition("9007199254740993.2"),
      op: "between",
      upper: "9007199254740993.1",
    };
    const request = createColorRuleRequest(
      { conditions: [] },
      { common_form_id: null, conditions: [] },
      "form",
      { ...rule, conditions: [range] },
    );
    expect(request.query.conditions).toEqual([]);
    expect(request.conditions).toEqual([range]);
  });
  it("0・false・未入力・項目なし・日付境界を区別してシリアライズする", () => {
    const fields = [
      { id: "n", label: "数値", field_type: "number", choices: [] },
      { id: "b", label: "真偽値", field_type: "checkbox", choices: [] },
      { id: "d", label: "日付", field_type: "date", choices: [] },
    ];
    const row = { id: 1, key: "n:number", op: "eq", value: "0", upper: "", selected: [] };
    expect(
      serializeAnswerConditions(
        [
          row,
          { ...row, key: "b:checkbox", value: "false" },
          { ...row, op: "empty" },
          { ...row, op: "missing" },
          { ...row, key: "d:date", op: "between", value: "2020-01-01", upper: "2020-12-31" },
        ],
        fields,
      ),
    ).toEqual([
      { ...condition("0"), op: "eq" },
      { field_id: "b", field_type: "checkbox", op: "eq", value: false, upper: null },
      { field_id: "n", field_type: "number", op: "empty", value: null, upper: null },
      { field_id: "n", field_type: "number", op: "missing", value: null, upper: null },
      {
        field_id: "d",
        field_type: "date",
        op: "between",
        value: "2020-01-01",
        upper: "2020-12-31",
      },
    ]);
  });
  it("対象外IDと重複IDを受け付けない", () => {
    const allowed = new Set(["marker:one", "shape:two"]);
    expect(() => validateColorTargets(["marker:one"], allowed)).not.toThrow();
    expect(() => validateColorTargets(["marker:foreign"], allowed)).toThrow("対象情報");
    expect(() => validateColorTargets(["marker:one", "marker:one"], allowed)).toThrow("対象情報");
  });
});
