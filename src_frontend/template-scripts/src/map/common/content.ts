import { createMarkdownStream } from "./progressive-markdown";
import { deferHtmlDetails } from "./progressive-html-details";
import {
  registerProgressiveContent,
  releaseProgressiveContent,
  setupProgressiveContent,
  disposeProgressiveContent,
} from "./progressive-content";
import {
  ownContentResource,
  releaseContentResources,
  withContentResources,
  type ContentResources,
} from "./content-resources";
import { updatePopupLayout } from "./popup-layout";

interface NestedToken {
  raw: string;
  title: string;
  tokens: unknown[];
  type: string;
  deferredBody?: string;
  links?: MarkdownReferences;
}

type MarkdownReferences = Record<string, { href: string; title: string | null }>;
type MarkdownTokens = unknown[] & { links: MarkdownReferences };

interface DeferredDetailsOptions {
  // 格納先のポップアップと同じ Markdown 描画処理とサニタイザーを使う。
  renderDeferredBody(markdown: string, links?: MarkdownReferences): string;
}

interface DeferredDetailsBody {
  markdown: string;
  render(markdown: string, links?: MarkdownReferences): string;
  links?: MarkdownReferences;
  html?: string;
  resources: ContentResources;
}

const deferredDetails = new Map<string, DeferredDetailsBody>();

function registerDeferredDetails(
  markdown: string,
  render: DeferredDetailsOptions["renderDeferredBody"],
  links?: MarkdownReferences,
): string {
  const key = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(16).padStart(8, "0"),
  ).join("");
  deferredDetails.set(key, { markdown, render, links, resources: new Set() });
  ownContentResource(() => releaseDetails(key));
  return key;
}

// ポップアップの HTML は、閉じた後も再利用できる。入れ子のセクションを展開して作成したものも含め、
// その HTML が置き換わるときにのみ元データを解放する。
export function releaseDeferredDetails(html: string): void {
  releaseProgressiveContent(html);
  for (const match of html.matchAll(/\bdata-deferred-details="([a-f0-9]{32})"/g)) {
    releaseDetails(match[1]!);
  }
}

function releaseDetails(key: string): void {
  const entry = deferredDetails.get(key);
  if (!entry) return;
  deferredDetails.delete(key);
  releaseContentResources(entry.resources);
  if (entry.html) releaseDeferredDetails(entry.html);
}

export function disposeMapContent(root: ParentNode): void {
  disposeProgressiveContent(root);
}

interface TokenizerContext {
  lexer: {
    blockTokens(source: string): unknown[];
    tokens?: { links: MarkdownReferences };
    options?: { extensions?: { startBlock?: unknown[] } };
  };
}

interface MarkedNamespace {
  parser(tokens: unknown[]): string;
  defaults?: Record<string, any>;
  Parser: { parseInline(tokens: unknown[], options?: unknown): string };
  Lexer: new (options?: unknown) => {
    tokens: MarkdownTokens;
    lex(source: string): MarkdownTokens;
    inlineTokens(source: string, tokens?: unknown[]): unknown[];
  };
}

function getMarked(): MarkedNamespace {
  const marked = (window as Window & { marked?: MarkedNamespace }).marked;
  if (!marked) throw new Error("Marked is not loaded");
  return marked;
}

// 最初に準備するのは、ブロック構造と参照定義だけとする。
// 任意のカスタム開始位置の探索では、各ブロックで残りのソース全体を走査してしまい、
// 基準計測では通常の文章でも処理量が二次関数的に増加していた。
function lexerOptions(markdown: string): Record<string, any> {
  const marked = getMarked();
  const options = { ...marked.defaults };
  if (options.extensions) {
    options.extensions = { ...options.extensions };
    const starts = [...markdown.matchAll(/:::(?:details|note|warning)(?:\s|$)/g)];
    // 空行で区切られたブロックは、先頭一致のトークナイザーが直接処理するため、
    // それより前の各段落で先読みする必要はない。
    const separated = starts.every((match) => {
      const index = match.index;
      if (!index) return true;
      if (markdown[index - 1] !== "\n") return false;
      const previousLineStart = markdown.lastIndexOf("\n", index - 2) + 1;
      return !markdown.slice(previousLineStart, index - 1).trim();
    });
    if (separated) options.extensions.startBlock = [];
    if (!markdown.includes("?[") && !markdown.includes("@[")) options.extensions.startInline = [];
  }
  return options;
}

function nestedBlockTokens(lexer: TokenizerContext["lexer"], content: string): unknown[] {
  const extensions = lexer.options?.extensions;
  const previous = extensions?.startBlock;
  if (extensions && !/:::(?:details|note|warning)(?:\s|$)/.test(content))
    extensions.startBlock = [];
  try {
    return lexer.blockTokens(content);
  } finally {
    if (extensions) extensions.startBlock = previous;
  }
}

export function renderProgressiveMarkdown(
  markdown: string,
  sanitizeHtml: (html: string) => string,
  links?: MarkdownReferences,
): string {
  const marked = getMarked();
  const options = lexerOptions(markdown);
  const lexer = new marked.Lexer(options);
  if (links) Object.assign(lexer.tokens.links, links);
  lexer.inlineTokens = () => [];
  const tokens = lexer.lex(markdown);
  const createInlineLexer = () => {
    const inline = new marked.Lexer(options);
    inline.tokens.links = tokens.links;
    return inline;
  };
  const renderer = {
    renderBlock: (part) => marked.parser(Object.assign(part, { links: tokens.links })),
    renderInline: (part) => marked.Parser.parseInline(part, marked.defaults),
    lexInline: (source) => createInlineLexer().inlineTokens(source),
    createInlineLexer,
    textChunkSize: 2048,
  } satisfies Parameters<typeof createMarkdownStream>[1];
  const prepared = deferHtmlDetails(tokens, (attributes, summary, body, hasSummary) => ({
    type: "progressiveHtmlDetails",
    progressiveHtml: function* () {
      const key = registerDeferredDetails(
        "",
        () => registerProgressiveContent(() => createMarkdownStream(body, renderer), sanitizeHtml),
        tokens.links,
      );
      const attrs = {
        ...attributes,
        class: `${attributes.class ?? ""} details`.trim(),
        "data-deferred-details": key,
      };
      yield `<details${Object.entries(attrs)
        .map(
          ([name, value]) =>
            ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`,
        )
        .join("")}>`;
      yield "<summary>";
      if (hasSummary) yield* createMarkdownStream(summary, renderer);
      else yield "詳細";
      yield "</summary></details>";
    },
  }));
  return registerProgressiveContent(() => createMarkdownStream(prepared, renderer), sanitizeHtml);
}

export function registerProgressiveHtml(
  html: string,
  sanitizeHtml: (html: string) => string,
): string {
  return registerProgressiveContent(function* () {
    yield html;
  }, sanitizeHtml);
}

function collectDeferredReferences(source: string, lexer: TokenizerContext["lexer"]): void {
  const links = lexer.tokens?.links;
  if (!links || !/^[\t ]*(?:>[\t ]?|[-+*][\t ]+|\d+[.)][\t ]+)*\[/m.test(source)) return;
  // この処理は参照定義を含む可能性のある文書にのみ必要となる。Marked に定義と
  // コード・HTML・段落・入れ子のコンテナーを判別させ、
  // 画像のトークン化を含むすべてのインライン処理はスキップする。
  const marked = getMarked();
  const definitions = new marked.Lexer(lexerOptions(source));
  Object.assign(definitions.tokens.links, links);
  definitions.inlineTokens = () => [];
  definitions.lex(source);
  Object.assign(links, definitions.tokens.links);
}

export function isValidCoordinate(latitude: number | string, longitude: number | string): boolean {
  const numericLatitude = Number(latitude);
  const numericLongitude = Number(longitude);
  return (
    !Number.isNaN(numericLatitude) &&
    numericLatitude >= -90 &&
    numericLatitude <= 90 &&
    !Number.isNaN(numericLongitude) &&
    numericLongitude >= -180 &&
    numericLongitude <= 180
  );
}

export function renderIframe(html: string): string {
  return html.replace(
    /<app-youtube\s+[^>]*video-id=["']([\w-]{11})["'][^>]*>(?:<\/app-youtube>)?/g,
    (_, videoId: string) => {
      const src = `https://www.youtube-nocookie.com/embed/${videoId}`;
      return `
                <iframe
                    src="${src}"
                    title="YouTube video player"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"
                    allowfullscreen
                    width="100%" height="315"
                    style="border:0;"
                ></iframe>
            `.trim();
    },
  );
}

export function createNestedTokenizer(typeName: string, options?: DeferredDetailsOptions) {
  return {
    name: typeName,
    level: "block" as const,
    start(source: string): number | undefined {
      const pattern = new RegExp(`^:::${typeName}\\s`, "m");
      return source.match(pattern)?.index;
    },
    tokenizer(this: TokenizerContext, source: string): NestedToken | null {
      if (!new RegExp(`^:::${typeName}(?:\\s|$)`).test(source)) return null;

      // 内容を字句解析せずにブロックの境界を探す。特に、閉じた details セクションでは、
      // 画像トークンや画像の HTML を生成しない。
      let nestLevel = 0;
      let lineStart = 0;
      let bodyStart = 0;
      let bodyEnd = -1;
      let rawEnd = -1;
      let title = typeName.toUpperCase();
      let fence: { character: string; length: number } | undefined;

      while (lineStart < source.length) {
        const nextNewline = source.indexOf("\n", lineStart);
        const lineEnd = nextNewline === -1 ? source.length : nextNewline;
        const originalLine = source.slice(lineStart, lineEnd).replace(/\r$/, "");
        const line = originalLine.trim();
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(originalLine);
        if (fence) {
          if (
            fenceMatch &&
            fenceMatch[1]![0] === fence.character &&
            fenceMatch[1]!.length >= fence.length &&
            !fenceMatch[2]!.trim()
          ) {
            fence = undefined;
          }
        } else if (fenceMatch) {
          fence = { character: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
        } else if (/^:::(\w+)/.test(line)) {
          if (nestLevel === 0) {
            title = line.match(new RegExp(`^:::${typeName}\\s+(.+)`))?.[1]?.trim() || title;
            bodyStart = nextNewline === -1 ? source.length : nextNewline + 1;
          }
          nestLevel++;
        } else if (/^:::\s*$/.test(line)) {
          nestLevel--;
          if (nestLevel === 0) {
            bodyEnd = lineStart;
            rawEnd = lineEnd;
            break;
          }
        }
        if (nextNewline === -1) break;
        lineStart = nextNewline + 1;
      }

      if (rawEnd === -1) return null;

      const raw = source.slice(0, rawEnd);
      const content = source.slice(bodyStart, bodyEnd).replace(/\r?\n$/, "");
      const defer = typeName === "details" && !!options;
      if (defer) collectDeferredReferences(content, this.lexer);

      return {
        type: typeName,
        raw,
        title,
        tokens: defer ? [] : nestedBlockTokens(this.lexer, content),
        ...(defer ? { deferredBody: content, links: this.lexer.tokens?.links } : {}),
      };
    },
    renderer(token: NestedToken): string {
      if (token.type === "details" && token.deferredBody !== undefined && options) {
        const key = registerDeferredDetails(
          token.deferredBody,
          options.renderDeferredBody,
          token.links,
        );
        return `<details class="details" data-deferred-details="${key}">\n<summary>${token.title}</summary>\n</details>\n`;
      }
      const body = getMarked().parser(token.tokens);
      if (token.type === "details") {
        return `<details class="details">\n<summary>${token.title}</summary>\n${body}\n</details>\n`;
      }
      return `<div class="box ${token.type}">\n<summary>${token.title}</summary>\n${body}\n</div>\n`;
    },
  };
}

export function isLocalhost(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function isPDF(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

export function bindDeferredPopupLayout(popup: {
  getElement?(): HTMLElement | null | undefined;
  update?(): void;
  setContent?(content: string | HTMLElement): unknown;
  once?(event: string, callback: () => void): unknown;
}): () => void {
  const root = popup.getElement?.();
  // 所有者用のポップアップは、すでに自身でフォーカスを保持し、レイアウトを更新している。
  if (!root || !popup.update || root.querySelector(".geocode-content-popup")) return () => {};
  const liveContent = root.querySelector<HTMLElement>(".md-detail-contents");
  const initialHtml = liveContent?.outerHTML;
  if (liveContent) popup.setContent?.(liveContent);
  const update = () => {
    updatePopupLayout(popup, root);
  };
  root.addEventListener("geocode:contentchange", update);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeEventListener("geocode:contentchange", update);
    disposeMapContent(root);
    if (initialHtml) popup.setContent?.(initialHtml);
  };
  popup.once?.("remove", dispose);
  return dispose;
}

export function setupDetailsLazyImages(
  root: ParentNode = document,
  render?: DeferredDetailsOptions["renderDeferredBody"],
): void {
  const detailsList = root.querySelectorAll<HTMLDetailsElement>(".details");

  detailsList.forEach((details) => {
    if (details.hasAttribute("data-lazy-img-initialized")) return;
    details.setAttribute("data-lazy-img-initialized", "true");

    details.querySelectorAll<HTMLElement>("img[src], video[src]").forEach((element) => {
      if (element.closest("app-camera")) return;
      const src = element.getAttribute("src");
      if (src) {
        element.setAttribute("data-src", src);
        element.removeAttribute("src");
      }
    });

    const loadVisibleMedia = () => {
      if (!details.open) return;
      for (let ancestor = details.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open) return;
      }

      const deferredKey = details.getAttribute("data-deferred-details");
      const deferred = deferredKey ? deferredDetails.get(deferredKey) : undefined;
      if (deferred && !details.hasAttribute("data-deferred-details-loaded")) {
        // HTML の生成とサニタイズは、最初の展開時にのみ行う。ポップアップを開き直した際に画像を保持しないよう、
        // DOM ノードではなく文字列をキャッシュする。
        deferred.html ??= withContentResources(deferred.resources, () =>
          deferred.render(deferred.markdown, deferred.links),
        );
        const template = details.ownerDocument.createElement("template");
        template.innerHTML = deferred.html;
        details.append(template.content);
        details.setAttribute("data-deferred-details-loaded", "true");
        setupDetailsLazyImages(details, deferred.render);
        details.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
      }

      setupProgressiveContent(details, setupDetailsLazyImages);

      const childDetails = details.querySelectorAll<HTMLDetailsElement>(".details");
      const restoreSources = (selector: string) => {
        details.querySelectorAll<HTMLElement>(selector).forEach((element) => {
          for (const child of childDetails) {
            if (!child.open && child.contains(element)) return;
          }
          const deferredSource = element.getAttribute("data-src");
          if (!element.getAttribute("src") && deferredSource) {
            element.setAttribute("src", deferredSource);
          }
        });
      };

      restoreSources("img[data-src]");
      restoreSources("video[data-src]");
      // すでに開いている子要素は、親が閉じている間に初期化された可能性がある。
      // その場合は、遅延していた子自身の本文をここで実体化できる。
      childDetails.forEach((child) => {
        if (child.open) child.dispatchEvent(new Event("toggle"));
      });
    };
    details.addEventListener("toggle", loadVisibleMedia);
    loadVisibleMedia();
  });
  setupProgressiveContent(root, setupDetailsLazyImages);
}
