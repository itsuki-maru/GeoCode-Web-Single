import { describe, expect, it } from "vitest";
import {
  cloneSavedMapPreset,
  describeMapPreset,
  isSavedMapPreset,
  type SavedMapPreset,
} from "../src/map/common/answer-map-presets";

const compound = (): SavedMapPreset => ({
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

describe("保存済みv2条件の検証", () => {
  it("v1を除外し、v2の複合式を保持する", () => {
    const preset = compound();
    expect(isSavedMapPreset({ ...preset, schema_version: 1 })).toBe(false);
    expect(isSavedMapPreset(preset)).toBe(true);
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
    const preset: SavedMapPreset = {
      ...compound(),
      kind: "coloring",
      definition: {
        type: "color",
        common_form_id: "form",
        rules: [{ id: "all", label: "全件", color: "#123456", conditions: [] }],
      },
    };
    expect(isSavedMapPreset(preset)).toBe(true);
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
      expect(isSavedMapPreset({ ...compound(), definition })).toBe(false);
    expect(isSavedMapPreset({ ...compound(), kind: "coloring" })).toBe(false);
  });
});
