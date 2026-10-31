import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import {
  createNestedTokenizer,
  releaseDeferredDetails,
  renderProgressiveMarkdown,
  setupDetailsLazyImages,
} from "../src/map/common/content";
import { CONTENT_ELEMENT_BUDGET, CONTENT_TEXT_BUDGET } from "../src/map/common/progressive-content";

type References = Record<string, { href: string; title: string | null }>;
const sources: string[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const imageRenderer = vi.fn(({ href }: { href: string }) => `<img src="${href}">`);
const sanitize = vi.fn((html: string) =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/\s+onerror="[^"]*"/gi, ""),
);
const render = (markdown: string, links?: References) =>
  renderProgressiveMarkdown(markdown, sanitize, links);
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `段落 ${i}：**太字**と*強調*。`).join("\n\n");
const photos = (count: number, prefix = "") =>
  Array.from({ length: count }, (_, i) => `![photo ${i}](/images/${prefix}${i}.jpg)`).join("\n\n");
function mount(markdown: string, initialize = true) {
  const html = render(markdown);
  sources.push(html);
  const host = document.createElement("div");
  host.className = "md-detail-contents";
  host.innerHTML = html;
  document.body.append(host);
  if (initialize) setupDetailsLazyImages(host, render);
  return { host, html, scope: host.querySelector<HTMLElement>(".geocode-progressive-content")! };
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
    if (!button) return batches;
    expect(button.disabled).toBe(false);
    button.click();
  }
  throw Error("Progressive content did not finish");
}
function open(details: HTMLDetailsElement) {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}
beforeEach(() => {
  // コンテンツ量と処理量の上限は一定とし、時間を確認するケースでは時計を明示的に置き換える。
  vi.spyOn(performance, "now").mockReturnValue(0);
  frames.clear();
  nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
  const marked = new Marked();
  Object.assign(window, { marked });
  imageRenderer.mockClear();
  sanitize.mockClear();
  marked.use({ renderer: { image: imageRenderer } });
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

describe("whole popup content through the Markdown renderer", () => {
  it("mounts no body DOM before setup and renders a bounded prefix without images", () => {
    const f = mount(paragraphs(3000), false);
    expect(f.host.querySelectorAll("p")).toHaveLength(0);
    expect(sanitize).not.toHaveBeenCalled();
    setupDetailsLazyImages(f.host, render);
    const initial = f.host.querySelectorAll("p").length;
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(3000);
    expect(f.host.querySelectorAll("*").length).toBeLessThanOrEqual(CONTENT_ELEMENT_BUDGET + 12);
    expect(more(f.scope)?.textContent).toBe("さらに読み込む");
    const first = f.host.querySelector("p")!;
    more(f.scope)!.click();
    expect(f.host.querySelectorAll("p").length).toBeGreaterThan(initial);
    expect(first.isConnected).toBe(true);
    expect(f.host.querySelector("p")).toBe(first);
  });
  it("resumes an initially empty prefix on the next frame after the time budget is exhausted", () => {
    vi.spyOn(performance, "now").mockReturnValue(25).mockReturnValueOnce(0);
    const f = mount(paragraphs(600));
    expect(f.host.querySelector("p")).toBeNull();
    expect(more(f.scope)?.disabled).toBe(true);
    expect(frames.size).toBeGreaterThan(0);

    // 操作部品が無効な間でも、再度クリックする前に待機中の処理を完了させる。
    expect(loadAll(f.scope)).toBeGreaterThan(0);
    expect([...f.host.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      Array.from({ length: 600 }, (_, i) => `段落 ${i}：太字と強調。`),
    );
    expect(frames.size).toBe(0);
    expect(more(f.scope)).toBeUndefined();
  });
  it("keeps small bodies complete without a visible load-more button", () => {
    const f = mount("## 見出し\n\n短い文章です。");
    expect(f.host.querySelector("h2")?.textContent).toBe("見出し");
    expect(f.host.querySelector("p")?.textContent).toBe("短い文章です。");
    expect(more(f.scope)).toBeUndefined();
  });
  it("renders the full prose in its original order without replacing the prefix", () => {
    const f = mount(paragraphs(600));
    const first = f.host.querySelector("p")!;
    expect(loadAll(f.scope)).toBeGreaterThan(0);
    expect([...f.host.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      Array.from({ length: 600 }, (_, i) => `段落 ${i}：太字と強調。`),
    );
    expect(f.host.querySelectorAll("strong")).toHaveLength(600);
    expect(f.host.querySelectorAll("em")).toHaveLength(600);
    expect(first.isConnected).toBe(true);
  });
  it("defers later dates and paragraphs together with the rest of the body", () => {
    const markdown = Array.from(
      { length: 400 },
      (_, i) => `### 日付 ${i}\n\n説明 ${i}\n\n![photo ${i}](/images/${i}.jpg)`,
    ).join("\n\n");
    const f = mount(markdown);
    expect(f.host.querySelectorAll("h3").length).toBeLessThan(400);
    expect(f.host.textContent).not.toContain("日付 399");
    expect(f.host.querySelectorAll(".geocode-image-load-more")).toHaveLength(0);
    expect(f.host.querySelectorAll(".geocode-content-load-more")).toHaveLength(1);
    loadAll(f.scope);
    expect([...f.host.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(
      Array.from({ length: 400 }, (_, i) => `日付 ${i}`),
    );
    expect(f.host.querySelectorAll("img")).toHaveLength(400);
  });
  it("limits a single huge paragraph while retaining its link and emphasis", () => {
    const text = "長い文章です。".repeat(5000);
    const f = mount(`[**${text}**](https://example.test/document)`);
    const firstStrong = f.host.querySelector("strong")!;
    expect(firstStrong.textContent!.length).toBeLessThan(text.length);
    expect(firstStrong.textContent!.length).toBeLessThanOrEqual(CONTENT_TEXT_BUDGET);
    loadAll(f.scope);
    expect(f.host.querySelectorAll("p")).toHaveLength(1);
    expect(f.host.querySelectorAll("a")).toHaveLength(1);
    expect(f.host.querySelector("a")?.getAttribute("href")).toBe("https://example.test/document");
    expect(f.host.querySelector("strong")?.textContent).toBe(text);
    expect(firstStrong.isConnected).toBe(true);
  });
  it("keeps one ordered list and its starting number while appending its items", () => {
    const f = mount(Array.from({ length: 1500 }, (_, i) => `${i + 5}. 項目 ${i}`).join("\n"));
    const list = f.host.querySelector("ol")!;
    expect(f.host.querySelectorAll("li").length).toBeLessThan(1500);
    loadAll(f.scope);
    expect(f.host.querySelectorAll("ol")).toHaveLength(1);
    expect(list.getAttribute("start")).toBe("5");
    expect([...list.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(
      Array.from({ length: 1500 }, (_, i) => `項目 ${i}`),
    );
  });
  it("appends a large table without duplicating its header or losing cells", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `| 行${i} | 済 | 備考${i} |`).join("\n");
    const f = mount(`| 名前 | 状態 | 備考 |\n| --- | --- | --- |\n${rows}`);
    expect(f.host.querySelectorAll("td").length).toBeLessThan(3000);
    loadAll(f.scope);
    expect(f.host.querySelectorAll("table")).toHaveLength(1);
    expect([...f.host.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
      "名前",
      "状態",
      "備考",
    ]);
    expect([...f.host.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(
      Array.from({ length: 1000 }, (_, i) => [`行${i}`, "済", `備考${i}`]).flat(),
    );
  });
  it("limits a huge code block and restores its literal content", () => {
    const code = Array.from({ length: 3000 }, (_, i) => `const value${i} = "<tag>";`).join("\n");
    const f = mount(`\`\`\`typescript\n${code}\n\`\`\``);
    expect(f.host.querySelector("code")!.textContent!.length).toBeLessThan(code.length);
    loadAll(f.scope);
    expect(f.host.querySelectorAll("pre")).toHaveLength(1);
    expect(f.host.querySelectorAll("code")).toHaveLength(1);
    expect(f.host.querySelector("code")!.textContent!.trimEnd()).toBe(code);
    expect(f.host.querySelector("tag")).toBeNull();
  });
  it("keeps a raw HTML container spanning Markdown blocks", () => {
    const f = mount(`<div class="raw-container">\n\n${paragraphs(600)}\n\n</div>\n\n外側の文章`);
    expect(f.host.querySelectorAll("p").length).toBeLessThan(601);
    loadAll(f.scope);
    expect(f.host.querySelectorAll(".raw-container")).toHaveLength(1);
    expect(f.host.querySelectorAll(".raw-container p")).toHaveLength(600);
    expect(f.host.querySelector(".raw-container")!.textContent).not.toContain("外側の文章");
    expect([...f.host.querySelectorAll("p")].at(-1)?.textContent).toBe("外側の文章");
  });
  it("does not create all nodes of a huge raw HTML block at once", () => {
    const f = mount(
      `<div>${Array.from({ length: 3000 }, (_, i) => `<span>raw ${i}</span>`).join("")}</div>`,
    );
    expect(f.host.querySelectorAll("span").length).toBeLessThan(3000);
    loadAll(f.scope);
    expect(
      [...f.host.querySelectorAll("span")].filter((span) => span.textContent?.startsWith("raw ")),
    ).toHaveLength(3000);
  });
  it("shares forward reference definitions across later batches", () => {
    const images = Array.from({ length: 300 }, (_, i) =>
      i % 2 ? `[![photo ${i}][shared]](https://example.test/${i})` : `![photo ${i}][shared]`,
    ).join("\n\n");
    const f = mount(`${images}\n\n[shared]: /images/shared.jpg "title"`);
    expect(imageRenderer.mock.calls.length).toBeLessThan(300);
    loadAll(f.scope);
    expect(f.host.querySelectorAll("img")).toHaveLength(300);
    expect(
      [...f.host.querySelectorAll("img")].every(
        (img) => img.getAttribute("src") === "/images/shared.jpg",
      ),
    ).toBe(true);
    expect(f.host.querySelectorAll("a")).toHaveLength(150);
  });
  it("keeps closed parent and child bodies absent and starts each on expansion", () => {
    const f = mount(
      `:::details Parent\n${paragraphs(400)}\n\n:::details Child\n${photos(400, "child-")}\n:::\n:::`,
    );
    const parent = f.host.querySelector<HTMLDetailsElement>("details")!;
    expect(parent.querySelector("p")).toBeNull();
    expect(parent.querySelector("details")).toBeNull();
    expect(imageRenderer).not.toHaveBeenCalled();
    open(parent);
    expect(parent.querySelectorAll("p").length).toBeLessThan(400);
    loadAll(parent.querySelector<HTMLElement>(".geocode-progressive-content")!);
    const child = parent.querySelector<HTMLDetailsElement>("details")!;
    expect(child.querySelector("img")).toBeNull();
    open(child);
    const childScope = child.querySelector<HTMLElement>(".geocode-progressive-content")!;
    expect(child.querySelectorAll("img").length).toBeLessThan(400);
    more(childScope)!.click();
    const loaded = child.querySelectorAll("img").length;
    parent.open = false;
    parent.dispatchEvent(new Event("toggle"));
    open(parent);
    expect(child.querySelectorAll("img")).toHaveLength(loaded);
  });
  it("uses the sanitizer for later HTML as well as the initial batch", () => {
    const f = mount(
      `${paragraphs(400)}\n\n<img src="/safe.jpg" onerror="alert(1)">\n\n<script>alert(1)</script>`,
    );
    const initialCalls = sanitize.mock.calls.length;
    loadAll(f.scope);
    expect(sanitize.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(f.host.querySelector("script")).toBeNull();
    expect(f.host.querySelector("img")?.hasAttribute("onerror")).toBe(false);
  });
  it("restarts the initial prefix when prepared HTML is mounted again", () => {
    // CPU・JIT・GC のタイミングに依存せず、同じ処理量の上限でリセット動作を比較する。
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = mount(paragraphs(600));
    const initial = f.host.querySelectorAll("p").length;
    const first = f.host.querySelector("p")!;
    more(f.scope)!.click();
    expect(f.host.querySelectorAll("p").length).toBeGreaterThan(initial);
    f.host.innerHTML = f.html;
    setupDetailsLazyImages(f.host, render);
    expect(f.host.querySelectorAll("p")).toHaveLength(initial);
    expect(f.host.querySelector("p")?.textContent).toBe("段落 0：太字と強調。");
    expect(first.isConnected).toBe(false);
  });
  it.each([
    { initialTick: 0, remountTick: 8 },
    { initialTick: 8, remountTick: 0 },
  ])(
    "restarts from the beginning when timing changes ($initialTick -> $remountTick)",
    ({ initialTick, remountTick }) => {
      let elapsed = 0;
      let tick = initialTick;
      vi.spyOn(performance, "now").mockImplementation(() => {
        const now = elapsed;
        elapsed += tick;
        return now;
      });
      const f = mount(paragraphs(600));
      const initial = f.host.querySelectorAll("p").length;
      expect(initial).toBeGreaterThan(0);
      expect(initial).toBeLessThan(600);
      const first = f.host.querySelector("p")!;
      more(f.scope)!.click();
      expect(f.host.querySelectorAll("p").length).toBeGreaterThan(initial);

      tick = remountTick;
      f.host.innerHTML = f.html;
      setupDetailsLazyImages(f.host, render);
      const restarted = f.host.querySelectorAll("p");
      // 時間制限によって先頭から処理する長さは変わるが、開始位置は変わらない。
      expect(restarted.length).toBeGreaterThan(0);
      expect(restarted.length).toBeLessThan(600);
      expect(restarted.length).not.toBe(initial);
      expect(restarted[0]?.textContent).toBe("段落 0：太字と強調。");
      expect(first.isConnected).toBe(false);

      const scope = f.host.querySelector<HTMLElement>(".geocode-progressive-content")!;
      loadAll(scope);
      expect([...f.host.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
        Array.from({ length: 600 }, (_, i) => `段落 ${i}：太字と強調。`),
      );
    },
  );
  it("does not render sources after their prepared HTML is released", () => {
    const f = mount(paragraphs(400), false);
    releaseDeferredDetails(f.html);
    setupDetailsLazyImages(f.host, render);
    expect(f.host.querySelector("p")).toBeNull();
    expect(more(f.scope)).toBeUndefined();
  });
});
