import { describe, expect, it } from "vitest";
import {
  cloneSavedMapPreset,
  describeMapPreset,
  isAnySavedMapPreset,
  isSavedMapPreset,
  type SavedAiMapPreset,
} from "../src/map/common/answer-map-presets";

const compound = (): SavedAiMapPreset => ({
  id: "saved-ai",
  name: "関連する設備",
  kind: "filter",
  schema_version: 2,
  create_at: "2026-11-16T00:00:00Z",
  display: {
    form_label: "設備",
    fields: [{ id: "age", field_type: "number", label: "耐用年数", form_id: "form" }],
  },
  definition: {
    type: "filter",
    expression: {
      op: "or",
      children: [
        { op: "text", query1: "  点検  " },
        {
          op: "not",
          child: {
            op: "attribute",
            common_form_id: "form",
            conditions: [
              { field_id: "age", field_type: "number", op: "gte", value: "9007199254740993.001" },
            ],
          },
        },
      ],
    },
  },
});

describe("AI保存条件と旧形式の分離", () => {
  it("旧v1判定を変えず新一覧で複合式を受け取り、条件を省略・再生成しない", () => {
    const preset = compound();
    expect(isSavedMapPreset(preset)).toBe(false);
    expect(isAnySavedMapPreset(preset)).toBe(true);
    const copied = cloneSavedMapPreset(preset);
    expect(copied).toEqual(preset);
    expect(copied.definition).not.toBe(preset.definition);
    const description = describeMapPreset(preset);
    expect(description).toContain(" または ");
    expect(description).toContain("除外");
    expect(description).toContain("耐用年数");
    expect(description).toContain("9007199254740993.001");
    expect(description).toContain("  点検  ");
  });

  it("保存した色分けの全件分類を表示できる", () => {
    const preset: SavedAiMapPreset = {
      ...compound(),
      kind: "coloring",
      definition: {
        type: "color",
        common_form_id: "form",
        rules: [{ id: "all", label: "全件", color: "#123456", conditions: [] }],
      },
    };
    expect(isAnySavedMapPreset(preset)).toBe(true);
    expect(describeMapPreset(preset)).toContain("全件：すべての対象");
  });

  it("保存定義を別操作へ差し替えたり未知の検索式を含めた応答を受け付けない", () => {
    for (const definition of [
      { type: "create_layer", name: "bad" },
      { type: "filter", expression: { op: "script", code: "alert(1)" } },
      { type: "filter", expression: { op: "all" }, url: "https://example.invalid" },
      {
        type: "filter",
        expression: {
          op: "attribute",
          common_form_id: "form",
          conditions: [{ field_id: "age", field_type: "number", op: "gte", value: {} }],
        },
      },
    ])
      expect(isAnySavedMapPreset({ ...compound(), definition })).toBe(false);
    expect(isAnySavedMapPreset({ ...compound(), kind: "coloring" })).toBe(false);
  });
});
