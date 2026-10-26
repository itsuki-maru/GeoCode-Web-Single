import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import {
  createNestedTokenizer,
  disposeMapContent,
  releaseDeferredDetails,
  renderProgressiveMarkdown,
  setupDetailsLazyImages,
} from "../src/map/common/content";
import { CONTENT_ELEMENT_BUDGET, CONTENT_TEXT_BUDGET } from "../src/map/common/progressive-content";

type References = Record<string, { href: string; title: string | null }>;
const sources: string[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const sanitize = (html: string) => html.replace(/\s+onerror="[^"]*"/gi, "");
const render = (source: string, links?: References) =>
  renderProgressiveMarkdown(source, sanitize, links);
const paragraphs = (count: number, label = "段落") =>
  Array.from({ length: count }, (_, i) => `${label} ${i}：**太字**と*強調*。`).join("\n\n");
const paragraphText = (count: number, label = "段落") =>
  Array.from({ length: count }, (_, i) => `${label} ${i}：太字と強調。`);

function mount(source: string) {
  const html = render(source);
  sources.push(html);
  const host = document.createElement("div");
  host.className = "md-detail-contents";
  host.innerHTML = html;
  document.body.append(host);
  setupDetailsLazyImages(host, render);
  return { host, scope: host.querySelector<HTMLElement>(".geocode-progressive-content")! };
}

function body(scope: HTMLElement) {
  return scope.querySelector<HTMLElement>(":scope > .geocode-content-body")!;
}

function button(scope: HTMLElement, kind: "more" | "all") {
  return scope.querySelector<HTMLButtonElement>(
    `:scope > .geocode-content-controls > .geocode-content-load-${kind}`,
  );
}

function snapshot(scope: HTMLElement) {
  const content = body(scope);
  return { elements: content.querySelectorAll("*").length, text: content.textContent!.length };
}

function runFrame() {
  const callbacks = [...frames.entries()];
  for (const [id] of callbacks) frames.delete(id);
  for (const [, callback] of callbacks) callback(performance.now());
}

function drainFrames() {
  let count = 0;
  while (frames.size) {
    if (++count > 1000) throw Error("Automatic content loading did not finish");
    runFrame();
  }
  return count;
}

function toggle(details: HTMLDetailsElement, opened: boolean) {
  details.open = opened;
  details.dispatchEvent(new Event("toggle"));
}

beforeEach(() => {
  frames.clear();
  nextFrame = 0;
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("automatic loading of the remaining popup body", () => {
  it("offers both actions in order without the redundant continuation message", () => {
    const f = mount(paragraphs(1500));
    const more = button(f.scope, "more")!;
    const all = button(f.scope, "all")!;
    expect(more.textContent).toBe("さらに読み込む");
    expect(all.textContent).toBe("続きを全て読み込む");
    expect(more.nextElementSibling).toBe(all);
    expect(more.getAttribute("aria-controls")).toBe(body(f.scope).id);
    expect(all.getAttribute("aria-controls")).toBe(body(f.scope).id);
    expect(f.host.textContent).not.toContain("続きがあります");
    const before = snapshot(f.scope);
    more.click();
    const after = snapshot(f.scope);
    expect(after.elements).toBeGreaterThan(before.elements);
    expect(after.elements - before.elements).toBeLessThanOrEqual(CONTENT_ELEMENT_BUDGET);
    expect(after.text - before.text).toBeLessThanOrEqual(CONTENT_TEXT_BUDGET);
    expect(frames.size).toBe(0);
    expect(more.disabled).toBe(false);
    expect(all.disabled).toBe(false);
  });

  it("adds all remaining content across bounded frames after one click", () => {
    const count = 1500;
    const f = mount(paragraphs(count));
    const first = body(f.scope).querySelector("p")!;
    const more = button(f.scope, "more")!;
    const all = button(f.scope, "all")!;
    const before = snapshot(f.scope);
    all.focus();
    all.click();
    const afterClick = snapshot(f.scope);
    expect(afterClick.elements).toBeGreaterThan(before.elements);
    expect(afterClick.elements - before.elements).toBeLessThanOrEqual(CONTENT_ELEMENT_BUDGET);
    expect(body(f.scope).querySelectorAll("p").length).toBeLessThan(count);
    expect(more.disabled).toBe(true);
    expect(all.disabled).toBe(true);
    expect(f.scope.querySelector('[role="status"]')?.textContent).toBe("読み込み中…");
    expect(document.activeElement).toBe(f.scope.querySelector('[role="status"]'));
    expect(frames.size).toBeGreaterThan(0);
    const pending = frames.size;
    const unchanged = body(f.scope).innerHTML;
    all.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(frames.size).toBe(pending);
    expect(body(f.scope).innerHTML).toBe(unchanged);
    let previous = afterClick;
    let frameCount = 0;
    while (frames.size) {
      expect(++frameCount).toBeLessThan(1000);
      runFrame();
      const current = snapshot(f.scope);
      expect(current.elements - previous.elements).toBeLessThanOrEqual(CONTENT_ELEMENT_BUDGET);
      expect(current.text - previous.text).toBeLessThanOrEqual(CONTENT_TEXT_BUDGET);
      previous = current;
    }
    expect(frameCount).toBeGreaterThan(1);
    expect([...body(f.scope).querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      paragraphText(count),
    );
    expect(body(f.scope).querySelector("p")).toBe(first);
    expect(first.isConnected).toBe(true);
    expect(more.hidden).toBe(true);
    expect(all.hidden).toBe(true);
    const status = f.scope.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe("すべて表示しました");
    expect(document.activeElement).toBe(status);
    expect(body(f.scope).hasAttribute("aria-busy")).toBe(false);
  });

  it("preserves focus moved by the user while automatic loading continues", () => {
    const f = mount(`[別のリンク](#elsewhere)\n\n${paragraphs(1500)}`);
    const all = button(f.scope, "all")!;
    const link = body(f.scope).querySelector<HTMLAnchorElement>("a")!;
    const status = f.scope.querySelector<HTMLElement>('[role="status"]')!;
    all.focus();
    all.click();
    expect(document.activeElement).toBe(status);
    runFrame();
    expect(all.hidden).toBe(false);
    link.focus();
    expect(document.activeElement).toBe(link);
    drainFrames();
    expect(all.hidden).toBe(true);
    expect(status.textContent).toBe("すべて表示しました");
    expect(document.activeElement).toBe(link);
  });

  it("does not add controls for an already complete short body", () => {
    const f = mount("短い本文です。");
    expect(body(f.scope).querySelector("p")?.textContent).toBe("短い本文です。");
    expect(button(f.scope, "more")).toBeNull();
    expect(button(f.scope, "all")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("leaves closed details unmaterialized while loading the entire outside body", () => {
    const f = mount(
      `:::details 閉じた節\n${paragraphs(800, "内側")}\n:::\n\n${paragraphs(1500, "外側")}`,
    );
    const details = f.host.querySelector<HTMLDetailsElement>("details")!;
    button(f.scope, "all")!.click();
    drainFrames();
    expect(details.open).toBe(false);
    expect(details.querySelector("p")).toBeNull();
    expect([...body(f.scope).querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      paragraphText(1500, "外側"),
    );
  });

  it("keeps an opened child body independent from its parent's load-all action", () => {
    const f = mount(
      `:::details 親\n:::details 子\n${paragraphs(1000, "子")}\n:::\n\n${paragraphs(1500, "親")}\n:::`,
    );
    const parent = f.host.querySelector<HTMLDetailsElement>("details")!;
    toggle(parent, true);
    const parentScope = parent.querySelector<HTMLElement>(".geocode-progressive-content")!;
    const child = parent.querySelector<HTMLDetailsElement>("details")!;
    toggle(child, true);
    const childScope = child.querySelector<HTMLElement>(".geocode-progressive-content")!;
    const childHtml = body(childScope).innerHTML;
    button(parentScope, "all")!.click();
    drainFrames();
    expect(parent.open).toBe(true);
    expect(child.open).toBe(true);
    expect(body(childScope).innerHTML).toBe(childHtml);
    expect(button(childScope, "all")!.hidden).toBe(false);
    expect(button(childScope, "all")!.disabled).toBe(false);
    expect(
      [...body(parentScope).querySelectorAll("p")]
        .filter((p) => p.closest(".geocode-progressive-content") === parentScope)
        .map((p) => p.textContent),
    ).toEqual(paragraphText(1500, "親"));
  });

  it.each([false, true])(
    "pauses and resumes when a containing details is closed (nested: %s)",
    (nested) => {
      const section = `:::details 節\n${paragraphs(1500)}\n:::`;
      const f = mount(nested ? `:::details 外側\n${section}\n:::` : section);
      const container = f.host.querySelector<HTMLDetailsElement>("details")!;
      toggle(container, true);
      const details = nested ? container.querySelector<HTMLDetailsElement>("details")! : container;
      if (nested) toggle(details, true);
      const scope = details.querySelector<HTMLElement>(".geocode-progressive-content")!;
      button(scope, "all")!.click();
      const pausedHtml = body(scope).innerHTML;
      toggle(container, false);
      drainFrames();
      expect(body(scope).innerHTML).toBe(pausedHtml);
      toggle(container, true);
      expect(frames.size).toBeGreaterThan(0);
      drainFrames();
      expect([...body(scope).querySelectorAll("p")].map((p) => p.textContent)).toEqual(
        paragraphText(1500),
      );
      expect(button(scope, "all")!.hidden).toBe(true);
    },
  );

  it("automatically completes with timers when animation frames are unavailable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", undefined);
    const f = mount(paragraphs(1500));
    button(f.scope, "all")!.click();
    expect(body(f.scope).querySelectorAll("p").length).toBeLessThan(1500);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(frames.size).toBe(0);
    vi.runAllTimers();
    expect([...body(f.scope).querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      paragraphText(1500),
    );
    expect(button(f.scope, "all")!.hidden).toBe(true);
  });

  it("cancels automatic loading on disposal and ignores an already queued callback", () => {
    const f = mount(paragraphs(1500));
    button(f.scope, "all")!.click();
    const staleCallbacks = [...frames.values()];
    expect(staleCallbacks.length).toBeGreaterThan(0);
    const before = body(f.scope).innerHTML;
    disposeMapContent(f.host);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    for (const callback of staleCallbacks) callback(0);
    expect(body(f.scope).innerHTML).toBe(before);
  });

  it("sanitizes later HTML and retains forward image references during automatic loading", () => {
    const f = mount(
      `${paragraphs(1500)}\n\n![参照画像][later]\n\n<img src="/safe.jpg" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[later]: /reference.jpg`,
    );
    expect(f.host.querySelector("img")).toBeNull();
    button(f.scope, "all")!.click();
    drainFrames();
    expect([...f.host.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
      "/reference.jpg",
      "/safe.jpg",
    ]);
    expect(f.host.querySelector("[onerror],script")).toBeNull();
  });
});
