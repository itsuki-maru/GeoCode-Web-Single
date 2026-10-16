/** 内容を実行しないテンプレート内で、テキストと HTTP(S) のリンクだけを使って出典表示を組み立て直す。 */
export function formatTileAttribution(value: string): string {
  const source = document.createElement("template");
  source.innerHTML = value;
  const output = document.createElement("div");
  const omittedTags = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "SVG",
    "MATH",
    "TEMPLATE",
  ]);

  const append = (node: Node, parent: HTMLElement): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
    if (omittedTags.has(element.tagName)) return;
    if (element.tagName === "A") {
      const href = element.getAttribute("href")?.trim() || "";
      let url: URL | undefined;
      try {
        if (/^https?:\/\//i.test(href)) url = new URL(href);
      } catch {
        /* 無効なリンクは通常のテキストとして残す。 */
      }
      if (url && (url.protocol === "https:" || url.protocol === "http:")) {
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        // 入力側の属性やマークアップを、出力するリンクへコピーしない。
        link.textContent = element.textContent || "";
        parent.appendChild(link);
        return;
      }
    }
    element.childNodes.forEach((child) => append(child, parent));
  };
  source.content.childNodes.forEach((node) => append(node, output));
  return output.innerHTML;
}
