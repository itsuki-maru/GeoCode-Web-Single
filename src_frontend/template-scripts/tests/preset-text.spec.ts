import { expect, it, vi } from "vitest";
import { LocalPresetData } from "../src/map/common/local-preset";

const filter = (term: string) => ({
  type: "filter" as const,
  expression: { op: "text", query1: term },
});
const scope = [
  { key: "marker:1", name: "学校 Ａ", detail: "ΟΣ / I\u0307 / I\u0301 / K" },
  { key: "shape:2", name: "道路 ａ", detail: "ος / i / k" },
];
const signal = new AbortController().signal;
it.each(["C", "tr", "lt"] as const)(
  "照合規則%sで名前・メモ・検索語を同じように小文字化する",
  async (locale) => {
    const lower = (v: string) =>
      locale === "C" ? v.replace(/[A-Z]/g, (c) => c.toLowerCase()) : v.toLocaleLowerCase(locale);
    const transport = vi.fn(async (path, body) => {
      expect(path).toBe("/form-answers/map-presets/text-fold");
      return body.fragments.map(lower);
    });
    const data = new LocalPresetData(transport, {}, scope);
    await data.prepare([filter("学校")], signal);
    expect(data.evaluate(filter("学校")).targets).toEqual(["marker:1"]);
    expect(transport).not.toHaveBeenCalled();
    const terms = ["ａ", "ς", "i", "k", "i\u0307\u0301"];
    const defs = terms.map(filter);
    await data.prepare(defs, signal);
    expect(transport).toHaveBeenCalledTimes(1);
    const words = transport.mock.calls[0][1].fragments;
    expect(new Set(words).size).toBe(words.length);
    expect(words).toEqual(expect.arrayContaining(["Ａ", "ΟΣ", "I\u0307", "K"]));
    expect(words).not.toContain(scope[0].detail);
    for (const term of terms) {
      const expected = scope
        .filter((t) => [t.name, t.detail].some((s) => lower(s).includes(lower(term))))
        .map((t) => t.key);
      expect(data.evaluate(filter(term)).targets).toEqual(expected);
    }
    await data.prepare(defs, signal);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it("長い語にあるΣの前後関係を保ち、同じ断片を一度だけ取得する", async () => {
  const word = "Σ".repeat(16000);
  const target = { key: "shape:s", name: word, detail: "" };
  const send = vi.fn(async (_path, body) => body.fragments.map((s: string) => s.toLowerCase()));
  const data = new LocalPresetData(send, {}, [target]);
  await data.prepare([filter("ς"), filter("σσ")], signal);
  expect(data.evaluate(filter("ς")).targets).toEqual([target.key]);
  expect(data.evaluate(filter("σσ")).targets).toEqual([target.key]);
  expect(Math.max(...send.mock.calls[0][1].fragments.map((s: string) => s.length))).toBeLessThan(
    4100,
  );
});

it("未取得・中断した照合情報は実行に使わず、部分取得を再試行できる", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockImplementation(async (_path, body) => body.fragments.map((s: string) => s.toLowerCase()));
  const data = new LocalPresetData(send, {}, scope);
  const def = filter("ａ");
  await expect(data.prepare([def], signal)).rejects.toThrow("照合情報");
  expect(data.ready([def])).toBe(false);
  expect(() => data.evaluate(def)).toThrow();
  await data.prepare([def], signal);
  expect(data.ready([def])).toBe(true);
});
