import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import {
  createNestedTokenizer,
  disposeMapContent,
  registerProgressiveHtml,
  releaseDeferredDetails,
  renderProgressiveMarkdown,
  setupDetailsLazyImages,
} from "../src/map/common/content";
import { CONTENT_TEXT_BUDGET } from "../src/map/common/progressive-content";

type References = Record<string, { href: string; title: string | null }>;
const sources: string[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let cancelFrame: ReturnType<typeof vi.spyOn>;
const sanitize = (html: string) => (/^<unknown\b/i.test(html) ? "" : html);
const render = (source: string, links?: References) =>
  renderProgressiveMarkdown(source, sanitize, links);

function mount(source: string, asHtml = false) {
  const html = asHtml ? registerProgressiveHtml(source, sanitize) : render(source);
  sources.push(html);
  const host = document.createElement("div");
  host.className = "md-detail-contents";
  host.innerHTML = html;
  document.body.append(host);
  setupDetailsLazyImages(host, render);
  return { html, host, scope: host.querySelector<HTMLElement>(".geocode-progressive-content")! };
}

function more(scope: HTMLElement) {
  return [...scope.querySelectorAll<HTMLButtonElement>(".geocode-content-load-more")].find(
    (button) => !button.hidden && button.closest(".geocode-progressive-content") === scope,
  );
}

function drainFrames() {
  let count = 0;
  while (frames.size) {
    if (++count > 2000) throw Error("Progressive continuation did not finish");
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(performance.now());
  }
  return count;
}

function loadAll(scope: HTMLElement) {
  for (let batches = 0; batches < 1000; batches++) {
    drainFrames();
    const button = more(scope);
    if (!button) return;
    expect(button.disabled).toBe(false);
    button.click();
  }
  throw Error("Progressive body did not finish");
}

function open(details: HTMLDetailsElement) {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}

beforeEach(() => {
  // Verify work and DOM limits independently of CPU/JIT/GC timing.
  vi.spyOn(performance, "now").mockReturnValue(0);
  frames.clear();
  nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const marked = new Marked();
  Object.assign(window, { marked });
  marked.use({
    extensions: ["details", "note", "warning"].map(
      (type) => createNestedTokenizer(type, { renderDeferredBody: render }) as never,
    ),
  });
});

afterEach(() => {
  for (const html of sources.splice(0)) releaseDeferredDetails(html);
  document.body.replaceChildren();
  frames.clear();
  vi.restoreAllMocks();
});

describe("progressive work limits and raw details", () => {
  it("keeps emoji intact at both an HTML input boundary and the text budget boundary", () => {
    const start = '<p data-padding="';
    const end = '">';
    const inputChunkSize = 4096;
    const prefixLength =
      Math.ceil((CONTENT_TEXT_BUDGET + 1) / inputChunkSize) * inputChunkSize - CONTENT_TEXT_BUDGET;
    const prefix = `${start}${"a".repeat(prefixLength - start.length - end.length)}${end}`;
    expect(prefix).toHaveLength(prefixLength);
    const text = `${"x".repeat(CONTENT_TEXT_BUDGET - 1)}😀tail`;
    const html = registerProgressiveHtml(`${prefix}${text}</p>`, (value) => value);
    sources.push(html);
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const scope = host.querySelector<HTMLElement>(".geocode-progressive-content")!;
    const snapshots: string[] = [];
    scope.addEventListener("change", () => {
      snapshots.push(scope.querySelector(".geocode-content-body")?.textContent ?? "");
    });
    setupDetailsLazyImages(host, render);
    expect(more(scope)).toBeDefined();
    expect(scope.querySelector(".geocode-content-body")!.textContent!.length).toBeLessThan(
      text.length,
    );
    loadAll(scope);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of snapshots) {
      expect(/[\uD800-\uDBFF]$/.test(snapshot)).toBe(false);
      expect(text.startsWith(snapshot)).toBe(true);
    }
    expect(scope.querySelector(".geocode-content-body")!.textContent).toBe(text);
  });

  it("yields while dropping 100,000 unknown tags instead of scanning all work synchronously", () => {
    const f = mount(`${"<unknown></unknown>".repeat(100_000)}<p>visible end</p>`, true);
    expect(f.host.querySelector("unknown")).toBeNull();
    expect(f.host.querySelector("p")).toBeNull();
    expect(more(f.scope)?.disabled).toBe(true);
    expect(frames.size).toBeGreaterThan(0);
    expect(drainFrames()).toBeGreaterThan(1);
    expect(f.host.querySelector("p")?.textContent).toBe("visible end");
    expect(more(f.scope)).toBeUndefined();
    expect(f.host.querySelector("unknown")).toBeNull();
  });

  it("yields even when a 9 MB script body produces no visible DOM", () => {
    const f = mount(`<script>${"x".repeat(9_000_000)}</script><p>safe end</p>`, true);
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("p")).toBeNull();
    expect(more(f.scope)?.disabled).toBe(true);
    expect(frames.size).toBeGreaterThan(0);
    drainFrames();
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("p")?.textContent).toBe("safe end");
    expect(f.host.textContent).not.toContain("xxxxx");
  });

  it("cancels a pending continuation on disposal and ignores a stale frame callback", () => {
    const f = mount(`${"<unknown></unknown>".repeat(100_000)}<p>not after close</p>`, true);
    const callbacks = [...frames.values()];
    expect(callbacks.length).toBeGreaterThan(0);
    disposeMapContent(f.host);
    expect(cancelFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    const before = f.host.innerHTML;
    for (const callback of callbacks) callback(performance.now());
    expect(f.host.innerHTML).toBe(before);
    expect(f.host.querySelector("p")).toBeNull();
  });

  it("keeps a raw HTML details body absent while rendering content after it", () => {
    const body = Array.from({ length: 800 }, (_, i) => `<p>raw ${i}</p>`).join("");
    const f = mount(`<details><summary>Raw title</summary>${body}</details><p>outside</p>`);
    const details = f.host.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("p")).toBeNull();
    expect([...f.host.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["outside"]);
    open(details);
    expect(details.querySelectorAll("p").length).toBeGreaterThan(0);
    expect(details.querySelectorAll("p").length).toBeLessThan(800);
    loadAll(details.querySelector<HTMLElement>(".geocode-progressive-content")!);
    expect([...details.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      Array.from({ length: 800 }, (_, i) => `raw ${i}`),
    );
    expect(f.host.querySelector("p")?.closest("details")).toBe(details);
    expect([...f.host.querySelectorAll("p")].at(-1)?.textContent).toBe("outside");
  });

  it("preserves real Markdown blocks inside raw HTML details across blank lines", () => {
    const body = Array.from({ length: 500 }, (_, i) => `Paragraph ${i}: **strong**`).join("\n\n");
    const f = mount(
      `<details>\n<summary>Mixed title</summary>\n\n${body}\n\n</details>\n\noutside`,
    );
    const details = f.host.querySelector<HTMLDetailsElement>("details")!;
    expect(details.querySelector("p")).toBeNull();
    expect(f.host.querySelector("p")?.textContent).toBe("outside");
    open(details);
    const scope = details.querySelector<HTMLElement>(".geocode-progressive-content")!;
    expect(details.querySelectorAll("p").length).toBeLessThan(500);
    loadAll(scope);
    expect([...details.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      Array.from({ length: 500 }, (_, i) => `Paragraph ${i}: strong`),
    );
    expect(details.querySelectorAll("strong")).toHaveLength(500);
  });

  it("keeps nested raw details independent and preserves their literal HTML body", () => {
    const childBody = Array.from({ length: 600 }, (_, i) => `<p>**literal ${i}**</p>`).join("");
    const f = mount(
      `<details><summary>Parent</summary><p>parent before</p><details><summary>Child</summary>${childBody}</details><p>parent after</p></details><p>outside</p>`,
    );
    const parent = f.host.querySelector<HTMLDetailsElement>("details")!;
    expect(parent.querySelector("details")).toBeNull();
    expect(parent.querySelector("p")).toBeNull();
    expect(f.host.querySelector("p")?.textContent).toBe("outside");
    open(parent);
    const child = parent.querySelector<HTMLDetailsElement>("details")!;
    expect(child.querySelector("p")).toBeNull();
    expect([...parent.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "parent before",
      "parent after",
    ]);
    open(child);
    const childScope = child.querySelector<HTMLElement>(".geocode-progressive-content")!;
    expect(child.querySelectorAll("p").length).toBeLessThan(600);
    loadAll(childScope);
    expect([...child.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      Array.from({ length: 600 }, (_, i) => `**literal ${i}**`),
    );
    expect(child.querySelector("strong")).toBeNull();
    expect(parent.querySelectorAll("summary")).toHaveLength(2);
  });

  it("preserves an explicit open attribute on raw HTML details", () => {
    const f = mount(
      "<details open><summary>Already open</summary><p>visible body</p></details><p>outside</p>",
    );
    const details = f.host.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(true);
    expect(details.querySelector("p")?.textContent).toBe("visible body");
    expect([...f.host.querySelectorAll("p")].at(-1)?.textContent).toBe("outside");
  });
});
