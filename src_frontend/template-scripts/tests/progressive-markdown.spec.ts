import { describe, expect, it, vi } from "vitest";
import { Marked, type Token } from "marked";
import {
  createMarkdownStream,
  type ProgressiveMarkdownRenderer,
} from "../src/map/common/progressive-markdown";

function fixture(source: string, blockOnly = false, chunkSize = 16) {
  const marked = new Marked();
  const lexer = new marked.Lexer(marked.defaults);
  if (blockOnly) lexer.inlineTokens = (_text, tokens = []) => tokens;
  const tokens = lexer.lex(source);
  const newLexer = () => {
    const inline = new marked.Lexer(marked.defaults);
    Object.assign(inline.tokens.links, tokens.links);
    return inline;
  };
  const renderer: ProgressiveMarkdownRenderer = {
    renderBlock: (parts) => marked.parser(parts as Token[]),
    renderInline: (parts) => marked.Parser.parseInline(parts as Token[], marked.defaults),
    lexInline: (text) => newLexer().inlineTokens(text),
    createInlineLexer: newLexer as ProgressiveMarkdownRenderer["createInlineLexer"],
    textChunkSize: chunkSize,
  };
  return { marked, tokens, renderer, stream: createMarkdownStream(tokens, renderer) };
}

const samples = [
  "plain text &amp; characters 😀 and escaped \\* marker",
  "# Heading *with emphasis*\n\nA paragraph with **strong [link](/target)** and `code & value`.\n\n---",
  "- first\n- second\n  - nested\n  - other\n\n1. ordered\n2. last",
  "3. first\n\n4. second\n\n- [x] checked\n- [ ] unchecked",
  "> quoted **text**\n>\n> another paragraph\n\nend",
  "| Left | Right |\n| :--- | ---: |\n| **one** | [two](/two) |\n| three | four |",
  "```typescript\nconst value = '<x> & quote';\n\n```",
  "<div>\n\nA *Markdown* paragraph.\n\n</div>\n\n<!-- comment -->",
  '![reference][shared]\n\n[![linked][shared]](/target)\n\n[shared]: /image.jpg "title"',
  "A very long **strong _nested_ &amp; phrase** repeated. ".repeat(20),
];

describe("progressive Markdown stream", () => {
  it.each(samples)("matches Marked output with a fully parsed AST: %s", (source) => {
    const f = fixture(source);
    expect([...f.stream].join("")).toBe(f.marked.parse(source));
  });

  it.each(samples)("matches Marked output with block-only parsing: %s", (source) => {
    const f = fixture(source, true);
    expect([...f.stream].join("")).toBe(f.marked.parse(source));
  });

  it("does not render later blocks or inline descendants until visited", () => {
    const source = `First\n\n${"![image](/image.jpg) ".repeat(3000)}\n\nLast`;
    const f = fixture(source, true);
    const renderBlock = vi.spyOn(f.renderer, "renderBlock");
    const renderInline = vi.spyOn(f.renderer, "renderInline");
    const stream = createMarkdownStream(f.tokens, f.renderer);
    expect(renderBlock).not.toHaveBeenCalled();
    expect(renderInline).not.toHaveBeenCalled();
    expect(stream.next().value).toBe("<p>");
    expect(renderInline).not.toHaveBeenCalled();
    expect(stream.next().value).toBe("First");
    expect(renderInline).toHaveBeenCalledTimes(1);
  });

  it("limits text pieces while retaining entities and surrogate pairs", () => {
    const source = `a${"😀 &amp; ".repeat(1000)}`;
    const f = fixture(source, true, 7);
    const pieces = [...f.stream];
    expect(pieces.join("")).toBe(f.marked.parse(source));
    expect(pieces.every((piece) => !/[\uD800-\uDBFF]$/.test(piece))).toBe(true);
    expect(
      pieces.filter((piece) => !piece.startsWith("<")).every((piece) => piece.length <= 70),
    ).toBe(true);
  });

  it("defers nested inline parsing across a giant strong container", () => {
    const f = fixture(`**${"![image](/image.jpg) ".repeat(3000).trimEnd()}**`, true);
    const sourceLexer = f.renderer.createInlineLexer!;
    const calls: number[] = [];
    f.renderer.createInlineLexer = () => {
      const lexer = sourceLexer();
      const original = lexer.inlineTokens;
      lexer.inlineTokens = function (text, tokens) {
        calls.push(text.length);
        return original.call(lexer, text, tokens);
      };
      return lexer;
    };
    const stream = createMarkdownStream(f.tokens, f.renderer);
    expect(stream.next().value).toBe("<p>");
    expect(calls).toHaveLength(0);
    expect(stream.next().value).toBe("<strong>");
    // The nested call returns immediately instead of parsing all 3,000 images.
    expect(calls).toHaveLength(1);
    expect(stream.next().value).toContain('<img src="/image.jpg"');
  });

  it.each([
    `${"[x](/x) ".repeat(31)}[x](/x)word_a_ and **strong**`,
    `${"[x](/x) ".repeat(31)}[x](/x)word_aa_bb_cc_`,
    `${"![x](/x) ".repeat(70)} **[ref][shared]**\n\n[shared]: /reference`,
    `<code>${"raw &amp; *text* ".repeat(100)}</code>`,
    `**${"[x](/x) ".repeat(300).trimEnd()}**`,
  ])("retains inline grammar across cursor batches: %s", (source) => {
    const f = fixture(source, true);
    expect([...f.stream].join("")).toBe(f.marked.parse(source));
  });
});
