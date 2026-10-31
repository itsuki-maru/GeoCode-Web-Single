import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNestedTokenizer,
  bindDeferredPopupLayout,
  isLocalhost,
  isPDF,
  isValidCoordinate,
  releaseDeferredDetails,
  renderIframe,
  setupDetailsLazyImages,
} from "../src/map/common/content";

describe("map common content", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("updates public popup layout after deferred content changes and disposes its listener", () => {
    const host = document.createElement("div");
    const child = document.createElement("div");
    host.append(child);
    const popup = { getElement: () => host, update: vi.fn() };
    const dispose = bindDeferredPopupLayout(popup);
    child.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
    expect(popup.update).toHaveBeenCalledTimes(1);
    dispose();
    child.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
    expect(popup.update).toHaveBeenCalledTimes(1);
    host.className = "";
    child.className = "geocode-content-popup";
    bindDeferredPopupLayout(popup);
    child.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
    expect(popup.update).toHaveBeenCalledTimes(1);
  });

  it("pins public popup live content for layout updates and restores collapsed HTML on close", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="md-detail-contents"><details><summary>Photos</summary></details></div>';
    const initialHtml = host.firstElementChild!.outerHTML;
    const popup = { getElement: () => host, update: vi.fn(), setContent: vi.fn(), once: vi.fn() };
    const dispose = bindDeferredPopupLayout(popup);
    expect(popup.setContent).toHaveBeenCalledWith(host.firstElementChild);
    host.querySelector("details")!.append(document.createElement("img"));
    host.firstElementChild!.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
    expect(popup.update).toHaveBeenCalledTimes(1);
    dispose();
    expect(popup.setContent).toHaveBeenLastCalledWith(initialHtml);
    expect(popup.once).toHaveBeenCalledWith("remove", expect.any(Function));
    dispose();
    expect(popup.setContent).toHaveBeenCalledTimes(2);
  });

  it("preserves the current inner and outer scroll positions through repeated public popup updates", () => {
    const host = document.createElement("div");
    host.className = "leaflet-popup";
    host.innerHTML =
      '<div class="leaflet-popup-content"><div class="md-detail-contents"><div class="geocode-progressive-content"><button>さらに読み込む</button></div></div></div>';
    document.body.append(host);
    const outer = host.querySelector<HTMLElement>(".leaflet-popup-content")!;
    const inner = host.querySelector<HTMLElement>(".md-detail-contents")!;
    const gallery = host.querySelector<HTMLElement>(".geocode-progressive-content")!;
    const button = host.querySelector<HTMLButtonElement>("button")!;
    const resetScroll = () => {
      outer.scrollTop = outer.scrollLeft = inner.scrollTop = inner.scrollLeft = 0;
    };
    const popup = {
      getElement: () => host,
      setContent: vi.fn(),
      update: vi.fn(() => {
        // Leaflet は update() 中に、保持している内容を取り外して付け直す。
        inner.remove();
        outer.append(inner);
        resetScroll();
      }),
    };
    const dispose = bindDeferredPopupLayout(popup);
    button.focus();
    const focus = vi.spyOn(button, "focus").mockImplementation((options) => {
      HTMLElement.prototype.focus.call(button, options);
      // ブラウザーによっては、フォーカスの復元中にもスクロール位置が動く場合がある。
      resetScroll();
    });
    for (const [outerTop, outerLeft, innerTop, innerLeft] of [
      [180, 7, 480, 12],
      [330, 11, 900, 19],
    ]) {
      outer.scrollTop = outerTop!;
      outer.scrollLeft = outerLeft!;
      inner.scrollTop = innerTop!;
      inner.scrollLeft = innerLeft!;
      // 二度目の通知は、ユーザーがすでにポップアップの下方を読み進めた後で、
      // 画像の読み込みが完了した状況を表す。
      gallery.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
      expect([outer.scrollTop, outer.scrollLeft, inner.scrollTop, inner.scrollLeft]).toEqual([
        outerTop,
        outerLeft,
        innerTop,
        innerLeft,
      ]);
      expect(document.activeElement).toBe(button);
    }
    expect(popup.update).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    dispose();
  });

  it("validates latitude and longitude ranges", () => {
    expect(isValidCoordinate(35.6812, 139.7671)).toBe(true);
    expect(isValidCoordinate("35.6812", "139.7671")).toBe(true);
    expect(isValidCoordinate(91, 139.7671)).toBe(false);
    expect(isValidCoordinate(35.6812, -181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 139.7671)).toBe(false);
  });

  it("renders only valid app-youtube elements", () => {
    const rendered = renderIframe('<app-youtube video-id="dQw4w9WgXcQ"></app-youtube>');
    expect(rendered).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(renderIframe('<app-youtube video-id="too-short"></app-youtube>')).toContain(
      "app-youtube",
    );
  });

  it.each([
    ["http://localhost:3000/map", true],
    ["http://127.0.0.1/map", true],
    ["http://[::1]/map", true],
    ["https://example.com/map", false],
    ["invalid", false],
  ])("identifies localhost URL %s", (url, expected) => {
    expect(isLocalhost(url)).toBe(expected);
  });

  it("identifies PDF file names case-insensitively", () => {
    expect(isPDF("guide.PDF")).toBe(true);
    expect(isPDF("guide.pdf?download=1")).toBe(false);
  });

  it("tokenizes nested blocks and renders them through marked", () => {
    const blockTokens = vi.fn(() => [{ type: "paragraph" }]);
    Object.assign(window, {
      marked: { parser: vi.fn(() => "<p>body</p>") },
    });
    const extension = createNestedTokenizer("details");
    const token = extension.tokenizer.call(
      { lexer: { blockTokens } },
      ":::details Title\nbody\n:::warning Nested\nwarning\n:::\n:::",
    );

    expect(blockTokens).toHaveBeenCalledWith("body\n:::warning Nested\nwarning\n:::");
    expect(token?.title).toBe("Title");
    expect(token && extension.renderer(token)).toBe(
      '<details class="details">\n<summary>Title</summary>\n<p>body</p>\n</details>\n',
    );
  });

  it.each([100, 500, 1000])(
    "does not lex or create any of %i hidden images until details is expanded",
    (count) => {
      const blockTokens = vi.fn();
      const parser = vi.fn();
      Object.assign(window, { marked: { parser } });
      const markdown = Array.from(
        { length: count },
        (_, index) => `![photo ${index}](/static/images/${index}.jpg)`,
      ).join("\n\n");
      const renderDeferredBody = vi.fn(() =>
        Array.from(
          { length: count },
          (_, index) =>
            `<img src="/static/images/${index}.jpg?thumb=true" data-preview-src="/static/images/${index}.jpg">`,
        ).join(""),
      );
      const extension = createNestedTokenizer("details", { renderDeferredBody });
      const token = extension.tokenizer.call(
        { lexer: { blockTokens } },
        `:::details Photos\n${markdown}\n:::`,
      )!;
      const html = extension.renderer(token);
      document.body.innerHTML = html;
      setupDetailsLazyImages();
      const details = document.querySelector("details")!;

      expect(details.open).toBe(false);
      expect(document.querySelectorAll("img")).toHaveLength(0);
      expect(html).not.toContain("/static/images/");
      expect(blockTokens).not.toHaveBeenCalled();
      expect(parser).not.toHaveBeenCalled();
      expect(renderDeferredBody).not.toHaveBeenCalled();

      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(renderDeferredBody).toHaveBeenCalledExactlyOnceWith(markdown, undefined);
      expect(details.querySelectorAll("img")).toHaveLength(count);
      expect(details.querySelector("img")?.getAttribute("data-preview-src")).toBe(
        "/static/images/0.jpg",
      );
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(renderDeferredBody).toHaveBeenCalledTimes(1);
      releaseDeferredDetails(html);
    },
  );

  it("keeps nested details deferred and reuses strings after popup DOM is discarded", () => {
    const blockTokens = vi.fn();
    const context = { lexer: { blockTokens } };
    const childMarkdown = "![child](/child.jpg)";
    const childSource = `:::details Child\n${childMarkdown}\n:::`;
    const renderDeferredBody = vi.fn((markdown: string): string => {
      if (markdown === childMarkdown) return '<img src="/child.jpg">';
      const child = extension.tokenizer.call(context, childSource)!;
      return '<img src="/parent.jpg">' + extension.renderer(child);
    });
    const extension = createNestedTokenizer("details", { renderDeferredBody });
    const token = extension.tokenizer.call(
      context,
      `:::details Parent\n![parent](/parent.jpg)\n${childSource}\n:::`,
    )!;
    const html = extension.renderer(token);
    document.body.innerHTML = html;
    setupDetailsLazyImages();
    const parent = document.querySelector("details")!;
    parent.open = true;
    parent.dispatchEvent(new Event("toggle"));
    const child = parent.querySelector("details")!;
    expect(parent.querySelectorAll("img")).toHaveLength(1);
    expect(child.querySelector("img")).toBeNull();
    child.open = true;
    child.dispatchEvent(new Event("toggle"));
    expect(child.querySelector("img")?.getAttribute("src")).toBe("/child.jpg");
    expect(renderDeferredBody).toHaveBeenCalledTimes(2);

    document.body.innerHTML = html;
    setupDetailsLazyImages();
    const reopened = document.querySelector("details")!;
    expect(reopened.querySelector("img")).toBeNull();
    reopened.open = true;
    reopened.dispatchEvent(new Event("toggle"));
    expect(reopened.querySelectorAll("img")).toHaveLength(1);
    expect(reopened.querySelector("details")?.open).toBe(false);
    expect(renderDeferredBody).toHaveBeenCalledTimes(2);

    releaseDeferredDetails(html);
    document.body.innerHTML = html;
    setupDetailsLazyImages();
    const released = document.querySelector("details")!;
    released.open = true;
    released.dispatchEvent(new Event("toggle"));
    expect(released.querySelector("img")).toBeNull();
  });

  it("finds nested block boundaries without treating fenced examples as delimiters", () => {
    const renderDeferredBody = vi.fn(() => "");
    const extension = createNestedTokenizer("details", { renderDeferredBody });
    const blockTokens = vi.fn();
    const body = [
      "```markdown",
      ":::details example",
      ":::warning example",
      "```",
      "~~~",
      ":::",
      "~~~",
      ":::note Actual nested block",
      "note",
      ":::",
    ].join("\r\n");
    const source = `:::details Title\r\n${body}\r\n:::\r\nafter`;
    const token = extension.tokenizer.call({ lexer: { blockTokens } }, source)!;
    expect(token.raw).toBe(source.slice(0, source.indexOf("\nafter")));
    expect(token.deferredBody).toBe(body);
    expect(blockTokens).not.toHaveBeenCalled();
    const html = extension.renderer(token);
    releaseDeferredDetails(html);
  });

  it("defers details media until its section is opened", () => {
    document.body.innerHTML = [
      '<details class="details" id="parent">',
      '<img id="direct" src="direct.png">',
      '<details class="details" id="child">',
      '<img id="nested" src="nested.png">',
      "</details>",
      "</details>",
    ].join("");
    setupDetailsLazyImages();

    const parent = document.querySelector<HTMLDetailsElement>("#parent")!;
    const child = document.querySelector<HTMLDetailsElement>("#child")!;
    const direct = document.querySelector<HTMLImageElement>("#direct")!;
    const nested = document.querySelector<HTMLImageElement>("#nested")!;
    expect(direct.getAttribute("src")).toBeNull();
    expect(nested.getAttribute("src")).toBeNull();

    parent.open = true;
    parent.dispatchEvent(new Event("toggle"));
    expect(direct.getAttribute("src")).toBe("direct.png");
    expect(nested.getAttribute("src")).toBeNull();

    child.open = true;
    child.dispatchEvent(new Event("toggle"));
    expect(nested.getAttribute("src")).toBe("nested.png");
  });
});
