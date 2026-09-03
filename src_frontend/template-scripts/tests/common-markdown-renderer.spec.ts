import { describe, expect, it, vi } from "vitest";

import {
  createMapXssOptions,
  installMapMarkdownRenderer,
} from "../src/map/common/markdown-renderer";

describe("map common Markdown renderer", () => {
  it("renders direct preview images with thumbnail URLs", () => {
    const { renderer } = installRenderer();

    expect(renderer.image({ href: "/static/images/photo.png" })).toBe(
      '<img src="/static/images/photo.png?thumb=true" class="marker-preview-image" data-preview-src="/static/images/photo.png">',
    );
    expect(renderer.image({ href: "/photo.png?size=small" })).toContain(
      "/photo.png?size=small&thumb=true",
    );
  });

  it("maps supported mobile images to the HTML preview endpoint", () => {
    const { renderer } = installRenderer({ imageMode: "html-preview" });

    expect(renderer.image({ href: "/static/images/photo.png" })).toContain(
      'data-preview-src="/images/html/photo.png"',
    );
    expect(renderer.image({ href: "/external/photo.png" })).toBe(
      '<img src="/external/photo.png">',
    );
  });

  it("renders PDF downloads only in an enabled PWA", () => {
    const { renderer } = installRenderer({
      enablePwaDownloads: true,
      isRunningAsPwa: () => true,
    });

    expect(renderer.link({ href: "/guide.pdf" })).toContain(
      'class="markdown-download-link"',
    );
    expect(renderer.link({ href: "https://external.test/guide.pdf" })).toContain(
      'title="外部リンク"',
    );
  });

  it("opens ordinary PDF and external links in a separate tab", () => {
    const { renderer } = installRenderer();

    expect(renderer.link({ href: "/guide.pdf" })).toContain(
      'title="PDFリンク"',
    );
    expect(renderer.link({ href: "https://external.test/page" })).toContain(
      'rel="noopener noreferrer"',
    );
    expect(renderer.link({ href: "/internal" })).toBe(
      '<a href="/internal">link</a>',
    );
  });

  it("provides the established XSS allowlist", () => {
    const options = createMapXssOptions();

    expect(options.whiteList.a).toContain("data-download-href");
    expect(options.whiteList.img).toContain("data-preview-src");
    expect(options.whiteList["app-youtube"]).toEqual(["video-id", "data-src"]);
    expect(options.onTag("iframe", "<iframe>")).toBe("Not Allow iframe ");
    expect(options.stripIgnoreTagBody).toEqual(["script"]);
  });
});

function installRenderer({
  enablePwaDownloads = false,
  imageMode = "direct-preview" as const,
  isRunningAsPwa = () => false,
}: {
  enablePwaDownloads?: boolean;
  imageMode?: "direct-preview" | "html-preview";
  isRunningAsPwa?: () => boolean;
} = {}) {
  const renderer = {
    image: vi.fn(() => ""),
    link: vi.fn((token: { href?: string | null }) =>
      token.href ? `<a href="${token.href}">link</a>` : "<a>link</a>",
    ),
  };
  const setOptions = vi.fn();
  installMapMarkdownRenderer({
    enablePwaDownloads,
    imageMode,
    isLocalhost: (url) => url.startsWith("https://example.test"),
    isPdf: (url) => /\.pdf$/i.test(url),
    isRunningAsPwa,
    marked: {
      Renderer: class {
        image = renderer.image;
        link = renderer.link;
      },
      setOptions,
    },
  });
  const configuredRenderer = setOptions.mock.calls[0]?.[0].renderer;
  return { renderer: configuredRenderer };
}
