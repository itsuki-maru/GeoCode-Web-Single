/// <reference types="vite/client" />
import { maplibreGL } from "./bridge-module.mjs";
import { setWorkerUrl, type Map as LibreMap } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

/** 試作用の描画処理。DB・初期データ・共有URL・本体の描画処理への変更は伴わない。 */
export function createPrototypeVectorBasemap(style: string, timeoutMs = 30000) {
  const layer = maplibreGL({
    style,
    interactive: false,
    attributionControl: false,
    padding: 0.1,
    fadeDuration: 0,
    localIdeographFontFamily: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  } as Parameters<typeof maplibreGL>[0]);
  // 0.1.4のonRemoveは初期化の成功を前提とする。Leafletは失敗したレイヤーも登録するため、
  // GL地図が存在しない場合は、その参照を避けてコンテナーを削除する。
  const remove = layer.onRemove;
  layer.onRemove = function (map: unknown) {
    if (!this.getMaplibreMap()) {
      this.getContainer()?.remove();
      return;
    }
    return remove.call(this, map);
  };
  layer.getAttribution = () => "GeoCode-Web 自作検証データ（MVT）";
  let gl: LibreMap | undefined;
  let failed = false;
  let disposed = false;
  let loaded = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 呼び出し側が`await ready`へ到達する前に、WebGLの初期化が失敗する場合がある。
  void ready.catch(() => {});
  const changed = () => layer.fire("loading");
  const onError = () => {
    failed = true;
    clearTimeout(timer);
    // 配信元URLにはアクセストークンが含まれる場合があるため、ログ出力を避ける。
    rejectReady(new Error("ベクタ背景の取得または描画に失敗しました。"));
    layer.fire("tileerror");
  };
  const onIdle = () => {
    if (disposed || failed) return;
    loaded = true;
    clearTimeout(timer);
    resolveReady();
    layer.fire("load");
  };
  const timer = window.setTimeout(onError, timeoutMs);
  layer.on("add", () => {
    gl = layer.getMaplibreMap();
    const canvas = gl!.getCanvas();
    canvas.dataset.geocodeMaplibreCanvas = "";
    gl!.on("error", onError);
    gl!.on("dataloading", changed);
    gl!.on("render", () => layer.fire("tileload"));
    gl!.on("idle", onIdle);
    canvas.addEventListener("webglcontextlost", onError);
    layer.getContainer().style.pointerEvents = "none";
  });
  layer.getPrintStatus = () => ({
    loading: !disposed && !failed && (!loaded || !gl?.loaded() || !gl?.areTilesLoaded()),
    failed,
  });
  layer.retryPrint = () => gl?.triggerRepaint();
  layer.on("remove", () => {
    disposed = true;
    clearTimeout(timer);
    if (!loaded && !failed) rejectReady(new Error("背景の切替を中止しました。"));
    gl = undefined;
  });
  return {
    layer,
    ready,
    getMap: () => gl,
    fail: onError,
  };
}
