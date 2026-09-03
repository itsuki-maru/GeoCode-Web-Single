import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNestedTokenizer,
  isLocalhost,
  isPDF,
  isValidCoordinate,
  renderIframe,
  setupDetailsLazyImages,
} from "../src/map/common/content";

describe("map common content", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("validates latitude and longitude ranges", () => {
    expect(isValidCoordinate(35.6812, 139.7671)).toBe(true);
    expect(isValidCoordinate("35.6812", "139.7671")).toBe(true);
    expect(isValidCoordinate(91, 139.7671)).toBe(false);
    expect(isValidCoordinate(35.6812, -181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 139.7671)).toBe(false);
  });

  it("renders only valid app-youtube elements", () => {
    const rendered = renderIframe(
      '<app-youtube video-id="dQw4w9WgXcQ"></app-youtube>',
    );
    expect(rendered).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
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

    expect(blockTokens).toHaveBeenCalledWith(
      "body\n:::warning Nested\nwarning\n:::",
    );
    expect(token?.title).toBe("Title");
    expect(token && extension.renderer(token)).toBe(
      '<details class="details">\n<summary>Title</summary>\n<p>body</p>\n</details>\n',
    );
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
