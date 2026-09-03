interface NestedToken {
  raw: string;
  title: string;
  tokens: unknown[];
  type: string;
}

interface TokenizerContext {
  lexer: {
    blockTokens(source: string): unknown[];
  };
}

interface MarkedNamespace {
  parser(tokens: unknown[]): string;
}

function getMarked(): MarkedNamespace {
  const marked = (window as Window & { marked?: MarkedNamespace }).marked;
  if (!marked) throw new Error("Marked is not loaded");
  return marked;
}

export function isValidCoordinate(
  latitude: number | string,
  longitude: number | string,
): boolean {
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

export function createNestedTokenizer(typeName: string) {
  return {
    name: typeName,
    level: "block" as const,
    start(source: string): number | undefined {
      const pattern = new RegExp(`^:::${typeName}\\s`, "m");
      return source.match(pattern)?.index;
    },
    tokenizer(
      this: TokenizerContext,
      source: string,
    ): NestedToken | null {
      if (!source.startsWith(`:::${typeName}`)) return null;

      const lines = source.split(/\r?\n/);
      let nestLevel = 0;
      let endIndex = -1;

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (/^:::(\w+)/.test(line)) {
          nestLevel++;
        } else if (/^:::\s*$/.test(line)) {
          nestLevel--;
          if (nestLevel === 0) {
            endIndex = index;
            break;
          }
        }
      }

      if (endIndex === -1) return null;

      const raw = lines.slice(0, endIndex + 1).join("\n");
      const titleMatch = lines[0]!.match(
        new RegExp(`^:::${typeName}\\s+(.+)`),
      );
      const title = titleMatch?.[1]?.trim() ?? typeName.toUpperCase();
      const content = lines.slice(1, endIndex).join("\n");

      return {
        type: typeName,
        raw,
        title,
        tokens: this.lexer.blockTokens(content),
      };
    },
    renderer(token: NestedToken): string {
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

export function setupDetailsLazyImages(root: ParentNode = document): void {
  const detailsList = root.querySelectorAll<HTMLDetailsElement>(".details");

  detailsList.forEach((details) => {
    if (details.hasAttribute("data-lazy-img-initialized")) return;
    details.setAttribute("data-lazy-img-initialized", "true");

    details
      .querySelectorAll<HTMLElement>("img[src], video[src]")
      .forEach((element) => {
        const src = element.getAttribute("src");
        if (src) {
          element.setAttribute("data-src", src);
          element.removeAttribute("src");
        }
      });

    details.addEventListener("toggle", () => {
      if (!details.open) return;

      const childDetails = details.querySelectorAll<HTMLDetailsElement>(".details");
      const loadVisibleMedia = (selector: string) => {
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

      loadVisibleMedia("img[data-src]");
      loadVisibleMedia("video[data-src]");
    });
  });
}
