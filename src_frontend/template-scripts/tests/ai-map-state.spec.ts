import { expect, it, vi } from "vitest";
import { mergeAiColoring, intersectTargetMasks } from "../src/ai/map-state";
import { aiFetchTransport, aiFailureMessage, validateCapabilities, validateExecutionResult } from "../src/ai/types";

it("preserves manual colors and gives AI priority only for classified targets", () => {
  const manual = {
    version: 1 as const,
    rules: [{ id: "same", label: "手動", color: "#ff0000" }],
    targets: { "marker:a": "same", "shape:b": "same" },
  };
  const ai = {
    version: 1 as const,
    rules: [{ id: "same", label: "AI", color: "#0000ff" }],
    targets: { "marker:a": "same" },
  };
  const merged = mergeAiColoring(manual, ai)!;
  expect(merged.targets).toEqual({ "marker:a": "ai-0", "shape:b": "manual-0" });
  expect(mergeAiColoring(manual, null)).toEqual(manual);
  expect(manual.targets["marker:a"]).toBe("same");
});

it("keeps empty AI search results empty when combined with manual filters", () => {
  expect([...intersectTargetMasks(new Set(["marker:a"]), new Set())!]).toEqual([]);
  expect(intersectTargetMasks(null, null)).toBeNull();
  expect([...intersectTargetMasks(new Set(["a", "b"]), new Set(["b", "c"]))!]).toEqual(["b"]);
});

it("rejects malformed targets, arbitrary CSS colors, and invalid map coordinates", () => {
  expect(() =>
    validateExecutionResult({ type: "filter", targets: ["marker:a", "marker:a"], target_count: 2 }),
  ).toThrow();
  expect(() =>
    validateExecutionResult({
      type: "color",
      coloring: { version: 1, rules: [{ id: "r", label: "r", color: "url(evil)" }], targets: {} },
    }),
  ).toThrow();
  expect(() =>
    validateExecutionResult({ type: "focus", latitude: Infinity, longitude: 139 }),
  ).toThrow();
  expect(validateExecutionResult({ type: "filter", targets: [], target_count: 0 }).targets).toEqual(
    [],
  );
});

it("accepts the disabled initial capability revision without accepting an enabled null revision", () => {
  expect(
    validateCapabilities({ enabled: false, voice_enabled: false, revision: null }).revision,
  ).toBe("");
  expect(() =>
    validateCapabilities({ enabled: true, voice_enabled: true, revision: null }),
  ).toThrow();
});

it("keeps the original actor header across token refresh and sends multipart without a JSON content type", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 401 }))
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ text: "音声" })));
  const body = new FormData();
  body.append("audio", new Blob(["voice"], { type: "audio/webm" }));
  try {
    await aiFetchTransport("/ai/transcribe", body, new AbortController().signal, "original-actor");
    for (const index of [0, 2]) {
      const init = fetcher.mock.calls[index]![1]!;
      expect(init.headers).toEqual({ "X-AI-Account-ID": "original-actor" });
      expect(init.body).toBe(body);
    }
  } finally {
    fetcher.mockRestore();
  }
});

it("uses the original actor for write-result lookup and normalizes only the denied-operation code", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 401 }))
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));
  try {
    await aiFetchTransport("/ai/operations/op-id", undefined, new AbortController().signal, "owner-at-prepare");
    for (const index of [0, 2]) {
      expect(fetcher.mock.calls[index]![1]!.headers).toEqual({ "X-AI-Account-ID": "owner-at-prepare" });
      expect(fetcher.mock.calls[index]![1]!.method).toBe("GET");
    }
  } finally { fetcher.mockRestore(); }
  expect(aiFailureMessage({ code: "ai_operation_not_allowed", error: "forbidden: arbitrary" }, "fallback"))
    .toBe("要求された操作は許可されていません。");
  expect(aiFailureMessage({ error: "ai_account_changed" }, "fallback")).toBe("ai_account_changed");
  expect(aiFailureMessage({ error: "validation error: invalid form" }, "fallback")).toBe("invalid form");
});
