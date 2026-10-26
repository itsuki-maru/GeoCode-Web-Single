import { Parser } from "htmlparser2";

interface Token {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Token[];
  items?: Token[];
  [key: string]: unknown;
}

interface Piece {
  token: Token;
  start: number;
  end: number;
  html?: string;
}

interface Summary {
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

interface Details {
  attributes: Record<string, string>;
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
  summary?: Summary;
  children: Details[];
}

export type CreateHtmlDetails = (
  attributes: Record<string, string>,
  summaryTokens: unknown[],
  bodyTokens: unknown[],
  hasSummary: boolean,
) => unknown;

const literalTags = new Set(["script", "style", "pre", "code", "textarea"]);

// Raw HTML can span several Marked HTML tokens with real Markdown blocks in
// between. Parse just their tag structure; the blocks remain their original
// tokens, and no hidden body is rendered into HTML or browser DOM here.
export function deferHtmlDetails(tokens: unknown[], createDetails: CreateHtmlDetails): unknown[] {
  const finish = (output: unknown[]) =>
    "links" in tokens
      ? Object.assign(output, { links: (tokens as unknown[] & { links: unknown }).links })
      : output;
  const prepared = (tokens as Token[]).map((token) => {
    if (["blockquote", "note", "warning"].includes(token.type) && token.tokens) {
      return { ...token, tokens: deferHtmlDetails(token.tokens, createDetails) as Token[] };
    }
    if (token.type === "list" && token.items) {
      return {
        ...token,
        items: token.items.map((item) => ({
          ...item,
          tokens: deferHtmlDetails(item.tokens ?? [], createDetails) as Token[],
        })),
      };
    }
    return token;
  });
  if (
    !prepared.some(
      (token) =>
        token.type === "html" && /<\/?details(?:\s|\/?\s*>)/i.test(token.text ?? token.raw ?? ""),
    )
  ) {
    return finish(prepared);
  }

  const pieces: Piece[] = [];
  const roots: Details[] = [];
  const active: Details[] = [];
  const tags: Array<{ name: string; literal: boolean; details?: Details; summary?: Summary }> = [];
  let literalDepth = 0;
  let position = 0;
  let parser: Parser;
  parser = new Parser(
    {
      onopentag(name, attributes) {
        const literal = literalTags.has(name);
        const frame: (typeof tags)[number] = { name, literal };
        if (!literalDepth && !literal && name === "details") {
          const details: Details = {
            attributes: { ...attributes },
            start: parser.startIndex,
            innerStart: parser.endIndex + 1,
            innerEnd: parser.endIndex + 1,
            end: parser.endIndex + 1,
            children: [],
          };
          const parent = active.at(-1);
          if (parent) parent.children.push(details);
          else roots.push(details);
          active.push(details);
          frame.details = details;
        } else if (!literalDepth && !literal && name === "summary") {
          const details = tags.at(-1)?.details;
          if (details && !details.summary) {
            details.summary = {
              start: parser.startIndex,
              innerStart: parser.endIndex + 1,
              innerEnd: parser.endIndex + 1,
              end: parser.endIndex + 1,
            };
            frame.summary = details.summary;
          }
        }
        tags.push(frame);
        if (literal) literalDepth++;
      },
      onclosetag(name, implied) {
        const index = tags.findLastIndex((tag) => tag.name === name);
        if (index === -1) return;
        const frames = tags.splice(index);
        for (const frame of frames.reverse()) {
          if (frame.literal) literalDepth--;
          const selfClosing =
            implied && (frame.summary?.start ?? frame.details?.start) === parser.startIndex;
          const innerEnd = selfClosing ? parser.endIndex + 1 : parser.startIndex;
          const end = implied && !selfClosing ? parser.startIndex : parser.endIndex + 1;
          if (frame.summary) {
            frame.summary.innerEnd = innerEnd;
            frame.summary.end = end;
          }
          if (frame.details) {
            frame.details.innerEnd = innerEnd;
            frame.details.end = end;
            const activeIndex = active.lastIndexOf(frame.details);
            if (activeIndex !== -1) active.splice(activeIndex, 1);
          }
        }
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );

  for (const token of prepared) {
    if (token.type === "html") {
      const html = token.text ?? token.raw ?? "";
      pieces.push({ token, start: position, end: position + html.length, html });
      parser.write(html);
      position += html.length;
    } else {
      // One inert character represents the token for offset bookkeeping. Its
      // Markdown/code source is never fed to the HTML tag parser.
      pieces.push({ token, start: position, end: position + 1 });
      parser.write("\uE000");
      position++;
    }
  }
  parser.end();
  if (!roots.length) return finish(prepared);

  const originalRange = (start: number, end: number): Token[] => {
    const output: Token[] = [];
    let low = 0;
    let high = pieces.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pieces[middle]!.end <= start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < pieces.length; index++) {
      const piece = pieces[index]!;
      if (piece.start >= end) break;
      if (piece.html === undefined) output.push(piece.token);
      else {
        const raw = piece.html.slice(
          Math.max(0, start - piece.start),
          Math.min(piece.html.length, end - piece.start),
        );
        if (raw) output.push({ ...piece.token, raw, text: raw });
      }
    }
    return output;
  };
  const rewriteRange = (start: number, end: number, children: Details[]): unknown[] => {
    const output: unknown[] = [];
    let cursor = start;
    for (const details of children) {
      if (details.start < start || details.end > end) continue;
      output.push(...originalRange(cursor, details.start));
      const summary = details.summary;
      const summaryTokens = summary
        ? rewriteRange(summary.innerStart, summary.innerEnd, details.children)
        : [];
      const bodyTokens = summary
        ? [
            ...rewriteRange(details.innerStart, summary.start, details.children),
            ...rewriteRange(summary.end, details.innerEnd, details.children),
          ]
        : rewriteRange(details.innerStart, details.innerEnd, details.children);
      output.push(createDetails(details.attributes, summaryTokens, bodyTokens, !!summary));
      cursor = details.end;
    }
    output.push(...originalRange(cursor, end));
    return output;
  };
  return finish(rewriteRange(0, position, roots));
}
