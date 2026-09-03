import { describe, expect, it, vi } from "vitest";

import {
  createVideoMarkdownToken,
  createYouTubeMarkdownToken,
  installMapMarkdownExtensions,
} from "../src/map/common/markdown-extensions";

describe("map common Markdown extensions", () => {
  it("tokenizes and renders custom video syntax", () => {
    const token = createVideoMarkdownToken();
    const lexer = { inlineTokens: vi.fn(() => ["caption"]) };
    const parsed = token.tokenizer?.call(
      { lexer },
      "?[案内](/video/guide.mp4)",
      [],
    );

    expect(parsed).toEqual({
      href: "/video/guide.mp4",
      raw: "?[案内](/video/guide.mp4)",
      text: "案内",
      tokens: ["caption"],
      type: "video",
    });
    expect(token.renderer?.(parsed!)).toContain(
      'poster="/video/guide.mp4?thumb=true"',
    );
  });

  it("accepts only YouTube URLs resolved to a valid ID", () => {
    const extractYouTubeId = vi.fn((url: string) =>
      url.endsWith("/valid") ? "abcdefghijk" : null,
    );
    const token = createYouTubeMarkdownToken(extractYouTubeId);

    const parsed = token.tokenizer?.call(
      { lexer: { inlineTokens: vi.fn() } },
      "@[youtube](https://youtube.test/valid)",
      [],
    );
    expect(parsed?.text).toBe("abcdefghijk");
    expect(token.renderer?.(parsed!)).toBe(
      '<app-youtube video-id="abcdefghijk" data-src="https://youtube.test/valid"></app-youtube>',
    );
    expect(
      token.tokenizer?.call(
        { lexer: { inlineTokens: vi.fn() } },
        "@[youtube](https://youtube.test/invalid-url)",
        [],
      ),
    ).toBeNull();
    expect(
      token.tokenizer?.call(
        { lexer: { inlineTokens: vi.fn() } },
        "@[youtube](https://video.test/other)",
        [],
      ),
    ).toBeNull();
  });

  it("installs extensions in the established order", () => {
    const use = vi.fn();
    const createNestedTokenizer = vi.fn((name: string) => ({ name }));

    installMapMarkdownExtensions({
      createNestedTokenizer,
      extractYouTubeId: () => "abcdefghijk",
      marked: { use },
    });

    expect(createNestedTokenizer.mock.calls).toEqual([
      ["details"],
      ["note"],
      ["warning"],
    ]);
    expect(
      use.mock.calls[0]?.[0].extensions.map(
        (extension: { name: string }) => extension.name,
      ),
    ).toEqual(["video", "details", "note", "warning", "youtube"]);
  });
});
