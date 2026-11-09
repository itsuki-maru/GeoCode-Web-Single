import { renderCameraImage } from "./mjpeg-camera";
import { createMapXssOptions, type MapXssOptions } from "./markdown-sanitizer";
export { createMapXssOptions, type MapXssOptions } from "./markdown-sanitizer";

interface MarkdownImageToken {
  href: string;
  text?: string;
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
  printing?: boolean;
  enablePwaDownloads?: boolean;
  imageMode?: "direct-preview" | "html-preview";
  isLocalhost(url: string): boolean;
  isPdf(url: string): boolean;
  isRunningAsPwa?: () => boolean;
  marked: MarkedRendererNamespace;
}

export function isRunningAsPwa(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const extendedNavigator = navigator as Navigator & {
    standalone?: boolean;
    vendor?: string;
  };
  if (extendedNavigator.standalone) return true;
  const extendedWindow = window as Window & { opera?: string };
  const userAgent = navigator.userAgent || extendedNavigator.vendor || extendedWindow.opera || "";
  return /WebView|wv/.test(userAgent);
}

export function installMapMarkdownRenderer({
  printing = false,
  enablePwaDownloads = false,
  imageMode = "direct-preview",
  isLocalhost,
  isPdf,
  isRunningAsPwa: detectPwa = isRunningAsPwa,
  marked,
}: MarkdownRendererOptions): MapXssOptions {
  const renderer = new marked.Renderer();
  renderer.image = ({ href, text }) => {
    const camera = renderCameraImage({ href, text }, printing);
    if (camera !== null) return camera;
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
