/// <reference types="vite/client" />
import css from "./print-preview.css?inline";
import { createPdfControls } from "./pdf-controls";
import { MAPLIBRE_CANVAS_SELECTOR, prepareMaplibreCanvasPrint } from "./canvas-snapshot";
import { initializeReadOnlyMapPage } from "../read-only-page";
import { createLayerBulkToggleControl } from "../common/base";
import { installAnswerColoring, type AnswerColoring } from "../answer-coloring";
import { createAnswerPrintLegend } from "./answer-print-legend";
import { readMapBootstrap } from "../bootstrap";
import { getBasemapController } from "../common/basemap-controller";
import type { AnotherMapBootstrap, TemporaryMapBootstrap } from "../types";
import type { ReadOnlyPrintSnapshot } from "./read-only-print-snapshot";
import {
  isPrintMapState,
  PRINT_PAPERS,
  type PrintMapState,
  type PrintPaper,
} from "../common/print-state";

export function movePrintMapControls(mapElement: HTMLElement, settings: HTMLElement) {
  mapElement.querySelectorAll<HTMLElement>(".leaflet-control").forEach((control) => {
    if (
      !control.matches(
        ".leaflet-control-zoom, .leaflet-control-attribution, .nowcast-status, .measurement-selection-summary",
      )
    ) {
      settings.append(control);
    }
  });
}

// このページで用紙上の操作と印刷の両方を扱い、印刷用の表示へ切り替えても、
// 地図の CSS ピクセル単位の寸法を維持する。
export function createPrintPreview(
  state: PrintMapState,
  close: () => void,
  page: "map-anather" | "form-answer-map" | "temporary-map" = "map-anather",
  session?: { parentOrigin: string; requestId: string },
  coloring?: AnswerColoring,
  snapshotBootstrap?: AnotherMapBootstrap | TemporaryMapBootstrap,
) {
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
  const runtime = initializeReadOnlyMapPage(page, state, snapshotBootstrap);
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
  movePrintMapControls(mapElement, element("print-extra"));

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
  let canvasPrintController: AbortController | undefined;
  let restoreCanvasPrint: (() => void) | undefined;
  let canvasPrintInteraction: { element: HTMLElement; inert: boolean }[] = [];
  let moving = false;
  let pdfControls: ReturnType<typeof createPdfControls> | undefined;
  let lastChange = Date.now();
  let lastPending = Date.now();
  let printRevision = 0;
  let failedTiles = new WeakSet<HTMLImageElement>();
  const watchedLayers = new Set<any>();
  const markChanged = () => {
    pdfControls?.invalidate();
    lastChange = Date.now();
    submit.disabled = true;
    pdfControls?.refresh();
  };
  const markPrintChanged = () => {
    printRevision++;
    markChanged();
  };
  const resetWait = () => {
    lastPending = Date.now();
    markPrintChanged();
  };
  const colorController =
    coloring || state.coloring ? installAnswerColoring(runtime, (window as any).L) : undefined;
  const printColoring = coloring || state.coloring;
  runtime.setColoringController?.(colorController);
  colorController?.apply(printColoring!);
  const bootstrap = colorController ? (snapshotBootstrap ?? readMapBootstrap()) : undefined;
  const legendRecords =
    bootstrap &&
    (snapshotBootstrap || bootstrap.page === "map-anather" || bootstrap.page === "form-answer-map")
      ? {
          markers: bootstrap.markers,
          shapes: Array.isArray(bootstrap.shapes)
            ? bootstrap.shapes
            : Object.values(bootstrap.shapes),
        }
      : undefined;
  const legend =
    colorController && printColoring && legendRecords
      ? createAnswerPrintLegend({
          coloring: printColoring,
          bootstrap: legendRecords,
          getAvailableTargetKeys: () =>
            new Set([
              ...Object.values(legendRecords.markers).map((m) => `marker:${m.id}`),
              ...legendRecords.shapes.map((s) => `shape:${s.id}`),
            ]),
          subscribe:
            !snapshotBootstrap && bootstrap?.page === "map-anather"
              ? (refresh) => {
                  map.on("objectloadingchange", refresh);
                  return () => map.off("objectloadingchange", refresh);
                }
              : undefined,
          mapElement,
          settings: element("print-settings"),
          setHiddenTargets: (keys) => runtime.setLegendHiddenTargets(keys),
          onChange: resetWait,
        })
      : undefined;
  map.on("measurementselectionchange measurementlabelmove", resetWait);
  map.on("objectloadingchange", resetWait);
  map.on("basemaploadingchange", resetWait);
  const popupImages = () =>
    [...mapElement.querySelectorAll<HTMLImageElement>(".leaflet-popup-pane img[src]")].filter(
      (img) => {
        // 折り畳まれた詳細内のメディアは、展開するまで意図的に読み込みを遅らせる。
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
  for (const event of ["load", "error", "toggle", "scroll", "change"])
    mapElement.addEventListener(event, popupChanged, true);
  const watchLayer = ({ layer }: { layer: any }) => {
    markPrintChanged();
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
  const stopWatchingLayer = (layer: any) => {
    if (!watchedLayers.delete(layer)) return;
    layer.off("loading load tileloadstart tileload tileerror", markChanged);
    layer.off("tileerror", tileError);
    layer.off("tileloadstart tileload", tileLoaded);
  };
  const unwatchLayer = ({ layer }: { layer: any }) => {
    stopWatchingLayer(layer);
    markPrintChanged();
  };
  map.eachLayer((layer: any) => watchLayer({ layer }));
  map.on("layeradd", watchLayer);
  map.on("layerremove", unwatchLayer);
  map.on("overlayadd overlayremove", resetWait);
  const moveStart = () => {
    moving = true;
    lastPending = Date.now();
    markPrintChanged();
  };
  const moveEnd = () => {
    moving = false;
    markPrintChanged();
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
    markPrintChanged();
  };
  size.addEventListener("change", updatePaper);
  titleInput.addEventListener("input", updatePaper);
  element("print-settings").addEventListener("change", (event) => {
    // タイトル入力のたびに出力可否を更新しているため、フォーカスが外れた際の
    // change イベントで、出力ボタンを押した直後の待機をやり直さない。
    if (event.target !== titleInput) resetWait();
  });
  const resize = new ResizeObserver(fitPaper);
  resize.observe(viewport);
  updatePaper();

  const readiness = () => {
    const objects = runtime.getObjectLoadStatus?.() ?? { loading: false, failed: false };
    const basemap = getBasemapController(map);
    const basemapPending = basemap?.isPending() ?? false;
    const basemapStatus = basemap?.getLayer()?.getPrintStatus?.();
    let loading = moving || objects.loading || basemapPending || Boolean(basemapStatus?.loading);
    let failed = objects.failed || Boolean(basemapStatus?.failed);
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
    return { loading, failed, objects, basemapPending };
  };
  const refreshStatus = () => {
    if (disposed || printing) return;
    const { loading, failed, objects, basemapPending } = readiness();
    const legendOverflow = legend?.hasOverflow() ?? false;
    const settling = Date.now() - lastChange < 700;
    const timedOut = loading && Date.now() - lastPending > 30000;
    if (!loading) lastPending = Date.now();
    // この処理では、提供範囲外のタイルと画像取得・通信の失敗を区別できない。
    // 無期限に待機せず、現在表示できている地図を印刷できるようにする。
    submit.disabled =
      legendOverflow ||
      objects.loading ||
      objects.failed ||
      basemapPending ||
      moving ||
      (!timedOut && (loading || settling));
    submit.textContent =
      !objects.loading && !objects.failed && (failed || timedOut) ? "現在の表示で印刷" : "印刷";
    retry.hidden = !failed && !timedOut;
    status.textContent = legendOverflow
      ? "凡例が枠に収まりません。枠を広げるか、文字を小さくするか、分類を減らしてください。"
      : objects.failed
        ? "選択したグループのデータを取得できませんでした。再読み込みで再試行するか、該当グループのチェックを外してください。"
        : objects.loading
          ? "選択したグループのデータを読み込んでいます…"
          : basemapPending
            ? "背景地図を切り替えています…"
            : timedOut
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
    if (disposed) return;
    restoreCanvasPrint?.();
    restoreCanvasPrint = undefined;
    for (const { element, inert } of canvasPrintInteraction) element.inert = inert;
    canvasPrintInteraction = [];
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
  submit.addEventListener("click", async () => {
    if (pdfControls?.busy() || canvasPrintController) return;
    refreshStatus();
    if (submit.disabled) return;
    pause();
    try {
      if (mapElement.querySelector(MAPLIBRE_CANVAS_SELECTOR)) {
        const revision = printRevision;
        const capturedLayer = getBasemapController(map)?.getLayer();
        canvasPrintInteraction = [viewport, element("print-settings")].map((element) => ({
          element,
          inert: element.inert,
        }));
        for (const { element } of canvasPrintInteraction) element.inert = true;
        canvasPrintController = new AbortController();
        restoreCanvasPrint = await prepareMaplibreCanvasPrint(
          mapElement,
          canvasPrintController.signal,
        );
        if (disposed) {
          restoreCanvasPrint();
          restoreCanvasPrint = undefined;
          return;
        }
        // 画像のデコード待ちの間にも、背景の失敗・代替表示やスクリプトによる表示変更が起こり得る。
        // MapLibreのidle/load通知だけでは、取得した表示状態を無効にしない。
        const basemap = getBasemapController(map);
        if (
          revision !== printRevision ||
          capturedLayer !== basemap?.getLayer() ||
          basemap?.isPending()
        ) {
          status.textContent =
            "画像の準備中に地図が変更されました。表示を確認してもう一度印刷してください。";
          return;
        }
      }
      window.print();
    } catch {
      if (!disposed) status.textContent = "印刷画面を開けませんでした。もう一度お試しください。";
    } finally {
      canvasPrintController = undefined;
      if (!disposed) resume();
    }
  });
  pdfControls = createPdfControls({
    host: element("print-settings"),
    paper,
    getSettings: () => ({ paperId: size.value as PrintPaper, title: titleInput.value }),
    isReady: () => {
      const { loading, failed } = readiness();
      return (
        !disposed &&
        !printing &&
        !loading &&
        !failed &&
        !legend?.hasOverflow() &&
        Date.now() - lastChange >= 700
      );
    },
    setBusy: (busy) => {
      if (busy) pause();
      else resume();
      // inert でポインターやキーボードによる変更を防ぎ、取消・保存の操作は可能にしておく。
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
  // ラベルや計測のボタンでは、Leaflet のレイヤイベントが発生せずに表示内容が変わる場合がある。
  element("print-extra").addEventListener("click", () => pdfControls?.invalidate());
  retry.addEventListener("click", () => {
    void runtime.retryObjectLoads?.();
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
    markPrintChanged();
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
  const parentOrigin =
    session?.parentOrigin ||
    (document.referrer ? new URL(document.referrer).origin : window.location.origin);
  const receivePrint = (event: MessageEvent) => {
    if (
      event.source === window.parent &&
      event.origin === parentOrigin &&
      event.data?.type === "printExecute" &&
      (!session || event.data.requestId === session.requestId)
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
    canvasPrintController?.abort();
    restoreCanvasPrint?.();
    for (const { element, inert } of canvasPrintInteraction) element.inert = inert;
    canvasPrintInteraction = [];
    legend?.dispose();
    colorController?.dispose();
    pdfControls?.dispose();
    document.body.classList.remove("pdf-preparing", "print-preparing");
    window.clearInterval(timer);
    resize.disconnect();
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("message", receivePrint);
    window.removeEventListener("beforeprint", pause);
    window.removeEventListener("afterprint", resume);
    map.off("popupopen popupclose", resetWait);
    map.off("measurementselectionchange measurementlabelmove", resetWait);
    map.off("objectloadingchange", resetWait);
    map.off("basemaploadingchange", resetWait);
    map.off("layeradd", watchLayer);
    map.off("layerremove", unwatchLayer);
    map.off("overlayadd overlayremove", resetWait);
    map.off("movestart zoomstart", moveStart);
    map.off("moveend zoomend", moveEnd);
    for (const event of ["load", "error", "toggle", "scroll", "change"])
      mapElement.removeEventListener(event, popupChanged, true);
    for (const layer of [...watchedLayers]) stopWatchingLayer(layer);
    map.remove();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return { map, dispose };
}

/** 全画面・共有地図の印刷は、受信済みの対象だけから別の地図を組み立てる。 */
export function createReadOnlySnapshotPrintPreview(
  snapshot: ReadOnlyPrintSnapshot,
  close: () => void,
  session: { parentOrigin: string; requestId: string },
) {
  const { state, layers, markers, shapes, tileServers, tileOverlays } = snapshot;
  const base = { initialView: state.view, layers, markers, tileServers, tileOverlays };
  const bootstrap: AnotherMapBootstrap | TemporaryMapBootstrap =
    snapshot.sourcePage === "map-anather"
      ? { ...base, page: "map-anather", shapes, isCluster: state.clusteringAllowed !== false }
      : {
          ...base,
          page: "temporary-map",
          shapes: Object.fromEntries(shapes.map((shape) => [shape.id, shape])),
          isMaster: false,
          isChecked: false,
          isMapUiHidden: false,
          shareSnapshot: snapshot.snapshotShare
            ? { version: snapshot.version, state, tileServers, tileOverlays }
            : null,
        };
  return createPrintPreview(state, close, snapshot.sourcePage, session, undefined, bootstrap);
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
