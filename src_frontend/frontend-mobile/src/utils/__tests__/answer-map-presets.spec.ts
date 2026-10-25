import { describe, expect, it } from "vitest";
import {
  clonePresetDraft,
  describeMapPreset,
  deserializePresetConditions,
  isSavedMapPreset,
  validatePresetDraft,
  type MapPresetDraft,
  type SavedMapPreset,
} from "../answer-map-presets";

const fields = [
  { id: "n", label: "耐用年数", field_type: "number", choices: [] },
  { id: "b", label: "確認済み", field_type: "checkbox", choices: [] },
  { id: "s", label: "区分", field_type: "select", choices: ["道路", "橋"] },
];
const conditions = [
  {
    field_id: "n",
    field_type: "number",
    op: "between",
    value: "9007199254740993.01",
    upper: "9007199254740994.01",
  },
  { field_id: "b", field_type: "checkbox", op: "eq", value: false, upper: null },
  { field_id: "s", field_type: "select", op: "in", value: ["橋"], upper: null },
  { field_id: "n", field_type: "number", op: "missing", value: null, upper: null },
];
const draft = (): MapPresetDraft => ({
  kind: "filter",
  definition: { common_form_id: "form", conditions: structuredClone(conditions) },
});
const saved = (): SavedMapPreset => ({
  ...draft(),
  id: "one",
  name: "保存条件",
  schema_version: 1,
  display: { form_label: "点検", fields },
  create_at: "2026-10-25T01:00:00",
});

describe("保存した地図検索条件の定義", () => {
  it("数値を文字列のまま、false・選択肢・項目なしを入力へ復元する", () => {
    let id = 0;
    const rows = deserializePresetConditions(conditions, fields, () => ++id);
    expect(rows).toMatchObject([
      {
        id: 1,
        key: "n:number",
        op: "between",
        value: "9007199254740993.01",
        upper: "9007199254740994.01",
      },
      { id: 2, key: "b:checkbox", value: "false" },
      { id: 3, key: "s:select", selected: ["橋"] },
      { id: 4, key: "n:number", op: "missing", value: "", selected: [] },
    ]);
    rows[2].selected.push("道路");
    expect(conditions[2].value).toEqual(["橋"]);
  });
  it("削除した項目・型変更・選択肢変更・不正な比較方法を復元しない", () => {
    expect(() => deserializePresetConditions(conditions, fields.slice(1), () => 1)).toThrow(
      "項目が見つかりません",
    );
    expect(() =>
      deserializePresetConditions(
        conditions,
        fields.map((f) => (f.id === "n" ? { ...f, field_type: "text" } : f)),
        () => 1,
      ),
    ).toThrow("項目が見つかりません");
    expect(() =>
      deserializePresetConditions(
        conditions,
        fields.map((f) => ({ ...f, choices: [] })),
        () => 1,
      ),
    ).toThrow("選択肢が変更");
    expect(() =>
      deserializePresetConditions([{ ...conditions[0], op: "contains" }], fields, () => 1),
    ).toThrow("比較方法");
  });
  it("保存対象を再利用可能な定義だけに限定し、入力の参照を共有しない", () => {
    const original = { ...draft(), query: { as_of: "old" }, targets: ["marker:one"], id: "old" };
    const copy = clonePresetDraft(original);
    expect(Object.keys(copy)).toEqual(["kind", "definition"]);
    expect(copy.definition).toEqual(draft().definition);
    if (copy.kind === "filter") copy.definition.conditions[2].value = ["道路"];
    expect(original.definition).toEqual(draft().definition);
    const noValue: MapPresetDraft = {
      kind: "filter",
      definition: {
        common_form_id: "form",
        conditions: [{ ...conditions[0], op: "empty", value: "old", upper: "old" }],
      },
    };
    expect(clonePresetDraft(noValue).definition).toMatchObject({
      conditions: [{ value: null, upper: null }],
    });
  });
  it("分類の順序・ラベル・色を保持し、不正な分類は拒否する", () => {
    const coloring: MapPresetDraft = {
      kind: "coloring",
      definition: {
        common_form_id: "form",
        rules: [
          { id: "first", label: "50年以上", color: "#2166ac", conditions: [conditions[0]] },
          { id: "second", label: "未確認", color: "#f00F00", conditions: [conditions[1]] },
        ],
      },
    };
    expect(clonePresetDraft(coloring)).toEqual(coloring);
    expect(() =>
      validatePresetDraft({
        ...coloring,
        definition: {
          ...coloring.definition,
          rules: [coloring.definition.rules[0], coloring.definition.rules[0]],
        },
      }),
    ).toThrow("識別情報");
    expect(() =>
      validatePresetDraft({
        ...coloring,
        definition: {
          ...coloring.definition,
          rules: [{ ...coloring.definition.rules[0], color: "red" }],
        },
      }),
    ).toThrow("分類名・色");
  });
  it("回答条件なしの範囲も保存でき、上限超過や版違いのデータは拒否する", () => {
    expect(() =>
      validatePresetDraft({ kind: "filter", definition: { common_form_id: null, conditions: [] } }),
    ).not.toThrow();
    expect(() =>
      validatePresetDraft({
        kind: "filter",
        definition: { common_form_id: null, conditions: [conditions[0]] },
      }),
    ).toThrow("共通フォーム");
    expect(() =>
      validatePresetDraft({
        kind: "filter",
        definition: { common_form_id: "form", conditions: Array(11).fill(conditions[0]) },
      }),
    ).toThrow("10件");
    expect(isSavedMapPreset(saved())).toBe(true);
    expect(isSavedMapPreset({ ...saved(), schema_version: 2 })).toBe(false);
    expect(isSavedMapPreset({ ...saved(), display: null })).toBe(false);
  });
  it("保存名は100文字まで扱い、分類は既存の100 UTF-16単位上限を保つ", () => {
    expect(isSavedMapPreset({ ...saved(), name: "🚧".repeat(100) })).toBe(true);
    expect(isSavedMapPreset({ ...saved(), name: "🚧".repeat(101) })).toBe(false);
    const coloring = {
      ...saved(),
      kind: "coloring" as const,
      definition: {
        common_form_id: "form",
        rules: [
          { id: "color-1", label: "🚧".repeat(50), color: "#d73027", conditions: [conditions[0]] },
        ],
      },
    };
    expect(isSavedMapPreset(coloring)).toBe(true);
    coloring.definition.rules[0].label += "🚧";
    expect(isSavedMapPreset(coloring)).toBe(false);
    coloring.definition.rules[0].label = "分類";
    coloring.definition.rules[0].id = "🚧".repeat(51);
    expect(isSavedMapPreset(coloring)).toBe(false);
  });
  it("一覧の概要にフォームの項目名・比較方法・値を表示する", () => {
    const text = describeMapPreset(saved());
    expect(text).toContain("耐用年数 範囲内 9007199254740993.01〜9007199254740994.01");
    expect(text).toContain("確認済み 等しい いいえ");
    expect(text).toContain("区分 いずれか 橋");
    expect(text).toContain("耐用年数 項目なし");
  });
});
