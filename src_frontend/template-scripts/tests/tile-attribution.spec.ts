import { describe, expect, it } from "vitest";
import { formatTileAttribution } from "../src/map/common/tile-attribution";

function render(input: string) {
  const result = document.createElement("div");
  result.innerHTML = formatTileAttribution(input);
  return result;
}

describe("tile attribution", () => {
  it("preserves text and supports multiple links opening separate tabs", () => {
    const result = render(
      '出典：<a href="https://disaportal.gsi.go.jp/">ハザードマップポータルサイト</a> / <a href="http://example.com/?a=1&amp;b=2">別の出典</a>',
    );
    expect(result.textContent).toBe("出典：ハザードマップポータルサイト / 別の出典");
    const links = result.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe("https://disaportal.gsi.go.jp/");
    expect(links[1].href).toBe("http://example.com/?a=1&b=2");
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    }
    expect(render("<出典> & 調査結果").textContent).toBe("<出典> & 調査結果");
    expect(formatTileAttribution("")).toBe("");
  });

  it.each([
    "javascript:alert(1)",
    "java&#x73;cript:alert(1)",
    "data:text/html,test",
    "//example.com",
    "/path",
    "https://",
    "file:///test",
  ])("keeps an invalid link as text: %s", (href) => {
    const result = render(`<a href="${href}">出典</a>`);
    expect(result.querySelector("a")).toBeNull();
    expect(result.textContent).toBe("出典");
  });

  it("discards active content and supplied attributes while rebuilding anchors", () => {
    const result = render(
      '<script>alert(1)</script><img src="https://example.com/tracker" onerror="alert(1)"><iframe src="https://example.com"></iframe><svg><a href="https://example.com">SVG</a></svg><a href="https://example.com" target="_self" onclick="alert(1)" style="color:red" ping="https://example.com/track"><b>出典</b></a>',
    );
    expect(result.querySelectorAll("*")).toHaveLength(1);
    expect(result.querySelector("a")!.outerHTML).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">出典</a>',
    );
    expect(result.textContent).toBe("出典");
  });
});
