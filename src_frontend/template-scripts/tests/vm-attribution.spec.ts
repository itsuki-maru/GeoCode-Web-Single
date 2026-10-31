// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import v8 from "@vitest/coverage-v8";
import module from "./support/vm-coverage-provider.mjs";
import { VmCoverageProvider } from "./support/vm-coverage-server.mjs";
import { runSource } from "./support/vm-source";

afterEach(() => vi.restoreAllMocks());
const source = "src/map/editor/map-editor-shape-metadata.ts";
it("executes the whole original source in strict mode and keeps its public behavior", () => {
  const context = createContext({});
  runSource(context, source);
  expect(context.mergeShapeFreeText({ free_text: "a", body: "a-answer", parts: [] }, "a")).toBe(
    "a-answer",
  );
  expect(typeof context.initializeEditorShapeRendering).toBe("function");
});
it("does not accept a sliced string or a path outside production sources", () => {
  expect(() => runSource(createContext({}), "tests/vm-attribution.spec.ts")).toThrow("complete");
  expect(() => runSource(createContext({}), "../frontend/src/App.vue")).toThrow("complete");
});
it("returns the exact executed text and refuses a source/hash mismatch", async () => {
  const code = readFileSync(source, "utf8");
  const url = pathToFileURL(resolve(source));
  url.searchParams.set("geocode-vm", createHash("sha256").update(code).digest("hex"));
  const provider = new VmCoverageProvider();
  const transform = vi.fn();
  expect(await provider.getSources(url.href, transform)).toEqual({ code });
  expect(transform).not.toHaveBeenCalled();
  url.searchParams.set("geocode-vm", "different");
  await expect(provider.getSources(url.href, transform)).rejects.toThrow("changed");
});
it("delegates ordinary modules to the standard V8 source handling", async () => {
  const transform = vi.fn().mockResolvedValue({ code: "const x = 1;" });
  expect(
    await new VmCoverageProvider().getSources(pathToFileURL(resolve(source)).href, transform),
  ).toEqual({ code: "const x = 1;", map: undefined });
  expect(transform).toHaveBeenCalledTimes(1);
});
it("subtracts only the strict prefix from VM offsets, preserving ordinary module offsets", async () => {
  const url = pathToFileURL(resolve(source));
  url.searchParams.set("geocode-vm", "test");
  const coverage = {
    result: [
      { url: url.href, startOffset: 0 },
      { url: pathToFileURL(resolve(source)).href, startOffset: 19 },
    ],
  };
  vi.spyOn(v8, "takeCoverage").mockResolvedValue(coverage as any);
  expect((await module.takeCoverage({})).result.map((r: any) => r.startOffset)).toEqual([14, 19]);
});
