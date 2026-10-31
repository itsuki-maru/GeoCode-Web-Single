export interface ProgressiveMarkdownRenderer {
  renderBlock(tokens: unknown[]): string;
  renderInline(tokens: unknown[]): string;
  lexInline(source: string): unknown[];
  createInlineLexer?(): {
    inlineTokens(source: string, tokens?: unknown[]): unknown[];
  };
  textChunkSize?: number;
}

interface Token {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Token[];
  items?: Token[];
  header?: Cell[];
  rows?: Cell[][];
  ordered?: boolean;
  escaped?: boolean;
  [key: string]: unknown;
}

interface Cell {
  text: string;
  tokens: Token[];
  header: boolean;
  align: string | null;
}

const INLINE_BATCH_SIZE = 64;
let markerSequence = 0;

interface MarkedInlineLexer {
  inlineTokens(source: string, tokens?: unknown[]): unknown[];
  tokenizer?: {
    rules: { inline: Record<string, RegExp>; [key: string]: unknown };
    emStrong(source: string, maskedSource: string, previous: string): unknown;
    inlineText(source: string): Token | undefined;
    [key: string]: unknown;
  };
  options?: {
    hooks?: { emStrongMask?: (source: string) => string; [key: string]: unknown };
    [key: string]: unknown;
  };
  tokens?: { links?: Record<string, unknown> };
}

function replaceMatches(
  source: string,
  pattern: RegExp,
  replacement: (match: RegExpExecArray) => string,
): string {
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const parts: string[] = [];
  let start = 0;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    parts.push(source.slice(start, match.index), replacement(match));
    start = match.index + match[0].length;
    if (!match[0].length) regex.lastIndex++;
  }
  parts.push(source.slice(start));
  return parts.join("");
}

function inlineMask(source: string, lexer: MarkedInlineLexer): string | undefined {
  const rules = lexer.tokenizer?.rules.inline;
  if (!rules?.reflinkSearch || !rules.anyPunctuation || !rules.blockSkip) return undefined;
  const references = lexer.tokens?.links;
  let masked = references
    ? replaceMatches(source, rules.reflinkSearch, (match) =>
        Object.hasOwn(references, match[0].slice(match[0].lastIndexOf("[") + 1, -1))
          ? `[${"a".repeat(match[0].length - 2)}]`
          : match[0],
      )
    : source;
  masked = replaceMatches(masked, rules.anyPunctuation, () => "++");
  masked = replaceMatches(masked, rules.blockSkip, (match) => {
    const prefix = match[2]?.length ?? 0;
    return `${match[0].slice(0, prefix)}[${"a".repeat(match[0].length - prefix - 2)}]`;
  });
  const hook = lexer.options?.hooks?.emStrongMask;
  return hook ? hook.call({ lexer }, masked) : masked;
}

function marker(): string {
  return `GEOCODECHILDMARKER${++markerSequence}X${Math.random().toString(36).slice(2)}END`;
}

function markerToken(text: string): Token {
  return { type: "html", raw: text, text, block: false, pre: false };
}

function splitMarker(html: string, text: string): [string, string] | undefined {
  const index = html.indexOf(text);
  if (index === -1) return undefined;
  return [html.slice(0, index), html.slice(index + text.length)];
}

function splitClosingTag(html: string, tag: string): [string, string] | undefined {
  const index = html.lastIndexOf(`</${tag}>`);
  return index === -1 ? undefined : [html.slice(0, index), html.slice(index)];
}

function* textChunks(text: string, size: number): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    // UTF-16 のサロゲートペアや、通常の Marked のテキスト描画処理が一続きとして扱う
    // HTML エンティティーを分割しない。
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
    const ampersand = text.lastIndexOf("&", end - 1);
    if (ampersand >= start && !text.slice(ampersand, end).includes(";")) {
      const semicolon = text.indexOf(";", end);
      if (semicolon !== -1 && semicolon - ampersand <= 64) end = semicolon + 1;
    }
    yield text.slice(start, end);
    start = end;
  }
}

function escapeCode(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// Marked はカーソルを公開していないが、出力配列を受け取れる。完全な最上位トークンを上限数だけ処理して止め、
// それらに正確に対応する生のテキスト範囲だけを消費する。
// 入れ子のインライン解析は、そのコンテナー自体を処理するまで遅延する。
function* inlineTokens(source: string, renderer: ProgressiveMarkdownRenderer): Generator<Token> {
  // これらは、Marked とこのアプリの動画・YouTube 拡張が使うインラインの区切り文字である。
  // 通常の文章には、段落全体の字句解析は不要である。
  if (!/[\\`*_[\]<>~@:\r\n]|www\./i.test(source)) {
    if (source) yield { type: "text", raw: source, text: source, escaped: false };
    return;
  }
  if (!renderer.createInlineLexer) {
    yield* renderer.lexInline(source) as Token[];
    return;
  }
  const lexer = renderer.createInlineLexer() as MarkedInlineLexer;
  let masked = inlineMask(source, lexer);
  if (masked === undefined || !lexer.tokenizer || !lexer.options) {
    yield* renderer.lexInline(source) as Token[];
    return;
  }
  // Marked 17 は、一致するたびにソース全体を連結してマスク済み文字列を作り直す。
  // 上記の同等な線形処理の結果を、このカーソル用にキャッシュする。
  // 共有の Marked の既定値を変更しないよう、アダプターの状態を複製する。
  const tokenizer = Object.assign(
    Object.create(Object.getPrototypeOf(lexer.tokenizer)),
    lexer.tokenizer,
  ) as NonNullable<MarkedInlineLexer["tokenizer"]>;
  const noMatch = /a^/g;
  tokenizer.rules = {
    ...tokenizer.rules,
    inline: {
      ...tokenizer.rules.inline,
      reflinkSearch: noMatch,
      anyPunctuation: noMatch,
      blockSkip: noMatch,
    },
  };
  lexer.tokenizer = tokenizer;
  lexer.options = {
    ...lexer.options,
    hooks: { ...lexer.options.hooks, emStrongMask: () => masked! },
  };
  let active: Token[] = [];
  let carryPrevious = "";
  let nextPrevious = "";
  let emPrevious = "";
  let lastText: Token | undefined;
  let lastTextPrevious = "";
  const originalEmStrong = tokenizer.emStrong;
  tokenizer.emStrong = function (text, mask, previous) {
    emPrevious = active.length ? previous : carryPrevious;
    return originalEmStrong.call(this, text, mask, emPrevious);
  };
  const originalInlineText = tokenizer.inlineText;
  tokenizer.inlineText = function (text) {
    lastText = originalInlineText.call(this, text);
    if (lastText)
      lastTextPrevious = lastText.raw?.endsWith("_") ? emPrevious : (lastText.raw?.slice(-1) ?? "");
    return lastText;
  };
  const original = lexer.inlineTokens;
  let depth = 0;
  lexer.inlineTokens = function (text: string, tokens: unknown[] = []): unknown[] {
    if (depth) return tokens;
    depth++;
    try {
      return original.call(lexer, text, tokens);
    } finally {
      depth--;
    }
  };
  while (source) {
    const stop = {};
    const tokens: Token[] = [];
    active = tokens;
    tokens.push = (...items: Token[]) => {
      const length = Array.prototype.push.apply(tokens, items);
      if (length >= INLINE_BATCH_SIZE) {
        nextPrevious = items.at(-1) === lastText ? lastTextPrevious : "";
        throw stop;
      }
      return length;
    };
    try {
      lexer.inlineTokens(source, tokens);
    } catch (error) {
      if (error !== stop) throw error;
    } finally {
      Reflect.deleteProperty(tokens, "push");
    }
    const consumed = tokens.reduce((length, token) => length + (token.raw?.length ?? 0), 0);
    if (!consumed) {
      // カスタムアダプターは、必ず処理を先へ進める必要がある。ここで通常の全体用字句解析を使い、
      // 元の内容が欠落したり、無限ループになったりすることを防ぐ。
      yield* renderer.lexInline(source) as Token[];
      return;
    }
    yield* tokens;
    source = source.slice(consumed);
    masked = masked.slice(consumed);
    carryPrevious = nextPrevious;
  }
}

function* children(
  token: { text?: string; tokens?: Token[] },
  renderer: ProgressiveMarkdownRenderer,
): Generator<Token> {
  const tokens = token.tokens;
  if (tokens?.length && !tokens.every((child) => child.type === "checkbox")) {
    yield* tokens;
    return;
  }
  let text = token.text ?? "";
  // ブロックのみの字句解析でも、インラインの待機列をスキップする前にタスクのチェックボックスが
  // 設定される場合がある。それを保持し、残りのラベルは表示するときにだけ解析する。
  for (const checkbox of tokens ?? []) {
    yield checkbox;
    if (checkbox.raw && text.startsWith(checkbox.raw)) text = text.slice(checkbox.raw.length);
  }
  yield* inlineTokens(text, renderer);
}

function hydrateInline(token: Token, renderer: ProgressiveMarkdownRenderer): Token {
  if (!["strong", "em", "del", "link", "image"].includes(token.type)) return token;
  return {
    ...token,
    tokens: Array.from(children(token, renderer), (child) => hydrateInline(child, renderer)),
  };
}

function* inlineStream(
  tokens: Iterable<Token>,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
): Generator<string> {
  for (const token of tokens) {
    if (["strong", "em", "del", "link"].includes(token.type)) {
      const text = marker();
      const skeleton = renderer.renderInline([{ ...token, text, tokens: [markerToken(text)] }]);
      const wrapper = splitMarker(skeleton, text);
      if (wrapper) {
        yield wrapper[0];
        yield* inlineStream(children(token, renderer), renderer, size);
        yield wrapper[1];
      } else yield renderer.renderInline([hydrateInline(token, renderer)]);
    } else if (token.type === "text" && !token.tokens?.length) {
      for (const text of textChunks(token.text ?? token.raw ?? "", size))
        yield renderer.renderInline([{ ...token, text, raw: text }]);
    } else if (token.type === "text" && token.tokens?.length) {
      yield* inlineStream(token.tokens, renderer, size);
    } else if (token.type === "codespan") {
      const text = marker();
      const wrapper = splitMarker(renderer.renderInline([{ ...token, text }]), text);
      if (wrapper) {
        yield wrapper[0];
        for (const part of textChunks(token.text ?? "", size)) yield escapeCode(part);
        yield wrapper[1];
      } else yield renderer.renderInline([token]);
    } else if (token.type === "html") {
      // この断片のタグを閉じたり、対応関係を調整したりしない。生の開始タグが後続の Markdown ブロックを囲む場合があるため、
      // 利用側で一つの HTML ストリームのスタックを維持する。
      yield token.text ?? token.raw ?? "";
    } else
      yield renderer.renderInline([
        token.type === "image" ? hydrateInline(token, renderer) : token,
      ]);
  }
}

function* container(
  token: Token,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
  blockChildren: boolean,
): Generator<string> {
  const text = marker();
  const skeleton = renderer.renderBlock([{ ...token, text, tokens: [markerToken(text)] }]);
  const wrapper = splitMarker(skeleton, text);
  if (!wrapper) {
    yield renderer.renderBlock([token]);
    return;
  }
  yield wrapper[0];
  if (blockChildren) yield* blockStream(token.tokens ?? [], renderer, size);
  else yield* inlineStream(children(token, renderer), renderer, size);
  yield wrapper[1];
}

function* listStream(
  token: Token,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
): Generator<string> {
  const tag = token.ordered ? "ol" : "ul";
  const empty = renderer.renderBlock([{ ...token, items: [] }]);
  const outer = splitClosingTag(empty, tag);
  if (!outer) {
    yield renderer.renderBlock([token]);
    return;
  }
  yield outer[0];
  for (const item of token.items ?? []) {
    const text = marker();
    const html = renderer.renderBlock([
      { ...token, items: [{ ...item, tokens: [markerToken(text)] }] },
    ]);
    const inner =
      html.startsWith(outer[0]) && html.endsWith(outer[1])
        ? html.slice(outer[0].length, html.length - outer[1].length)
        : "";
    const wrapper = splitMarker(inner, text);
    if (!wrapper) {
      // このフォールバックは一項目に限定し、未表示の一覧全体には適用しない。
      const rendered = renderer.renderBlock([{ ...token, items: [item] }]);
      yield rendered.startsWith(outer[0]) && rendered.endsWith(outer[1])
        ? rendered.slice(outer[0].length, rendered.length - outer[1].length)
        : rendered;
      continue;
    }
    yield wrapper[0];
    yield* blockStream(item.tokens ?? [], renderer, size);
    yield wrapper[1];
  }
  yield outer[1];
}

function* cellStream(
  cell: Cell,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
): Generator<string> {
  const tag = cell.header ? "th" : "td";
  const align = ["left", "right", "center"].includes(cell.align ?? "")
    ? ` align="${cell.align}"`
    : "";
  yield `<${tag}${align}>`;
  yield* inlineStream(children(cell, renderer), renderer, size);
  yield `</${tag}>\n`;
}

function* tableStream(
  token: Token,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
): Generator<string> {
  // Marked の標準テーブル描画との差は、セルの内容と配置だけである。
  // 囲みのタグを開いたままにすることで、巨大な一行や一セルにも通常の段落と同じ DOM 数・文字数の
  // 上限を適用し、ヘッダーの繰り返しを避ける。
  yield "<table>\n<thead>\n<tr>\n";
  for (const cell of token.header ?? []) yield* cellStream(cell, renderer, size);
  yield "</tr>\n</thead>\n";
  if (token.rows?.length) {
    yield "<tbody>";
    for (const row of token.rows) {
      yield "<tr>\n";
      for (const cell of row) yield* cellStream(cell, renderer, size);
      yield "</tr>\n";
    }
    yield "</tbody>";
  }
  yield "</table>\n";
}

function* blockStream(
  tokens: Iterable<Token>,
  renderer: ProgressiveMarkdownRenderer,
  size: number,
): Generator<string> {
  for (const token of tokens) {
    if (typeof token.progressiveHtml === "function") {
      yield* (token.progressiveHtml as () => IterableIterator<string>)();
    } else if (["paragraph", "heading"].includes(token.type)) {
      yield* container(token, renderer, size, false);
    } else if (["blockquote", "note", "warning"].includes(token.type)) {
      yield* container(token, renderer, size, true);
    } else if (token.type === "text") {
      yield* inlineStream(children(token, renderer), renderer, size);
    } else if (token.type === "list") {
      yield* listStream(token, renderer, size);
    } else if (token.type === "table") {
      yield* tableStream(token, renderer, size);
    } else if (token.type === "code") {
      const text = marker();
      const wrapper = splitMarker(renderer.renderBlock([{ ...token, text, escaped: true }]), text);
      if (!wrapper) yield renderer.renderBlock([token]);
      else {
        yield wrapper[0];
        const body = (token.text ?? "").replace(/\n$/, "");
        for (const part of textChunks(body, size)) yield token.escaped ? part : escapeCode(part);
        yield wrapper[1];
      }
    } else if (token.type === "html") {
      yield token.text ?? token.raw ?? "";
    } else yield renderer.renderBlock([token]);
  }
}

// 断片には閉じていないコンテナーが含まれる場合がある。利用側では断片をまたいで一つの HTML パーサーを維持し、
// DOM を作る前にサニタイズし、自身のノード数・文字数の上限で実体化を止める。
// ここでは DOM も、未表示部分全体の HTML も構築しない。
export function createMarkdownStream(
  tokens: unknown[],
  renderer: ProgressiveMarkdownRenderer,
): Generator<string> {
  return blockStream(tokens as Token[], renderer, Math.max(1, renderer.textChunkSize ?? 2048));
}
