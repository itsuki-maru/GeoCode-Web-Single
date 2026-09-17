/// <reference types="vite/client" />
import css from "./print-preview.css?inline";
import { createPdfControls } from "./pdf-controls";
import { initializeReadOnlyMapPage } from "../read-only-page";
import { createLayerBulkToggleControl } from "../common/base";
import {
  isPrintMapState,
  PRINT_PAPERS,
  type PrintMapState,
  type PrintPaper,
} from "../common/print-state";

// This document owns both the interactive paper and the print job, so the map
// keeps the same CSS pixel dimensions when the browser switches to print media.
export function createPrintPreview(state: PrintMapState, close: () => void) {
  const style = document.createElement("style");
  style.textContent = css;
  const pageStyle = document.createElement("style");
  document.head.append(style, pageStyle);
  const layout = document.createElement("main");
  layout.id = "print-layout";
  layout.innerHTML = `
    <aside id="print-settings" aria-label="印刷設定">
      <h1>地図の印刷</h1>
      <label class="print-field">用紙<select id="print-size">${Object.entries(PRINT_PAPERS)
        .map(
          ([id, paper]) =>
            `<option value="${id}" ${id === "a4-landscape" ? "selected" : ""}>${paper.label}</option>`,
        )
        .join("")}</select></label>
      <label class="print-field">タイトル（任意・40文字まで）<input id="print-title-input" type="text" maxlength="40" placeholder="例：避難場所の案内図"></label>
      <div class="print-actions"><button id="print-submit" type="button" disabled>印刷</button><button id="print-retry" type="button" hidden>再読み込み</button></div>
      <div id="print-status" role="status" aria-live="polite">地図を読み込んでいます…</div>
      <h2>背景地図</h2><div id="print-base"></div>
      <h2>レイヤ（グループ）</h2><div id="print-layers" role="group" aria-label="レイヤ（グループ）"></div>
      <h2>表示対象・重ね合わせタイル</h2><div id="print-overlays" role="group" aria-label="表示対象・重ね合わせタイル"></div>
      <h2>ラベル・表示操作</h2><div id="print-extra"></div>
    </aside>
    <section id="print-viewport" aria-label="印刷プレビュー"><div id="print-paper-space"><article id="print-paper"><h2 id="print-title"></h2></article></div></section>`;
  document.body.append(layout);
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const paper = element<HTMLElement>("print-paper");
  const mapElement = element<HTMLElement>("map");
  paper.append(mapElement);
  const runtime = initializeReadOnlyMapPage("map-anather", state);
  const map = runtime.map;
  const moveControl = (control: any, destination: string) => {
    const container = control.getContainer();
    if (container) element(destination).append(container);
  };
  moveControl(runtime.tileControl, "print-base");
  moveControl(runtime.layerControl, "print-layers");
  moveControl(runtime.visibilityControl, "print-overlays");
  const groupBulkControl = mapElement.querySelector(".layer-bulk-toggle-control");
  if (groupBulkControl) element("print-layers").append(groupBulkControl);
  const visibilityBulkControl = createLayerBulkToggleControl({
    map: map as Parameters<typeof createLayerBulkToggleControl>[0]["map"],
    overlayLayers: runtime.printVisibilityLayers,
  });
  map.addControl(visibilityBulkControl);
  moveControl(visibilityBulkControl, "print-overlays");
  mapElement.querySelectorAll<HTMLElement>(".leaflet-control").forEach((control) => {
    if (!control.matches(".leaflet-control-zoom, .leaflet-control-attribution, .nowcast-status")) {
      element("print-extra").append(control);
    }
  });

  const viewport = element<HTMLElement>("print-viewport");
  const space = element<HTMLElement>("print-paper-space");
  const title = element<HTMLElement>("print-title");
  const titleInput = element<HTMLInputElement>("print-title-input");
  const size = element<HTMLSelectElement>("print-size");
  const submit = element<HTMLButtonElement>("print-submit");
  const retry = element<HTMLButtonElement>("print-retry");
  const status = element<HTMLElement>("print-status");
  let disposed = false;
  let printing = false;
  let moving = false;
  let pdfControls: ReturnType<typeof createPdfControls> | undefined;
  let lastChange = Date.now();
  let lastPending = Date.now();
  let failedTiles = new WeakSet<HTMLImageElement>();
  const watchedLayers = new Set<any>();
  const markChanged = () => {
    pdfControls?.invalidate();
    lastChange = Date.now();
    submit.disabled = true;
  };
  const resetWait = () => {
    lastPending = Date.now();
    markChanged();
  };
  const popupImages = () =>
    [...mapElement.querySelectorAll<HTMLImageElement>(".leaflet-popup-pane img[src]")].filter(
      (img) => {
        // Collapsed details deliberately defer their media until expanded.
        for (let parent = img.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open) return false;
        }
        return true;
      },
    );
  const popupChanged = (event: Event) => {
    if (event.target instanceof Element && event.target.closest(".leaflet-popup-pane")) resetWait();
  };
  map.on("popupopen popupclose", resetWait);
  for (const event of ["load", "error", "toggle", "scroll"])
    mapElement.addEventListener(event, popupChanged, true);
  const watchLayer = ({ layer }: { layer: any }) => {
    markChanged();
    if (!layer.on || watchedLayers.has(layer)) return;
    watchedLayers.add(layer);
    layer.on("loading load tileloadstart tileload tileerror", markChanged);
    layer.on("tileerror", tileError);
    layer.on("tileloadstart tileload", tileLoaded);
  };
  const tileError = ({ tile }: { tile: HTMLImageElement }) => {
    if (tile) failedTiles.add(tile);
  };
  const tileLoaded = ({ tile }: { tile: HTMLImageElement }) => {
    if (tile) failedTiles.delete(tile);
  };
  map.eachLayer((layer: any) => watchLayer({ layer }));
  map.on("layeradd", watchLayer);
  map.on("layerremove", markChanged);
  map.on("overlayadd overlayremove", resetWait);
  const moveStart = () => {
    moving = true;
    lastPending = Date.now();
    markChanged();
  };
  const moveEnd = () => {
    moving = false;
    markChanged();
  };
  map.on("movestart zoomstart", moveStart);
  map.on("moveend zoomend", moveEnd);

  const fitPaper = () => {
    if (disposed || printing) return;
    const scale = Math.max(
      0.1,
      Math.min(
        1,
        (viewport.clientWidth - 40) / paper.offsetWidth,
        (viewport.clientHeight - 40) / paper.offsetHeight,
      ),
    );
    paper.style.transform = `scale(${scale})`;
    space.style.width = `${paper.offsetWidth * scale}px`;
    space.style.height = `${paper.offsetHeight * scale}px`;
  };
  const updatePaper = () => {
    const chosen = PRINT_PAPERS[size.value as PrintPaper] ?? PRINT_PAPERS["a4-landscape"];
    paper.style.width = `${chosen.width}mm`;
    paper.style.height = `${chosen.height}mm`;
    pageStyle.textContent = `@page { size: ${chosen.page}; margin: 0; }`;
    title.textContent = titleInput.value.trim().slice(0, 40);
    document.title = title.textContent || "地図の印刷";
    const center = map.getCenter();
    map.invalidateSize({ pan: false, animate: false });
    map.setView(center, map.getZoom(), { animate: false });
    fitPaper();
    lastPending = Date.now();
    markChanged();
  };
  size.addEventListener("change", updatePaper);
  titleInput.addEventListener("input", updatePaper);
  element("print-settings").addEventListener("change", (event) => {
    // Title input already updates readiness on every keystroke. Its blur-time
    // change event must not restart the wait just as an output button is clicked.
    if (event.target !== titleInput) resetWait();
  });
  const resize = new ResizeObserver(fitPaper);
  resize.observe(viewport);
  updatePaper();

  const readiness = () => {
    let loading = moving;
    let failed = false;
    map.eachLayer((layer: any) => {
      if (layer.isLoading?.()) loading = true;
      const state = layer.getPrintStatus?.();
      if (state?.loading) loading = true;
      if (state?.failed) failed = true;
    });
    mapElement
      .querySelectorAll<HTMLImageElement>(
        "img.leaflet-tile, .leaflet-marker-pane img, .leaflet-shadow-pane img",
      )
      .forEach((img) => {
        if (!img.complete) loading = true;
        else if (img.naturalWidth === 0 || failedTiles.has(img)) failed = true;
      });
    for (const img of popupImages()) {
      if (!img.complete) loading = true;
      else if (img.naturalWidth === 0) failed = true;
    }
    return { loading, failed };
  };
  const refreshStatus = () => {
    if (disposed || printing) return;
    const { loading, failed } = readiness();
    const settling = Date.now() - lastChange < 700;
    const timedOut = loading && Date.now() - lastPending > 30000;
    if (!loading) lastPending = Date.now();
    // Missing coverage and image/network failures are indistinguishable here.
    // Allow the user to print the visible map instead of blocking indefinitely.
    submit.disabled = moving || (!timedOut && (loading || settling));
    submit.textContent = failed || timedOut ? "現在の表示で印刷" : "印刷";
    retry.hidden = !failed && !timedOut;
    status.textContent = timedOut
      ? "読み込みを完了できませんでした。再読み込みするか、現在の表示で印刷できます。"
      : loading || settling
        ? "地図を読み込んでいます…"
        : failed
          ? "地図画像の一部を表示できません。表示されている内容で印刷できます。必要に応じて再読み込みしてください。"
          : "印刷準備完了";
    pdfControls?.refresh();
  };
  const timer = window.setInterval(refreshStatus, 200);
  const resume = () => {
    printing = false;
    document.body.classList.remove("print-preparing");
    map.fire("printresume");
    fitPaper();
    markChanged();
  };
  const pause = () => {
    printing = true;
    document.body.classList.add("print-preparing");
    map.fire("printpause");
  };
  submit.addEventListener("click", () => {
    if (pdfControls?.busy()) return;
    refreshStatus();
    if (submit.disabled) return;
    pause();
    try {
      window.print();
    } catch {
      status.textContent = "印刷画面を開けませんでした。もう一度お試しください。";
    } finally {
      resume();
    }
  });
  pdfControls = createPdfControls({
    host: element("print-settings"),
    paper,
    getSettings: () => ({ paperId: size.value as PrintPaper, title: titleInput.value }),
    isReady: () => {
      const { loading, failed } = readiness();
      return !disposed && !printing && !loading && !failed && Date.now() - lastChange >= 700;
    },
    setBusy: (busy) => {
      if (busy) pause();
      else resume();
      // Inert blocks pointer and keyboard changes; cancel/save controls remain usable.
      viewport.inert = busy;
      for (const child of [...element("print-settings").children]) {
        if (child instanceof HTMLElement && !child.classList.contains("pdf-output"))
          child.inert = busy;
      }
      document.body.classList.toggle("pdf-preparing", busy);
    },
  });
  element("print-settings").addEventListener("input", () => pdfControls?.invalidate());
  element("print-settings").addEventListener("change", () => pdfControls?.invalidate());
  // Label/measurement buttons can change content without Leaflet layer events.
  element("print-extra").addEventListener("click", () => pdfControls?.invalidate());
  retry.addEventListener("click", () => {
    lastPending = Date.now();
    failedTiles = new WeakSet<HTMLImageElement>();
    map.eachLayer((layer: any) => (layer.retryPrint ? layer.retryPrint() : layer.redraw?.()));
    mapElement
      .querySelectorAll<HTMLImageElement>(".leaflet-marker-pane img, .leaflet-shadow-pane img")
      .forEach((img) => {
        if (img.complete && img.naturalWidth === 0) img.src = img.src;
      });
    for (const img of popupImages()) {
      if (img.complete && img.naturalWidth === 0) img.src = img.src;
    }
    markChanged();
    refreshStatus();
  });
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      !event.isComposing &&
      event.key.toLowerCase() === "p"
    ) {
      event.preventDefault();
      if (!event.repeat) submit.click();
    }
  };
  const parentOrigin = document.referrer
    ? new URL(document.referrer).origin
    : window.location.origin;
  const receivePrint = (event: MessageEvent) => {
    if (
      event.source === window.parent &&
      event.origin === parentOrigin &&
      event.data?.type === "printExecute"
    )
      submit.click();
  };
  window.addEventListener("message", receivePrint);
  window.addEventListener("keydown", keydown);
  window.addEventListener("beforeprint", pause);
  window.addEventListener("afterprint", resume);
  size.focus();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pdfControls?.dispose();
    document.body.classList.remove("pdf-preparing", "print-preparing");
    window.clearInterval(timer);
    resize.disconnect();
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("message", receivePrint);
    window.removeEventListener("beforeprint", pause);
    window.removeEventListener("afterprint", resume);
    map.off("popupopen popupclose", resetWait);
    for (const event of ["load", "error", "toggle", "scroll"])
      mapElement.removeEventListener(event, popupChanged, true);
    for (const layer of watchedLayers) {
      layer.off("loading load tileloadstart tileload tileerror", markChanged);
      layer.off("tileerror", tileError);
      layer.off("tileloadstart tileload", tileLoaded);
    }
    map.remove();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return { map, dispose };
}

export function initializePrintPreview() {
  const parentOrigin = document.referrer
    ? new URL(document.referrer).origin
    : window.location.origin;
  const send = (type: string) => window.parent.postMessage({ type }, parentOrigin);
  const receive = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.type !== "printInitialize"
    )
      return;
    if (!isPrintMapState(event.data.state)) return;
    window.removeEventListener("message", receive);
    try {
      createPrintPreview(event.data.state, () => send("printClose"));
      send("printInitialized");
    } catch {
      send("printError");
    }
  };
  window.addEventListener("message", receive);
  send("printReady");
}
