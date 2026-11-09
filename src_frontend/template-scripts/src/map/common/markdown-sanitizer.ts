import { Parser } from "htmlparser2";

export interface MapXssOptions {
  onTag(tag: string, html: string): string | undefined;
  stripIgnoreTag: boolean;
  stripIgnoreTagBody: string[];
  whiteList: Record<string, string[]>;
}

// 地図と登録詳細で、Markdownから生成したHTMLを同じ規則で安全化する。
export function createMapXssOptions(): MapXssOptions {
  return {
    whiteList: {
      h1: ["id", "class"],
      h2: ["id", "class"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      pre: ["class"],
      a: ["target", "rel", "href", "title", "class", "data-download-href"],
      img: ["src", "alt", "class", "data-preview-src"],
      video: ["src", "controls", "preload", "poster"],
      p: [],
      div: ["class", "data-progressive-content"],
      span: [],
      li: [],
      strong: [],
      em: [],
      del: [],
      ul: [],
      ol: ["start"],
      blockquote: [],
      code: [],
      br: [],
      hr: [],
      table: [],
      thead: [],
      tbody: [],
      th: [],
      td: [],
      tr: [],
      details: ["class", "data-deferred-details"],
      summary: [],
      "app-youtube": ["video-id", "data-src"],
      "app-camera": ["data-camera-src"],
    },
    onTag(tag) {
      if (tag === "iframe") return "Not Allow iframe ";
      return undefined;
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script"],
  };
}

export type MapHtmlFilter = (html: string, options: MapXssOptions) => string;

const escapeAttribute = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** 入力元を問わず既存のXSSフィルターを通し、その結果のリンク属性を安全化する。 */
export function sanitizeMapHtml(
  html: string,
  filter: MapHtmlFilter,
  options = createMapXssOptions(),
): string {
  const safeHtml = filter(html, options);
  if (!/<a(?:\s|\/?>)/i.test(safeHtml)) return safeHtml;

  const pieces: string[] = [];
  let cursor = 0;
  const parser = new Parser({
    onopentag(name, attributes, implied) {
      if (name !== "a" || implied || !("target" in attributes || "rel" in attributes)) return;
      // 属性はHTMLパーサーで復号・重複整理する。本文や表の断片は再構築しない。
      const target = (attributes.target ?? "").toLowerCase();
      const tokens = (attributes.rel ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);
      const hadOpener = tokens.some((token) => token.toLowerCase() === "opener");
      const opensWindow = target !== "" && !["_self", "_top", "_parent"].includes(target);
      const rel = new Set(
        tokens.map((token) => token.toLowerCase()).filter((token) => token !== "opener"),
      );
      if (opensWindow || hadOpener) {
        rel.add("noopener");
        rel.add("noreferrer");
      }
      if (rel.size) attributes.rel = [...rel].join(" ");
      else delete attributes.rel;

      const attributesHtml = Object.entries(attributes)
        .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
        .join("");
      pieces.push(safeHtml.slice(cursor, parser.startIndex), `<a${attributesHtml}>`);
      cursor = parser.endIndex + 1;
    },
  });
  parser.end(safeHtml);
  if (!pieces.length) return safeHtml;
  pieces.push(safeHtml.slice(cursor));
  return pieces.join("");
}
