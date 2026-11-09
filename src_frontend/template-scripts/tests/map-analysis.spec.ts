import { describe, expect, it, vi } from "vitest";
import { classifyMapTargets, evaluateMapAnalysis } from "../src/map/common/map-analysis";
import { validatePresetDraft, clonePresetDraft } from "../src/map/common/answer-map-presets";
import {
  answerConditionOperations,
  type AnswerColorSpecification,
} from "../src/map/common/answer-coloring";

const specification: AnswerColorSpecification = {
  common_form_id: "form",
  rules: ["first", "second"].map((id) => ({
    id,
    label: id,
    color: "#2166ac",
    conditions: [
      { field_id: "n", field_type: "number", op: "gte", value: "9007199254740993.1", upper: null },
    ],
  })),
};
const at = "2026-10-30T00:00:00Z";
const result = (targets: string[]) => ({
  as_of: at,
  targets,
  target_count: targets.length,
  answer_count: targets.length,
  forms: [],
  fields: [],
});
describe("地図の共通分類処理", () => {
  it("先に一致した分類を優先し、選択した検索結果の範囲に絞り込む", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(["marker:a", "shape:b"])
      .mockResolvedValueOnce(["marker:a", "shape:c"]);
    const value = await classifyMapTargets(
      specification,
      new Set(["marker:a", "shape:c"]),
      evaluate,
    );
    expect(value.targets).toEqual({ "marker:a": "first", "shape:c": "second" });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it("処理の失敗や不正な対象情報がある場合は部分的な分類結果を返さない", async () => {
    await expect(
      classifyMapTargets(
        specification,
        null,
        vi.fn().mockResolvedValueOnce(["marker:a"]).mockRejectedValueOnce(Error("offline")),
      ),
    ).rejects.toThrow("offline");
    await expect(
      classifyMapTargets(specification, null, async () => ["marker:a", "marker:a"]),
    ).rejects.toThrow("対象情報");
  });
  it("色分けのみの場合は地図の表示範囲を絞り込まず、全分類で同じ検索基準日時を使う", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result(["marker:a"]))
      .mockResolvedValueOnce(result(["shape:b"]));
    const value = await evaluateMapAnalysis(
      transport,
      null,
      specification,
      null,
      new AbortController().signal,
    );
    expect(transport.mock.calls[0]![1]).toMatchObject({
      scope: { kind: "layers", layer_ids: null },
      options_only: true,
    });
    for (const call of transport.mock.calls.slice(1))
      expect(call[1]).toMatchObject({
        query: { mode: "latest", as_of: at },
        common_form_id: "form",
      });
    expect(value.coloring?.targets).toEqual({ "marker:a": "first", "shape:b": "second" });
    expect(value.targets).toEqual([]); // 絞り込み条件がないため、この結果を地図の表示制限には使わない。
  });
  it("同じ登録に絞り込み条件と分類条件の両方を適用し、小数の文字列を正確に保持する", async () => {
    const filter = {
      common_form_id: "form",
      conditions: [{ field_id: "flag", field_type: "checkbox", op: "eq", value: false }],
    };
    const transport = vi.fn().mockResolvedValue(result(["marker:a"]));
    await evaluateMapAnalysis(
      transport,
      filter,
      specification,
      ["layer"],
      new AbortController().signal,
      ["marker:a"],
    );
    expect(transport.mock.calls[1]![1]).toMatchObject({
      scope: { kind: "layers", layer_ids: ["layer"] },
      targets: ["marker:a"],
      conditions: [...filter.conditions, ...specification.rules[0]!.conditions],
    });
  });
  it("対象情報・件数・検索基準日時の不整合を拒否する", async () => {
    await expect(
      evaluateMapAnalysis(
        async () => ({ ...result([]), target_count: 1 }),
        null,
        specification,
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("検索結果");
    const transport = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce({ ...result([]), as_of: "2026-10-31T00:00:00Z" });
    await expect(
      evaluateMapAnalysis(transport, null, specification, [], new AbortController().signal),
    ).rejects.toThrow("検索基準日時");
  });
  it("画像の有無を判定する条件と既存の保存条件形式を共通で利用する", () => {
    expect(answerConditionOperations("image").map((o) => o.value)).toEqual([
      "filled",
      "empty",
      "missing",
    ]);
    const draft = {
      kind: "filter" as const,
      definition: {
        common_form_id: "form",
        conditions: [{ field_id: "photo", field_type: "image", op: "filled", value: "ignored" }],
      },
    };
    expect(() => validatePresetDraft(draft)).not.toThrow();
    expect(clonePresetDraft(draft).definition).toMatchObject({
      conditions: [{ value: null, upper: null }],
    });
    expect(() =>
      validatePresetDraft({
        ...draft,
        definition: {
          ...draft.definition,
          conditions: [{ ...draft.definition.conditions[0], op: "eq" }],
        },
      }),
    ).toThrow();
  });
});
