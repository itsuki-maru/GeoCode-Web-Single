import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPopupContentRuntime } from "../src/map/common/popup-content";
// The runtime must use the page sanitizer for both Markdown and analysis HTML.
const filterXSS = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ onerror=[^ >]*/gi, "");

function fixture(overrides: Record<string, any> = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const loadBody = vi.fn(async () => ({
    body: "自由\n回答",
    free_text: "自由\n",
    managed_markdown: "回答",
    sync_required: false,
  }));
  const setupImages = vi.fn();
  const runtime = createPopupContentRuntime({
    map: {
      on: (event, fn) => {
        handlers[event] = fn;
      },
    },
    renderMarkdown: (text) => filterXSS(`<p>${text}</p>`),
    sanitizeHtml: (html) => filterXSS(html),
    setupImages,
    loadBody,
    ...overrides,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const popup = { getElement: () => host, update: vi.fn() };
  const open = (kind: "marker" | "shape" = "marker", body = "自由\n回答") => {
    host.innerHTML = runtime.render({ kind, id: "same", name: "<対象>", body });
    handlers.popupopen({ popup });
  };
  const select = () => host.querySelector("select")!;
  const choose = (mode: string) => {
    select().value = mode;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  };
  return { runtime, host, popup, handlers, open, select, choose, loadBody, setupImages };
}
afterEach(() => {
  document.body.innerHTML = "";
});
describe("owner popup content selector", () => {
  it("enables selector styling only in the five requested templates", () => {
    const templates = resolve(process.cwd(), "../../src/templates");
    const actual = readdirSync(templates).filter(
      (name) =>
        name.endsWith(".html") &&
        readFileSync(resolve(templates, name), "utf-8").includes("/assets/popup-content.css"),
    );
    expect(actual.sort()).toEqual(
      [
        "map.html",
        "map-mobile.html",
        "map-anather.html",
        "form-answer-map.html",
        "form-answer-map-print.html",
      ].sort(),
    );
  });
  it.each(["marker", "shape"] as const)(
    "%s defaults to normal and separates Markdown without changing stored content",
    async (kind) => {
      const f = fixture();
      f.open(kind);
      await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
      expect(f.select().value).toBe("normal");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n回答");
      f.choose("free");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n");
      f.choose("answers");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("回答");
      expect(f.host.querySelector("h1")!.textContent).toBe("<対象>");
      expect(f.setupImages).toHaveBeenCalled();
      f.handlers.popupclose({ popup: f.popup });
      f.open(kind);
      await vi.waitFor(() => expect(f.select().options[0].disabled).toBe(false));
      expect(f.select().value).toBe("normal");
      expect(f.loadBody).toHaveBeenCalledTimes(1);
    },
  );
  it("retains the analysis header for every mode and uses frozen print data without requests", () => {
    const f = fixture({
      answerMap: true,
      snapshot: {
        "shape:same": { free_text: "自由", managed_markdown: "回答", sync_required: false },
      },
    });
    f.runtime.setAnalysis("shape:same", "<strong>分析値</strong>");
    f.open("shape");
    for (const mode of ["free", "answers", "normal"]) {
      f.choose(mode);
      expect(f.host.querySelector(".popup-content-analysis")!.textContent).toBe("分析値");
    }
    f.choose("answers");
    expect(f.host.querySelector(".popup-content-note")!.textContent).toContain("すべて");
    expect(f.loadBody).not.toHaveBeenCalled();
  });
  it("shows explicit empty messages and sanitizes Markdown and print analysis", () => {
    const f = fixture({
      snapshot: {
        "marker:same": {
          free_text: "",
          managed_markdown: "<script>alert(1)</script>",
          sync_required: false,
        },
      },
      analysis: { "marker:same": "<img src=x onerror=alert(1)>" },
    });
    f.open();
    f.choose("free");
    expect(f.host.textContent).toContain("自由入力の内容はありません");
    f.choose("answers");
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("[onerror]")).toBeNull();
  });
  it.each(["ambiguous", "failed", "stale", "missing"])(
    "keeps normal content when %s",
    async (mode) => {
      const f = fixture({
        loadBody: async () => {
          if (mode === "failed") throw Error("network");
          if (mode === "missing") return {};
          return {
            body: mode === "stale" ? "変更後" : "自由\n回答",
            free_text: "自由",
            managed_markdown: "回答",
            sync_required: mode === "ambiguous",
          };
        },
      });
      f.open();
      await vi.waitFor(() =>
        expect(f.host.querySelector(".popup-content-note")!.textContent).not.toContain(
          "確認しています",
        ),
      );
      expect(f.select().options[0].disabled).toBe(true);
      expect(f.select().value).toBe("normal");
      expect(f.host.querySelector(".popup-content-body")!.textContent).toBe("自由\n回答");
    },
  );
  it("does not overwrite a newer popup after an old request resolves", async () => {
    let resolve!: (value: any) => void;
    const f = fixture({
      loadBody: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    f.open();
    f.handlers.popupclose({ popup: f.popup });
    f.host.innerHTML = "別のポップアップ";
    resolve({
      body: "自由\n回答",
      free_text: "自由",
      managed_markdown: "回答",
      sync_required: false,
    });
    await Promise.resolve();
    expect(f.host.innerHTML).toBe("別のポップアップ");
  });
});
