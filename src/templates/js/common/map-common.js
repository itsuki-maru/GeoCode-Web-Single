function resolveSameOriginContentUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const previewImage = target.closest("img.marker-preview-image");
  if (previewImage) {
    const parsed = resolveSameOriginContentUrl(
      previewImage.getAttribute("data-preview-src"),
    );
    if (
      !parsed ||
      !/^\/(?:static\/images|images\/html)\//.test(parsed.pathname)
    )
      return;
    const previewPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (typeof callParentImagePreview === "function") {
      callParentImagePreview(previewPath);
    } else if (typeof callParent === "function") {
      callParent(previewPath);
    }
    return;
  }

  const downloadLink = target.closest("a.markdown-download-link");
  if (downloadLink) {
    event.preventDefault();
    const parsed = resolveSameOriginContentUrl(
      downloadLink.getAttribute("data-download-href"),
    );
    if (!parsed || typeof downloadFile !== "function") return;
    downloadFile(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  }
});
