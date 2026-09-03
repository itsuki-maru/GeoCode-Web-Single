interface MarkdownImageToken {
  href: string;
}

interface MarkdownLinkToken {
  href?: string | null;
  [key: string]: unknown;
}

interface MarkdownRenderer {
  image(token: MarkdownImageToken): string;
  link(token: MarkdownLinkToken): string;
}

interface MarkedRendererNamespace {
  Renderer: new () => MarkdownRenderer;
  setOptions(options: { renderer: MarkdownRenderer }): void;
}

interface MarkdownRendererOptions {
  enablePwaDownloads?: boolean;
  imageMode?: "direct-preview" | "html-preview";
  isLocalhost(url: string): boolean;
  isPdf(url: string): boolean;
  isRunningAsPwa?: () => boolean;
  marked: MarkedRendererNamespace;
}

export interface MapXssOptions {
  onTag(tag: string, html: string): string | undefined;
  stripIgnoreTag: boolean;
  stripIgnoreTagBody: string[];
  whiteList: Record<string, string[]>;
}

export function isRunningAsPwa(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const extendedNavigator = navigator as Navigator & {
    standalone?: boolean;
    vendor?: string;
  };
  if (extendedNavigator.standalone) return true;
  const extendedWindow = window as Window & { opera?: string };
  const userAgent =
    navigator.userAgent || extendedNavigator.vendor || extendedWindow.opera || "";
  return /WebView|wv/.test(userAgent);
}

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
      div: ["class"],
      span: [],
      li: [],
      strong: [],
      ul: [],
      ol: [],
      blockquote: [],
      code: [],
      table: [],
      tbody: [],
      th: [],
      td: [],
      tr: [],
      details: ["class"],
      summary: [],
      "app-youtube": ["video-id", "data-src"],
    },
    onTag(tag) {
      if (tag === "iframe") return "Not Allow iframe ";
      return undefined;
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script"],
  };
}

export function installMapMarkdownRenderer({
  enablePwaDownloads = false,
  imageMode = "direct-preview",
  isLocalhost,
  isPdf,
  isRunningAsPwa: detectPwa = isRunningAsPwa,
  marked,
}: MarkdownRendererOptions): MapXssOptions {
  const renderer = new marked.Renderer();
  renderer.image = ({ href }) => {
    const separator = href.includes("?") ? "&" : "?";
    const thumbnailHref = href ? `${href}${separator}thumb=true` : "";
    if (imageMode === "html-preview") {
      const match = href.match(/\/static\/images\/([^/]+)$/);
      if (!match) return `<img src="${href}">`;
      return `<img src="${thumbnailHref}" class="marker-preview-image" data-preview-src="/images/html/${match[1]}">`;
    }
    return `<img src="${thumbnailHref}" class="marker-preview-image" data-preview-src="${href}">`;
  };

  const originalLinkRenderer = renderer.link.bind(renderer);
  renderer.link = (token) => {
    const href = token.href;
    const html = originalLinkRenderer(token);
    if (!href) return html;

    const isExternal = /^https?:\/\//.test(href);
    const isPdfHref = isPdf(href);
    if (isPdfHref && (!isExternal || isLocalhost(href))) {
      if (enablePwaDownloads && detectPwa()) {
        return html.replace(
          /^<a /,
          `<a class="markdown-download-link" data-download-href="${href}" title="PDFダウンロードリンク" `,
        );
      }
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" title="PDFリンク" ',
      );
    }
    if (isExternal) {
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" title="外部リンク" ',
      );
    }
    return html;
  };

  marked.setOptions({ renderer });
  return createMapXssOptions();
}

export function downloadMapContentFile(href: string): void {
  console.log(`Download Start: ${href}`);
  fetch(href)
    .then((response) => response.blob())
    .then((blob) => {
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "document.pdf";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    })
    .catch(console.error);
}
