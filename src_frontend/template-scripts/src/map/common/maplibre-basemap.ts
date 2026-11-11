/// <reference types="vite/client" />
import { maplibreGL } from "./maplibre-bridge.mjs";
import { setWorkerUrl, type Map as LibreMap } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { formatTileAttribution } from "./tile-attribution";
import type { TileServerRecord } from "./basemap-definition";
import { BASEMAP_TIMEOUT_MS } from "./map-timeouts";

setWorkerUrl(workerUrl);

/** このモジュールと付属のCSS・Workerは、ベクタ背景を使用するときだけ読み込む。 */
export function createMaplibreBasemap(
  record: TileServerRecord,
  onChange: () => void,
  onAttribution: (attribution: string) => void,
  onFatal: () => void,
) {
  const layer = maplibreGL({
    style: record.style_url!,
    interactive: false,
    attributionControl: false,
    padding: 0.1,
    fadeDuration: 0,
    // 印刷でも同じコンテキストを使用するため、非表示の別のWebGL地図を生成する必要がない。
    canvasContextAttributes: { preserveDrawingBuffer: true },
  } as Parameters<typeof maplibreGL>[0]);
  const originalRemove = layer.onRemove;
  layer.onRemove = function (map: unknown) {
    // ブリッジ0.1.4は、WebGLのコンストラクターが失敗した後も_glMapを参照する。
    if (!this.getMaplibreMap()) return this.getContainer()?.remove();
    return originalRemove.call(this, map);
  };
  let gl: LibreMap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let loaded = false;
  let failed = false;
  let disposed = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let timer: number | undefined;
  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    clearTimeout(timer);
    // クエリにトークンを含む場合があるため、配信元のエラーやURLを通知へ渡さない。
    rejectReady(new Error("背景地図を読み込めませんでした。"));
    onChange();
    onFatal();
  };
  const idle = () => {
    if (disposed || failed || !gl) return;
    loaded = true;
    clearTimeout(timer);
    const attributions = [record.attribution];
    for (const id of Object.keys(gl.getStyle().sources ?? {})) {
      const source = gl.getSource(id) as { attribution?: string } | undefined;
      if (typeof source?.attribution === "string") attributions.push(source.attribution);
    }
    onAttribution(formatTileAttribution([...new Set(attributions)].join(" · ")));
    resolveReady();
    onChange();
  };
  const loading = () => onChange();
  layer.on("add", () => {
    gl = layer.getMaplibreMap();
    canvas = gl!.getCanvas();
    canvas.dataset.geocodeMaplibreCanvas = "";
    canvas.addEventListener("webglcontextlost", fail);
    layer.getContainer().style.pointerEvents = "none";
    gl!.on("error", fail);
    gl!.on("dataloading", loading);
    gl!.on("idle", idle);
    timer = window.setTimeout(fail, BASEMAP_TIMEOUT_MS);
  });
  const status = () => ({
    loading: !disposed && !failed && (!loaded || !gl?.loaded() || !gl?.areTilesLoaded()),
    failed,
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    canvas?.removeEventListener("webglcontextlost", fail);
    gl?.off("error", fail);
    gl?.off("dataloading", loading);
    gl?.off("idle", idle);
    rejectReady(new DOMException("背景の切替を中止しました。", "AbortError"));
  };
  layer.on("remove", dispose);
  return { layer, ready, status, dispose, retry: () => gl?.triggerRepaint() };
}
