import { describe, expect, it, vi } from "vitest";
import { LocalPresetData } from "../src/map/common/local-preset";
import type { AiDefinition } from "../src/ai/types";

const at = "2026-10-01T10:00:00Z";
const targets = ["設備A", "公園_B", "道路"].map((name, i) => ({
  key: `${i === 2 ? "shape" : "marker"}:${i}`,
  name,
  detail: i === 1 ? "A%_" : "ABC",
}));
const signal = new AbortController().signal;
const attribute = (id: string, ...conditions: unknown[]) => ({
  op: "attribute",
  common_form_id: id,
  conditions,
});
const filter = (expression: unknown): AiDefinition => ({ type: "filter", expression });
const n = (op: string, value?: string, upper?: string) => ({
  field_id: "n",
  field_type: "number",
  op,
  value,
  upper,
});
const color: AiDefinition = {
  type: "color",
  common_form_id: "f",
  rules: [
    { id: "high", color: "#ff0044", label: "大", conditions: [n("gte", "9007199254740993.2")] },
    { id: "rest", color: "#111111", label: "他", conditions: [] },
  ],
};
function row(i: number, id: string, form_id: string | null, fields = {}) {
  return { target: targets[i].key, id, form_id, fields, revision: 1 };
}
const numeric = (value: string | null) => ({ n: { type: "number", value } });
const page = (rows: ReturnType<typeof row>[]) => ({ as_of: at, rows, next_cursor: null });

describe("読み込み済み地物への保存条件の適用", () => {
  it("文字・全件・NOTを同じ集合で切り替え、空集合も通信を使わない", async () => {
    const send = vi.fn();
    const data = new LocalPresetData(send, { layer_ids: null }, targets);
    const a = filter({ op: "text", query1: "a%_", query2: "公園" });
    const b = filter({ op: "not", child: a.expression });
    await data.prepare([a, b], signal);
    expect(data.evaluate(a).targets).toEqual(["marker:1"]);
    expect(data.evaluate(b).targets).toEqual(["marker:0", "shape:2"]);
    expect(data.evaluate(a).targets).toEqual(["marker:1"]);
    const empty = new LocalPresetData(send, { query: { as_of: at } }, []);
    await empty.prepare([color], signal);
    expect(empty.evaluateAnswers(null, color).target_count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("フォーム単位の最新回答を組み合わせ、取得済みの値と分類の優先順を再利用する", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        page([
          row(0, "x", "f", numeric("9007199254740993.20")),
          row(1, "y", "f", numeric("9007199254740993.19")),
        ]),
      )
      .mockResolvedValueOnce(page([row(0, "z", "g")]));
    const data = new LocalPresetData(send, { layer_ids: ["layer"] }, targets);
    const a = filter(attribute("f", n("between", "9007199254740993.20", "9007199254740993.201")));
    const b = filter({ op: "and", children: [a.expression, attribute("g")] });
    await data.prepare([a], signal);
    await data.prepare([b, color], signal);
    await data.prepare([a], signal);
    expect(send.mock.calls[1][1]).toMatchObject({ forms: { g: [] }, as_of: at });
    expect(data.evaluate(a).targets).toEqual(["marker:0"]);
    expect(data.evaluate(b).targets).toEqual(["marker:0"]);
    expect(data.evaluate(color).coloring?.targets).toEqual({
      "marker:0": "high",
      "marker:1": "rest",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(["通常", "履歴"])(
    "%s地図の一覧で64フォームを超えても読み込み済み地物だけを同じ時点で集計する",
    async (mode) => {
      const ids = Array.from({ length: 65 }, (_, i) => `f${i}`);
      const history = mode === "履歴";
      const definitions = ids.map((id) => filter(attribute(id, n("eq", "1"))));
      const send = vi.fn(async (_path, body) => {
        expect(body.targets).toEqual(targets.map((t) => t.key));
        const forms = Object.keys(body.forms);
        expect(forms.length).toBeLessThanOrEqual(64);
        return page(
          (history ? ids : forms).map((id) =>
            row(0, id, id, forms.includes(id) ? numeric("1") : {}),
          ),
        );
      });
      const data = new LocalPresetData(send, history ? { query: { as_of: at } } : {}, targets);
      await data.prepare([...definitions, definitions[0]], signal);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toMatchObject(
        history ? { query: { as_of: at } } : { as_of: at },
      );
      expect(data.evaluate(definitions[0]).targets).toEqual(["marker:0"]);
      expect(data.evaluate(definitions[64]).targets).toEqual(["marker:0"]);
      if (history) expect(data.evaluateAnswers(null, null).answer_count).toBe(65);
      await data.prepare(definitions, signal);
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
  it("同一フォームが1,024項目を超えた場合も全分割の完了後にだけ値を反映する", async () => {
    const definitions = Array.from({ length: 1025 }, (_, i) =>
      filter(attribute("f", { ...n("eq", "1"), field_id: `x${i}` })),
    );
    let failLast = true;
    const send = vi.fn(async (_path, body) => {
      const ids: string[] = body.forms.f;
      if (failLast && ids.includes("x1024")) throw Error("中断");
      const values = Object.fromEntries(ids.map((id) => [id, { type: "number", value: "1" }]));
      return page([row(0, "x", "f", values)]);
    });
    const data = new LocalPresetData(send, {}, targets);
    await expect(data.prepare(definitions, signal)).rejects.toThrow("中断");
    expect(data.ready([definitions[0]])).toBe(false);
    failLast = false;
    await data.prepare(definitions, signal);
    expect(send.mock.calls.map(([, b]) => b.forms.f.length)).toEqual([1024, 1, 1024, 1]);
    expect(data.evaluate(definitions[0]).targets).toEqual(["marker:0"]);
    expect(data.evaluate(definitions[1024]).targets).toEqual(["marker:0"]);
  });
  it("分割の途中で履歴の構成やリビジョンが変わった場合は再取得まで使用しない", async () => {
    const definitions = Array.from({ length: 65 }, (_, i) => filter(attribute(`f${i}`)));
    const first = row(0, "x", "f0");
    const send = vi
      .fn()
      .mockResolvedValueOnce(page([first]))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([first]))
      .mockResolvedValueOnce(page([{ ...first, revision: 2 }]))
      .mockResolvedValue(page([first]));
    const data = new LocalPresetData(send, { query: { as_of: at } }, targets);
    for (let i = 0; i < 2; ++i) {
      await expect(data.prepare(definitions, signal)).rejects.toThrow();
      expect(data.ready(definitions)).toBe(false);
    }
    await data.prepare(definitions, signal);
    expect(data.evaluateAnswers(definitions[0], null).answer_count).toBe(1);
  });
  it("未登録、旧版に項目なし、未入力、型変更、falseを区別する", async () => {
    const r = (i: number, fields: Record<string, unknown>) => row(i, String(i), "f", fields);
    const send = vi
      .fn()
      .mockResolvedValue(
        page([
          r(0, { ...numeric(null), b: { type: "checkbox", value: false } }),
          r(1, { n: { type: "text", value: "" }, b: { type: "checkbox", value: "false" } }),
        ]),
      );
    const data = new LocalPresetData(send, {}, targets);
    const flag = filter(
      attribute("f", { field_id: "b", field_type: "checkbox", op: "eq", value: false }),
    );
    const missing = filter(attribute("f", n("missing")));
    const empty = filter(attribute("f", n("empty")));
    await data.prepare([missing, empty, flag], signal);
    expect(data.evaluate(missing).targets).toEqual(["marker:1"]);
    expect(data.evaluate(empty).targets).toEqual(["marker:0"]);
    expect(data.evaluate(flag).targets).toEqual(["marker:0"]);
    expect(data.evaluate(filter({ op: "not", child: attribute("f") })).targets).toEqual([
      "shape:2",
    ]);
  });
  it("日付の両端とうるう日、負の精密小数、選択値を元の型で判定する", async () => {
    const fields = (day: string, number: string, value: string) => ({
      ...numeric(number),
      day: { type: "date", value: day },
      selection: { type: "select", value },
    });
    const send = vi
      .fn()
      .mockResolvedValue(
        page([
          row(0, "1", "f", fields("2024-02-29", "-1.00000000000000000002", "A")),
          row(1, "2", "f", fields("2024-03-01", "-1.00000000000000000001", "B")),
          row(2, "3", "f", fields("2024-03-02", "-0e-1", "C")),
        ]),
      );
    const data = new LocalPresetData(send, {}, targets);
    const day = {
      field_id: "day",
      field_type: "date",
      op: "between",
      value: "2024-02-29",
      upper: "2024-03-01",
    };
    const selected = { field_id: "selection", field_type: "select", op: "in", value: ["B", "C"] };
    const a = filter(attribute("f", day, selected));
    const b = filter(attribute("f", n("lte", "-100000000000000000002e-20")));
    await data.prepare([a, b], signal);
    expect(data.evaluate(filter(attribute("f", day))).target_count).toBe(2);
    expect(data.evaluate(a).targets).toEqual(["marker:1"]);
    expect(data.evaluate(b).targets).toEqual(["marker:0"]);
    expect(() => data.evaluate(filter(attribute("f", { ...day, value: "2023-02-29" })))).toThrow(
      "日付",
    );
    expect(() =>
      data.evaluate(filter(attribute("f", n("between", "9.000000000000000001", "9")))),
    ).toThrow("数値範囲");
  });
  it("追加取得で回答の更新を見つけたら必要項目を取り直し、新旧の値を混ぜない", async () => {
    const updated = {
      ...row(0, "x", "f", { flag: { type: "checkbox", value: true } }),
      revision: 2,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(page([row(0, "x", "f", numeric("5"))]))
      .mockResolvedValueOnce(page([updated]))
      .mockResolvedValueOnce(
        page([{ ...updated, fields: { ...updated.fields, ...numeric("6") } }]),
      );
    const data = new LocalPresetData(send, {}, targets);
    const cached = filter(attribute("f", n("eq", "5")));
    const added = filter(
      attribute("f", { field_id: "flag", field_type: "checkbox", op: "eq", value: true }),
    );
    await data.prepare([cached], signal);
    await data.prepare([cached, added], signal);
    expect(send.mock.calls[2][1].forms).toEqual({ f: ["n", "flag"] });
    expect(data.evaluate(cached).target_count).toBe(0);
    expect(data.evaluate(added).targets).toEqual(["marker:0"]);
  });
  it("登録地図の履歴は式も分類も同じ回答行で判定し、登録件数と地物数を区別する", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        page([
          row(0, "1", "f", numeric("9007199254740993.19")),
          row(0, "2", "f", numeric("9007199254740993.20")),
          row(0, "3", "g"),
          row(1, "4", null),
          row(2, "5", "f", numeric("5")),
        ]),
      );
    const data = new LocalPresetData(send, { query: { mode: "history", as_of: at } }, targets);
    const low = filter(attribute("f", n("lte", "9007199254740993.19")));
    const other = filter({ op: "not", child: attribute("f") });
    const impossible = filter({ op: "and", children: [low.expression, attribute("g")] });
    await data.prepare([low, color, impossible], signal);
    expect(data.evaluateAnswers(impossible, null).answer_count).toBe(0);
    expect(data.evaluateAnswers(other, null)).toMatchObject({ answer_count: 2, target_count: 2 });
    expect(data.evaluateAnswers(null, color)).toMatchObject({
      answer_count: 5,
      target_count: 3,
      coloring: { targets: { "marker:0": "high", "shape:2": "rest" } },
    });
    expect(data.evaluateAnswers(low, color)).toMatchObject({
      answer_count: 2,
      target_count: 2,
      coloring: { targets: { "marker:0": "rest", "shape:2": "rest" } },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("中断・失敗したページは未取得として再試行し、直前の表示用データを保つ", async () => {
    const first = row(0, "x", "f", numeric("3"));
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        as_of: at,
        rows: [first],
        next_cursor: { target: first.target, id: first.id },
      })
      .mockRejectedValueOnce(Error("中断"))
      .mockResolvedValueOnce(page([first]))
      .mockResolvedValueOnce(page([row(0, "x", "f", { s: { type: "text", value: "語" } })]));
    const data = new LocalPresetData(send, {}, targets);
    const a = filter(attribute("f", n("eq", "3")));
    await expect(data.prepare([a], signal)).rejects.toThrow("中断");
    expect(data.ready([a])).toBe(false);
    await data.prepare([a], signal);
    const text = filter(
      attribute("f", { field_id: "s", field_type: "text", op: "contains", value: "語" }),
    );
    await Promise.all([data.prepare([text], signal), data.prepare([text], signal)]);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3][1].forms).toEqual({ f: ["s"] });
    expect(data.evaluate(a).targets).toEqual(["marker:0"]);
    expect(data.evaluate(text).targets).toEqual(["marker:0"]);
  });
});
