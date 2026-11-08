import { describe, expect, it, vi } from "vitest";
import filterXSS from "xss";
import { sanitizeMapHtml } from "../src/map/common/markdown-sanitizer";

const sanitize = (html: string) => sanitizeMapHtml(html, filterXSS);
const anchor = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = sanitize(html);
  return template.content.querySelector("a")!;
};

describe("表示元によらないHTML・リンクの安全化", () => {
  it.each([
    '<a href="https://example.test" target="_blank" rel="opener">資料</a>',
    '<A HREF="https://example.test" TARGET="_BLANK" REL="OpEnEr">資料</A>',
    '<a href="https://example.test" target="&#95;blank" rel="o&#112;ener">資料</a>',
    '<a href="https://example.test" target="_blank" rel="opener" rel="noopener">資料</a>',
    '<a href="https://example.test" target="_blank" rel="noopener noreferrer" rel="opener">資料</a>',
    '<a href="https://example.test" target="report-window">資料</a>',
    '<a href="https://example.test" target="_blank">資料</a>',
    '<a href="https://example.test" target="report window">資料</a>',
    '<a href="https://example.test" rel="opener">資料</a>',
  ])("別ウィンドウと難読化・重複属性からopenerを残さない: %s", (html) => {
    const link = anchor(html);
    expect(link.href).toBe("https://example.test/");
    expect(link.relList.contains("opener")).toBe(false);
    expect(link.relList.contains("noopener")).toBe(true);
    expect(link.relList.contains("noreferrer")).toBe(true);
    expect(link.textContent).toBe("資料");
    expect(sanitize(html)).not.toMatch(/rel="[^"]*\bopener\b/);
  });

  it("通常リンクの遷移先と安全なrelの意味を維持する", () => {
    expect(sanitize('<a href="/internal#part">内部</a>')).toBe('<a href="/internal#part">内部</a>');
    for (const target of ["_self", "_parent", "_top", ""]) {
      const link = anchor(`<a href="/internal" target="${target}">内部</a>`);
      expect(link.getAttribute("target")).toBe(target);
      expect(link.hasAttribute("rel")).toBe(false);
    }
    const link = anchor('<a href="/doc" target="report" rel="ugc nofollow opener">資料</a>');
    expect([...link.relList]).toEqual(["ugc", "nofollow", "noopener", "noreferrer"]);
  });

  it("script・イベント属性・危険URLを既存フィルターで除去し続ける", () => {
    const html = sanitize(
      '<script>alert(1)</script><img src="/photo.png" onerror="alert(1)"><a href="javascript:alert(1)" target="_blank" onclick="alert(1)">危険</a><iframe srcdoc="bad"></iframe>',
    );
    expect(html).not.toMatch(/<script|<iframe|javascript:|onerror|onclick|alert\(1\)/i);
    expect(
      anchor('<a href="data:text/html,bad" target="named">資料</a>').getAttribute("href"),
    ).toBe("");
  });

  it("属性の引用符・文字参照・非ASCII文字から新しい属性を生成しない", () => {
    const link = anchor(
      '<a href="https://example.test/?a=1&amp;b=2" target="報告&quot; onclick=&quot;alert(1)" title="&lt;img src=x onerror=bad&gt;">資料</a>',
    );
    expect(link.href).toBe("https://example.test/?a=1&b=2");
    expect(link.hasAttribute("onclick")).toBe(false);
    expect(link.target).toBe('報告" onclick="alert(1)');
    expect(link.querySelector("img")).toBeNull();
    expect(link.relList.contains("noopener")).toBe(true);
  });

  it("表・details・未完のHTML断片を組み直さずa開始タグだけを変更する", () => {
    const prefix =
      '<tr><td>先頭</td><td><details data-deferred-details="one"><summary>資料</summary>';
    const suffix = "</details></td></tr>";
    const actual = sanitize(prefix + '<a href="/doc" target="_blank">リンク</a>' + suffix);
    expect(actual.startsWith(prefix)).toBe(true);
    expect(actual.endsWith(suffix)).toBe(true);
    expect(actual).toContain('<a href="/doc" target="_blank" rel="noopener noreferrer">リンク</a>');
    expect(sanitize('<td><a href="/doc" target="_blank">')).toBe(
      '<td><a href="/doc" target="_blank" rel="noopener noreferrer">',
    );
  });

  it("コード中のリンク表記、Markdown拡張やPWAのダウンロード属性を維持する", () => {
    const html =
      '<pre><code>&lt;a target="_blank" rel="opener"&gt;</code></pre><a class="markdown-download-link" data-download-href="/doc.pdf" href="/doc.pdf">PDF</a><app-camera data-camera-src="https://camera.test/stream"></app-camera><app-youtube video-id="abcdefghijk"></app-youtube>';
    expect(sanitize(html)).toBe(html);
  });

  it("既存フィルターを最初に実行し、リンクがない大きな本文を変更しない", () => {
    const html = "<p>既存の本文</p>".repeat(20000);
    const filter = vi.fn(filterXSS);
    expect(sanitizeMapHtml(html, filter)).toBe(html);
    expect(filter).toHaveBeenCalledExactlyOnceWith(html, expect.any(Object));
  });
});
