interface MapContentActionsOptions {
  downloadFile?: (path: string) => void;
  origin?: string;
  previewImage?: (path: string) => void;
  root?: Document;
}

export function resolveSameOriginContentUrl(
  rawUrl: unknown,
  origin = window.location.origin,
): URL | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl, origin);
    return parsed.origin === origin ? parsed : null;
  } catch {
    return null;
  }
}

export function installMapContentActions({
  downloadFile,
  origin = window.location.origin,
  previewImage,
  root = document,
}: MapContentActionsOptions = {}): () => void {
  const handleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const previewElement = target.closest("img.marker-preview-image");
    if (previewElement) {
      const parsed = resolveSameOriginContentUrl(
        previewElement.getAttribute("data-preview-src"),
        origin,
      );
      if (!parsed || !/^\/(?:static\/images|images\/html)\//.test(parsed.pathname)) {
        return;
      }
      previewImage?.(`${parsed.pathname}${parsed.search}${parsed.hash}`);
      return;
    }

    const downloadLink = target.closest("a.markdown-download-link");
    if (!downloadLink) return;

    event.preventDefault();
    const parsed = resolveSameOriginContentUrl(
      downloadLink.getAttribute("data-download-href"),
      origin,
    );
    if (!parsed) return;
    downloadFile?.(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  };

  root.addEventListener("click", handleClick);
  return () => root.removeEventListener("click", handleClick);
}
