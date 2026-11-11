import { normalizeBasemapDefinition, type TileServerRecord } from "./basemap-definition";
import { formatTileAttribution } from "./tile-attribution";
import { BASEMAP_TIMEOUT_MS } from "./map-timeouts";
import { tileProxyRenderUrl } from "./tile-proxy-url";

export interface BasemapHandle {
  layer: any;
  ready?: Promise<void>;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createBasemapLayer(
  leaflet: any,
  map: any,
  record: TileServerRecord,
  { signal }: { signal?: AbortSignal } = {},
): BasemapHandle {
  const definition = normalizeBasemapDefinition(record);
  if (!definition) throw new Error("背景地図の設定が不正です。");
  if (signal?.aborted) throw new DOMException("背景の切替を中止しました。", "AbortError");
  if (definition.kind === "raster") {
    const layer = leaflet.tileLayer(tileProxyRenderUrl(record.url), {
      attribution: record.attribution,
      minZoom: record.min_zoom ?? 5,
      maxZoom: record.max_zoom ?? 18,
    });
    let disposed = false;
    return {
      layer,
      // ラスタのtileerrorは配信範囲外も表すため、従来の地図の部分表示を維持する。
      setVisible: (visible) => {
        if (layer.getContainer?.()) layer.getContainer().style.opacity = visible ? "1" : "0";
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (map.hasLayer?.(layer)) map.removeLayer(layer);
        layer.off?.();
      },
    };
  }

  let visible = true;
  let attached = false;
  let disposed = false;
  let failed = false;
  let zoomLimitRegistered = false;
  let timer: number | undefined;
  let attribution = formatTileAttribution(record.attribution);
  let inner: ReturnType<typeof import("./maplibre-basemap").createMaplibreBasemap> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const currentAttribution = () => (visible ? attribution : "");
  const syncZoomLimit = () => {
    const register = attached && visible && !disposed;
    if (register === zoomLimitRegistered) return;
    zoomLimitRegistered = register;
    // Leaflet 1.9.4のGridLayerは、この登録情報で背景と重ね合わせのズーム制限を統合する。
    // 通常のブリッジLayerだけでは、ラスタ除去後にgetMaxZoom()がInfinityになり、
    // MarkerClusterも有限のズーム階層を再構築できなくなる。
    if (register) map._addZoomLimit?.(layer);
    else map._removeZoomLimit?.(layer);
  };
  const updateAttribution = (next: string) => {
    const before = currentAttribution();
    attribution = next;
    if (attached && visible && before !== attribution) {
      map.attributionControl?.removeAttribution(before);
      map.attributionControl?.addAttribution(attribution);
    }
  };
  const changed = () => layer.fire("load");
  const fatal = () => {
    if (disposed || failed) return;
    failed = true;
    clearTimeout(timer);
    rejectReady(new Error("背景地図を読み込めませんでした。"));
    layer.fire("basemaperror");
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    inner?.dispose();
    if (inner && map.hasLayer?.(inner.layer)) map.removeLayer(inner.layer);
    rejectReady(new DOMException("背景の切替を中止しました。", "AbortError"));
  };
  const load = async () => {
    try {
      const { createMaplibreBasemap } = await import("./maplibre-basemap");
      if (disposed || failed || signal?.aborted) return;
      inner = createMaplibreBasemap(record, changed, updateAttribution, fatal);
      // 内側のレイヤーの初回描画前に非表示へ設定し、それまでの背景を表示し続ける。
      inner.layer.on("add", () => {
        inner!.layer.getContainer().style.opacity = visible ? "1" : "0";
      });
      inner.layer.addTo(map);
      await inner.ready;
      if (!disposed && !failed && !signal?.aborted) {
        clearTimeout(timer);
        resolveReady();
      }
    } catch {
      if (!disposed) fatal();
    }
  };
  const VectorLayer = leaflet.Layer.extend({
    options: { minZoom: record.min_zoom ?? 5, maxZoom: record.max_zoom ?? 18 },
    onAdd() {
      attached = true;
      syncZoomLimit();
      timer = window.setTimeout(fatal, BASEMAP_TIMEOUT_MS);
      void load();
    },
    onRemove() {
      attached = false;
      syncZoomLimit();
      cleanup();
    },
    getAttribution: currentAttribution,
    getPrintStatus: () => {
      const status = inner?.status();
      return {
        loading: !disposed && !failed && (status?.loading ?? true),
        failed: failed || (status?.failed ?? false),
      };
    },
    retryPrint: () => inner?.retry(),
  });
  const layer = new VectorLayer();
  const abort = () => {
    if (map.hasLayer?.(layer)) map.removeLayer(layer);
    cleanup();
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    layer,
    ready,
    setVisible(next) {
      const before = currentAttribution();
      visible = next;
      syncZoomLimit();
      if (inner?.layer.getContainer()) inner.layer.getContainer().style.opacity = next ? "1" : "0";
      const after = currentAttribution();
      if (attached && before !== after) {
        if (before) map.attributionControl?.removeAttribution(before);
        if (after) map.attributionControl?.addAttribution(after);
      }
    },
    dispose: abort,
  };
}
