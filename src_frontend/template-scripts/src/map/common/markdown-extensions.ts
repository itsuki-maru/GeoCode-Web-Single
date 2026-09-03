interface MarkdownToken {
  href: string;
  raw: string;
  text: string;
  tokens?: unknown[];
  type: string;
}

interface MarkdownTokenizerContext {
  lexer: {
    inlineTokens(source: string, tokens: unknown[]): unknown[];
  };
}

interface MarkdownExtension {
  level?: "inline";
  name: string;
  renderer?(token: MarkdownToken): string;
  start?(source: string): number | undefined;
  tokenizer?(
    this: MarkdownTokenizerContext,
    source: string,
    tokens: unknown[],
  ): MarkdownToken | null | undefined;
}

interface MarkedExtensions {
  use(options: { extensions: MarkdownExtension[] }): void;
}

interface MarkdownExtensionDependencies {
  createNestedTokenizer(type: string): MarkdownExtension;
  extractYouTubeId(url: string): string | null;
  marked: MarkedExtensions;
}

export function createVideoMarkdownToken(): MarkdownExtension {
  return {
    name: "video",
    level: "inline",
    start(source) {
      return source.match(/\?\[.*\]\(.*\)/)?.index;
    },
    tokenizer(source) {
      const match = /^\?\[(.*?)\]\((.*?)\)/.exec(source);
      if (!match) return undefined;
      return {
        type: "video",
        raw: match[0],
        text: match[1]!,
        href: match[2]!,
        tokens: this.lexer.inlineTokens(match[1]!, []),
      };
    },
    renderer(token) {
      return `<video controls src="${token.href}" poster="${token.href}?thumb=true" preload="none">${token.text}</video>`;
    },
  };
}

export function createYouTubeMarkdownToken(
  extractYouTubeId: (url: string) => string | null,
): MarkdownExtension {
  return {
    name: "youtube",
    level: "inline",
    start(source) {
      return source.match(/\?\[.*\]\(.*\)/)?.index;
    },
    tokenizer(source) {
      const match = /^\@\[(youtube)\]\((.*?)\)/.exec(source);
      if (!match) return null;
      const id = extractYouTubeId(match[2]!);
      if (!id) return null;
      return {
        type: "youtube",
        raw: match[0],
        text: id,
        href: match[2]!,
      };
    },
    renderer(token) {
      return `<app-youtube video-id="${token.text}" data-src="${token.href}"></app-youtube>`;
    },
  };
}

export function installMapMarkdownExtensions({
  createNestedTokenizer,
  extractYouTubeId,
  marked,
}: MarkdownExtensionDependencies): void {
  marked.use({
    extensions: [
      createVideoMarkdownToken(),
      createNestedTokenizer("details"),
      createNestedTokenizer("note"),
      createNestedTokenizer("warning"),
      createYouTubeMarkdownToken(extractYouTubeId),
    ],
  });
}
