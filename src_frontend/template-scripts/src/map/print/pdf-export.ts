import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { PRINT_PAPERS, type PrintPaper } from "../common/print-state";

const EXCLUDED = ".leaflet-control-zoom, .leaflet-popup-close-button";
export function pdfScale(width: number, height: number): number {
  return Math.min(150 / 96, Math.sqrt(4_000_000 / (width * height)));
}
export function pdfFilename(title: string): string {
  return `${(title.trim() || "GeoCode-Web").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80)}.pdf`;
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("中止しました", "AbortError");
}

// Load through <img>, not fetch: existing CSP permits HTTPS images. Anonymous
// CORS is still required even when the original map displays the image normally.
async function imageData(src: string, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      img.onload = null;
      img.onerror = null;
    };
    const fail = () => {
      cleanup();
      img.src = "";
      reject(
        new Error(
          "画像をPDFに取り込めません。配信元の制限または通信エラーが考えられます。対象の背景地図・重ね合わせタイルを変更して再実行してください。",
        ),
      );
    };
    const abort = () => {
      cleanup();
      img.src = "";
      reject(new DOMException("中止しました", "AbortError"));
    };
    const timer = setTimeout(fail, 15000);
    signal.addEventListener("abort", abort, { once: true });
    img.onerror = fail;
    img.onload = () => {
      cleanup();
      resolve();
    };
    img.src = src;
  });
  checkAbort(signal);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    if (!canvas.width || !canvas.height) throw new Error("画像が空です。");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像処理用のメモリを確保できません。");
    context.drawImage(img, 0, 0);
    const data = canvas.toDataURL("image/png");
    if (data === "data:,") throw new Error("画像を生成できません。");
    return data;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function generateMapPdf(
  paper: HTMLElement,
  paperId: PrintPaper,
  title: string,
  signal: AbortSignal,
): Promise<Blob> {
  checkAbort(signal);
  await document.fonts.ready;
  const width = paper.offsetWidth,
    height = paper.offsetHeight;
  const bounds = paper.getBoundingClientRect();
  const visible = (node: Element) => {
    if (node.closest(EXCLUDED)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > bounds.left &&
      rect.left < bounds.right &&
      rect.bottom > bounds.top &&
      rect.top < bounds.bottom
    );
  };
  const imgs = [...paper.querySelectorAll("img")];
  const sources = new Map<string, string>();
  // Sequential conversion bounds peak memory and requests; repeated tiles reuse data.
  for (const img of imgs.filter(visible)) {
    checkAbort(signal);
    const src = img.currentSrc || img.src;
    if (!img.complete || !img.naturalWidth)
      throw new Error("未取得の画像があります。再読み込みするか対象のタイルを外してください。");
    if (!sources.has(src)) sources.set(src, await imageData(src, signal));
  }
  const svgNodes = [...paper.querySelectorAll<SVGSVGElement>("svg")];
  const svgImages = new Map<number, string>();
  for (const [index, svg] of svgNodes.entries()) {
    if (!visible(svg)) continue;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const originals = [svg, ...svg.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    // Standalone SVGs cannot see the document stylesheet. Preserve computed paint.
    originals.forEach((original, i) => {
      const style = getComputedStyle(original);
      for (const property of [
        "fill",
        "fill-opacity",
        "fill-rule",
        "stroke",
        "stroke-width",
        "stroke-opacity",
        "stroke-dasharray",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "marker-start",
        "marker-end",
        "display",
        "visibility",
      ]) {
        copies[i]!.setAttribute(
          property,
          style
            .getPropertyValue(property)
            .replace(/url\(["']?[^)#]*#([^)'" ]+)["']?\)/g, "url(#$1)"),
        );
      }
    });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(svg.width.baseVal.value));
    clone.setAttribute("height", String(svg.height.baseVal.value));
    clone.style.transform = "none";
    svgImages.set(
      index,
      await imageData(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`,
        signal,
      ),
    );
  }
  // Custom HTML icons with remote CSS backgrounds need explicit handling rather
  // than html2canvas silently omitting inaccessible assets.
  const elements = [paper, ...paper.querySelectorAll<HTMLElement>("*")];
  const backgrounds = new Map<number, string>();
  for (const [index, node] of elements.entries()) {
    if (!visible(node)) continue;
    let background = getComputedStyle(node).backgroundImage;
    for (const match of [...background.matchAll(/url\(["']?(.*?)["']?\)/g)]) {
      const src = match[1]!;
      if (!sources.has(src)) sources.set(src, await imageData(src, signal));
      background = background.replace(match[0], `url("${sources.get(src)}")`);
    }
    if (background.includes("url(")) backgrounds.set(index, background);
  }
  checkAbort(signal);
  let canvas: HTMLCanvasElement | undefined;
  const temporary: { frame: Element | null } = { frame: null };
  try {
    canvas = await html2canvas(paper, {
      scale: pdfScale(width, height),
      width,
      height,
      backgroundColor: "#ffffff",
      useCORS: true,
      allowTaint: false,
      logging: false,
      windowWidth: Math.max(window.innerWidth, width + 400),
      windowHeight: Math.max(window.innerHeight, height + 100),
      onclone: async (_doc, clone) => {
        temporary.frame = _doc.defaultView?.frameElement ?? null;
        clone.style.transform = "none";
        clone.style.boxShadow = "none";
        const nodes = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
        for (const [index, background] of backgrounds)
          nodes[index]!.style.backgroundImage = background;
        const imageClones = [...clone.querySelectorAll("img")];
        imageClones.forEach((img, index) => {
          const original = imgs[index]!;
          const data = sources.get(original.currentSrc || original.src);
          if (data) {
            img.removeAttribute("srcset");
            img.src = data;
          } else img.remove();
        });
        [...clone.querySelectorAll("svg")].forEach((svg, index) => {
          const data = svgImages.get(index);
          if (!data) {
            svg.remove();
            return;
          }
          const img = _doc.createElement("img");
          img.src = data;
          img.style.cssText = svg.style.cssText;
          img.style.position = getComputedStyle(svgNodes[index]!).position;
          img.style.width = `${svgNodes[index]!.width.baseVal.value}px`;
          img.style.height = `${svgNodes[index]!.height.baseVal.value}px`;
          svg.replaceWith(img);
        });
        clone.querySelectorAll(EXCLUDED).forEach((node) => node.remove());
        await Promise.all([...clone.querySelectorAll("img")].map((img) => img.decode()));
        checkAbort(signal);
      },
    });
    checkAbort(signal);
    const chosen = PRINT_PAPERS[paperId];
    const pdf = new jsPDF({
      orientation: chosen.width > chosen.height ? "landscape" : "portrait",
      unit: "mm",
      format: [chosen.width, chosen.height],
      compress: true,
    });
    pdf.setProperties({ title: title || "地図", creator: "GeoCode-Web" });
    pdf.addImage(canvas, "PNG", 0, 0, chosen.width, chosen.height, undefined, "FAST");
    // Keep attribution links usable even though page content is rasterized.
    for (const link of paper.querySelectorAll<HTMLAnchorElement>(
      ".leaflet-control-attribution a",
    )) {
      if (!visible(link) || !/^https?:/.test(link.href)) continue;
      const r = link.getBoundingClientRect();
      pdf.link(
        ((r.left - bounds.left) / bounds.width) * chosen.width,
        ((r.top - bounds.top) / bounds.height) * chosen.height,
        (r.width / bounds.width) * chosen.width,
        (r.height / bounds.height) * chosen.height,
        { url: link.href },
      );
    }
    return pdf.output("blob");
  } finally {
    // html2canvas does not remove its temporary iframe when onclone rejects.
    temporary.frame?.remove();
    if (canvas) canvas.width = canvas.height = 0;
    sources.clear();
    svgImages.clear();
  }
}
