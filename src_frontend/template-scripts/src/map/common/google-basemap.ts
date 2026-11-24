/// <reference types="vite/client" />
import googleMapsLogo from "./assets/google-maps-logo.png";
import type { TileServerRecord } from "./basemap-definition";
import type { BasemapHandle } from "./basemap-layer";
import { BASEMAP_TIMEOUT_MS } from "./map-timeouts";

type Grant = { grant: string; expiresAt: number; tileSize: number; routesEnabled?: boolean };

/** 同一originの印刷iframeからも閲覧権限を引き継ぐ。保存用スナップショットには含めない。 */
export function googleMapsAccess(): string | undefined {
  let source: Window = window;
  for (let depth = 0; depth < 8; depth++) {
    try {
      if (source.location.origin !== location.origin) return;
      const token = source.document.querySelector<HTMLMetaElement>(
        'meta[name="google-maps-access"]',
      )?.content;
      if (token) return token;
      if (source.parent === source) return;
      source = source.parent;
    } catch {
      return;
    }
  }
}

export function createGoogleBasemap(
  leaflet: any,
  map: any,
  record: TileServerRecord,
  signal?: AbortSignal,
): BasemapHandle {
  const abort = new AbortController();
  let disposed = false,
    failed = false,
    visible = true,
    attached = false;
  let copyright = "",
    viewportLoading = true,
    firstViewport = false,
    firstTiles = false;
  let viewportCurrent = false;
  let generation = 0,
    grant: Grant | undefined,
    granting: Promise<Grant> | undefined;
  let viewportAbort: AbortController | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const objectUrls = new Map<HTMLImageElement, string>();
  const tileRequests = new Map<HTMLImageElement, AbortController>();
  const error = () =>
    Error("Google背景地図を読み込めませんでした。設定と利用上限を確認してください。");
  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    clearTimeout(timer);
    rejectReady(error());
    layer.fire("basemaperror", { error: error() });
  };
  const complete = () => {
    if (disposed || failed || !firstViewport || !firstTiles) return;
    clearTimeout(timer);
    resolveReady();
  };
  const getGrant = async (): Promise<Grant> => {
    if (grant && grant.expiresAt > Date.now() / 1000 + 60) return grant;
    if (!granting)
      granting = (async () => {
        const response = await fetch("/google-maps/context", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backgroundId: record.id, access: googleMapsAccess() }),
        });
        if (!response.ok) throw error();
        const value: Grant = await response.json();
        if (
          typeof value.grant !== "string" ||
          !value.grant ||
          !Number.isFinite(value.expiresAt) ||
          value.expiresAt <= Date.now() / 1000 ||
          value.tileSize !== 256
        )
          throw error();
        const routesChanged = Boolean(grant?.routesEnabled) !== (value.routesEnabled === true);
        grant = value;
        if (routesChanged && attached && !disposed) map.fire("googleroutesavailabilitychange");
        return value;
      })().finally(() => {
        granting = undefined;
      });
    return granting;
  };
  const authorizedFetch = async (url: string, requestSignal: AbortSignal) => {
    const value = await getGrant();
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: requestSignal,
      headers: { Authorization: `Bearer ${value.grant}` },
    });
    if (!response.ok) throw error();
    return response;
  };
  const attribution = () => {
    const text = document.createElement("span");
    text.textContent = copyright;
    // 公式アセットを縦横比を保って表示し、Leafletの帰属とは独立させる。
    return visible && firstViewport
      ? `<span class="google-maps-attribution" style="display:inline-block;padding:10px 10px 5px;white-space:nowrap"><img src="${googleMapsLogo}" alt="Google Maps" style="height:18px;width:auto;vertical-align:middle" /></span>${text.innerHTML}`
      : "";
  };
  const changeCopyright = (next: string) => {
    const before = attribution();
    copyright = next;
    firstViewport = true;
    if (attached && visible) {
      if (before) map.attributionControl?.removeAttribution(before);
      map.attributionControl?.addAttribution(attribution());
    }
  };
  const updateViewport = async () => {
    if (disposed || failed) return;
    const requestGeneration = ++generation;
    viewportCurrent = false;
    viewportAbort?.abort();
    viewportAbort = new AbortController();
    const requestSignal = viewportAbort.signal;
    viewportLoading = true;
    const bounds = map.getBounds();
    // LeafletのworldCopyJumpや日付変更線を正規化する。
    const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
    const fullWorld = bounds.getEast() - bounds.getWest() >= 360;
    const params = new URLSearchParams({
      zoom: String(Math.min(22, Math.max(0, Math.round(map.getZoom())))),
      north: String(Math.min(90, bounds.getNorth())),
      south: String(Math.max(-90, bounds.getSouth())),
      east: String(fullWorld ? 180 : wrap(bounds.getEast())),
      west: String(fullWorld ? -180 : wrap(bounds.getWest())),
    });
    try {
      const response = await authorizedFetch(`/google-maps/viewport?${params}`, requestSignal);
      const value = await response.json();
      if (disposed || requestGeneration !== generation) return;
      if (typeof value.copyright !== "string" || !value.copyright.trim()) throw error();
      const covers = (rect: any) =>
        Number.isInteger(rect.maxZoom) &&
        rect.maxZoom >= 0 &&
        rect.maxZoom <= 22 &&
        rect.north >= Number(params.get("north")) &&
        rect.south <= Number(params.get("south")) &&
        Number(params.get("west")) <= Number(params.get("east")) &&
        rect.west <= Number(params.get("west")) &&
        rect.east >= Number(params.get("east"));
      if (!Array.isArray(value.maxZoomRects)) throw error();
      const available = value.maxZoomRects.filter(covers).map((rect: any) => rect.maxZoom);
      // 日付変更線・広域ではworld全体を覆う矩形も利用できる。
      const world = value.maxZoomRects
        .filter(
          (rect: any) =>
            rect.west === -180 &&
            rect.east === 180 &&
            rect.north >= bounds.getNorth() &&
            rect.south <= bounds.getSouth() &&
            Number.isInteger(rect.maxZoom) &&
            rect.maxZoom >= 0 &&
            rect.maxZoom <= 22,
        )
        .map((rect: any) => rect.maxZoom);
      if (!available.length && !world.length) throw error();
      grid.options.maxNativeZoom = Math.max(...available, ...world);
      changeCopyright(value.copyright);
      viewportLoading = false;
      viewportCurrent = true;
      if (!map.hasLayer(grid)) grid.addTo(map);
      else grid._resetView(); // Leaflet 1.9.4: native zoomを反映して低ズーム画像を拡大表示する。
      syncVisible();
      complete();
      layer.fire("load");
    } catch {
      if (!requestSignal.aborted && !disposed) fail();
    }
  };
  const GoogleGrid = leaflet.GridLayer.extend({
    _update(...args: unknown[]) {
      if (viewportCurrent) return leaflet.GridLayer.prototype._update.apply(this, args);
    },
    createTile(
      coords: { x: number; y: number; z: number },
      done: (error: Error | null, tile: HTMLImageElement) => void,
    ) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      const request = new AbortController();
      tileRequests.set(img, request);
      const onAbort = () => request.abort();
      abort.signal.addEventListener("abort", onAbort, { once: true });
      void (async () => {
        try {
          const response = await authorizedFetch(
            `/google-maps/tiles/${coords.z}/${coords.x}/${coords.y}`,
            request.signal,
          );
          const blob = await response.blob();
          if (request.signal.aborted || disposed) return;
          const url = URL.createObjectURL(blob);
          objectUrls.set(img, url);
          img.onload = () => {
            img.onload = img.onerror = null;
            done(null, img);
          };
          img.onerror = () => {
            done(error(), img);
            fail();
          };
          img.src = url;
        } catch {
          if (!request.signal.aborted && !disposed) {
            done(error(), img);
            fail();
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort);
        }
      })();
      return img;
    },
  });
  const grid = new GoogleGrid({
    tileSize: 256,
    minZoom: record.min_zoom ?? 5,
    maxZoom: record.max_zoom ?? 18,
    updateWhenIdle: true,
    keepBuffer: 1,
  });
  const staleViewport = () => {
    viewportCurrent = false;
    viewportLoading = true;
  };
  const syncVisible = () => {
    const container = grid.getContainer?.();
    if (container) container.style.opacity = visible ? "1" : "0";
  };
  const GoogleLayer = leaflet.Layer.extend({
    onAdd() {
      attached = true;
      map.on("movestart", staleViewport);
      map.on("moveend", updateViewport);
      void updateViewport();
    },
    onRemove() {
      attached = false;
      dispose();
    },
    getAttribution: attribution,
    getContainer: () => grid.getContainer?.(),
    getGoogleRoutesBackground: () =>
      visible && attached && !disposed && !failed && grant?.routesEnabled === true
        ? { id: record.id, minZoom: grid.options.minZoom, maxZoom: grid.options.maxZoom }
        : undefined,
    getPrintStatus: () => ({
      loading: !disposed && !failed && (viewportLoading || !firstTiles || grid.isLoading()),
      failed,
    }),
    retryPrint: () => {
      void updateViewport();
    },
  });
  const layer = new GoogleLayer();
  const timer = window.setTimeout(fail, BASEMAP_TIMEOUT_MS);
  grid.on("add", syncVisible);
  grid.on("load", () => {
    firstTiles = true;
    complete();
    layer.fire("load");
  });
  grid.on("tileunload", ({ tile }: { tile: HTMLImageElement }) => {
    tileRequests.get(tile)?.abort();
    tileRequests.delete(tile);
    const url = objectUrls.get(tile);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(tile);
  });
  const dispose = () => {
    if (disposed) return;
    const removeLayer = attached;
    disposed = true;
    attached = false;
    clearTimeout(timer);
    abort.abort();
    viewportAbort?.abort();
    map.off("movestart", staleViewport);
    map.off("moveend", updateViewport);
    signal?.removeEventListener("abort", dispose);
    tileRequests.forEach((request) => request.abort());
    tileRequests.clear();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    rejectReady(new DOMException("背景の切替を中止しました。", "AbortError"));
    if (map.hasLayer?.(grid)) map.removeLayer(grid);
    if (removeLayer && map.hasLayer?.(layer)) map.removeLayer(layer);
    // 外側のremoveイベントはLeafletの出典解除にも使うため、onRemove内で消さない。
    grid.off();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return {
    layer,
    ready,
    dispose,
    setVisible(next: boolean) {
      const before = attribution();
      visible = next;
      syncVisible();
      if (attached) {
        if (before) map.attributionControl?.removeAttribution(before);
        const after = attribution();
        if (after) map.attributionControl?.addAttribution(after);
      }
    },
  };
}
