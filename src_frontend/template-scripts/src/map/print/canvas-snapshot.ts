/** MapLibre の描画完了を確認した後でだけ呼び出す。その他の canvas は変更しない。 */
export const MAPLIBRE_CANVAS_SELECTOR = "canvas[data-geocode-maplibre-canvas]";

export interface MaplibreCanvasSnapshot {
  index: number;
  dataUrl: string;
  className: string;
  cssText: string;
  styles: Record<string, string>;
}

const copiedStyles = [
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "transform",
  "transform-origin",
  "opacity",
  "display",
  "visibility",
  "z-index",
] as const;

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("中止しました", "AbortError");
}

function isVisible(canvas: HTMLCanvasElement): boolean {
  const rect = canvas.getBoundingClientRect();
  const style = getComputedStyle(canvas);
  return (
    rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  );
}

export function captureMaplibreCanvases(
  root: ParentNode,
  signal: AbortSignal,
  visible: (canvas: HTMLCanvasElement) => boolean = isVisible,
): MaplibreCanvasSnapshot[] {
  checkAbort(signal);
  const snapshots: MaplibreCanvasSnapshot[] = [];
  const canvases = root.querySelectorAll<HTMLCanvasElement>(MAPLIBRE_CANVAS_SELECTOR);
  for (const [index, canvas] of [...canvases].entries()) {
    checkAbort(signal);
    if (!visible(canvas)) continue;
    if (!canvas.width || !canvas.height) throw new Error("背景地図の描画画像が空です。");
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      throw new Error("背景地図を画像化できません。背景地図を再読み込みしてください。");
    }
    if (!dataUrl.startsWith("data:image/png"))
      throw new Error("背景地図を画像化できません。背景地図を再読み込みしてください。");
    const style = getComputedStyle(canvas);
    snapshots.push({
      index,
      dataUrl,
      className: canvas.className,
      cssText: canvas.style.cssText,
      styles: Object.fromEntries(
        copiedStyles.map((property) => [property, style.getPropertyValue(property)]),
      ),
    });
  }
  return snapshots;
}

function snapshotImage(doc: Document, snapshot: MaplibreCanvasSnapshot): HTMLImageElement {
  const image = doc.createElement("img");
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.className = snapshot.className;
  image.dataset.geocodeMaplibrePrintImage = "";
  image.style.cssText = snapshot.cssText;
  for (const [property, value] of Object.entries(snapshot.styles)) {
    if (value) image.style.setProperty(property, value);
  }
  image.src = snapshot.dataUrl;
  return image;
}

/** html2canvas の複製DOM内で使用する。元の画像・SVG処理の後に呼び出す。 */
export function replaceMaplibreCanvasClones(
  root: ParentNode,
  snapshots: readonly MaplibreCanvasSnapshot[],
): void {
  const canvases = root.querySelectorAll<HTMLCanvasElement>(MAPLIBRE_CANVAS_SELECTOR);
  for (const snapshot of snapshots) {
    const canvas = canvases[snapshot.index];
    if (!canvas) throw new Error("背景地図の印刷データが一致しません。");
    canvas.replaceWith(snapshotImage(canvas.ownerDocument, snapshot));
  }
}

function decodeImage(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("中止しました", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("背景地図の印刷画像を読み込めません。"));
    }, 15000);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => image.decode())
      .then(
        () => {
          cleanup();
          resolve();
        },
        () => {
          cleanup();
          reject(new Error("背景地図の印刷画像を読み込めません。"));
        },
      );
  });
}

/** ブラウザー印刷の間だけ描画済み画像を表示する。戻り値は finally / afterprint で呼ぶ。 */
export async function prepareMaplibreCanvasPrint(
  root: ParentNode,
  signal: AbortSignal,
): Promise<() => void> {
  const snapshots = captureMaplibreCanvases(root, signal);
  const canvases = root.querySelectorAll<HTMLCanvasElement>(MAPLIBRE_CANVAS_SELECTOR);
  const changed: {
    canvas: HTMLCanvasElement;
    image: HTMLImageElement;
    display: string;
    priority: string;
  }[] = [];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const { canvas, image, display, priority } of changed) {
      image.remove();
      if (display) canvas.style.setProperty("display", display, priority);
      else canvas.style.removeProperty("display");
    }
  };
  try {
    for (const snapshot of snapshots) {
      checkAbort(signal);
      const canvas = canvases[snapshot.index]!;
      const image = snapshotImage(canvas.ownerDocument, snapshot);
      changed.push({
        canvas,
        image,
        display: canvas.style.getPropertyValue("display"),
        priority: canvas.style.getPropertyPriority("display"),
      });
      // canvas を切り離さず保持し、印刷後も同じ WebGL context を使用する。
      canvas.before(image);
      canvas.style.setProperty("display", "none", "important");
      await decodeImage(image, signal);
    }
    checkAbort(signal);
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}
