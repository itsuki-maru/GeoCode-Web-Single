import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
// @ts-expect-error Leafletのブラウザー実装には型定義が同梱されていない。
import L from "leaflet";
import type { TileServerRecord } from "../src/map/common/basemap-definition";

const require = createRequire(import.meta.url);

const record: TileServerRecord = {
  id: 2,
  kind: "vector",
  style_url: "/assets/background/style.json",
  url: "/tile/{z}/{x}/{y}.png",
  attribution: "Base attribution",
  label: "背景",
  layer_name: "background",
  include_foreign_tiles: false,
  min_zoom: null,
  max_zoom: null,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

let map: any;
let imported: ReturnType<typeof vi.fn<() => void>>;
let createInner: ReturnType<
  typeof vi.fn<
    (
      record: TileServerRecord,
      changed: () => void,
      attribution: (value: string) => void,
      fatal: () => void,
    ) => ReturnType<typeof makeInner>
  >
>;
let inner: ReturnType<typeof makeInner>;
let callbacks: { changed: () => void; attribution: (value: string) => void; fatal: () => void };

function makeInner() {
  const loading = deferred();
  const container = document.createElement("div");
  const InnerLayer = L.Layer.extend({
    onAdd(activeMap: any) {
      activeMap.getPane("tilePane").append(container);
    },
    onRemove() {
      container.remove();
    },
    getContainer: () => container,
  });
  return {
    layer: new InnerLayer(),
    ready: loading.promise,
    loading,
    container,
    status: vi.fn(() => ({ loading: true, failed: false })),
    retry: vi.fn(),
    dispose: vi.fn(() => loading.reject(new DOMException("aborted", "AbortError"))),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="map"></div>';
  map = L.map("map").setView([35, 139], 10);
  inner = makeInner();
  imported = vi.fn<() => void>();
  createInner = vi.fn((_record, changed, attribution, fatal) => {
    callbacks = { changed, attribution, fatal };
    return inner;
  });
  vi.doMock("../src/map/common/maplibre-basemap", () => {
    imported();
    return { createMaplibreBasemap: createInner };
  });
});

afterEach(() => {
  map?.remove();
  delete window.__GEOCODE_TILE_PROXY_REVISION__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock("../src/map/common/maplibre-basemap");
  document.body.replaceChildren();
});

describe("basemap renderer boundary", () => {
  it("keeps finite zoom limits after the final raster is removed so real clusters can rebuild", async () => {
    vi.stubGlobal("L", L);
    require("leaflet.markercluster");
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const raster = L.tileLayer("/raster/{z}/{x}/{y}.png", { minZoom: 5, maxZoom: 18 }).addTo(map);
    const cluster = L.markerClusterGroup().addTo(map);
    cluster.addLayer(L.marker([35, 139]));
    const vector = createBasemapLayer(L, map, record);
    vector.setVisible(false);
    vector.layer.addTo(map);
    await vi.dynamicImportSettled();
    inner.loading.resolve();
    await vector.ready;
    vector.setVisible(true);
    map.removeLayer(raster);
    // プラグインのInfinity--ループによるテスト停止を検出するため、clearLayersの前に検証する。
    expect(Number.isFinite(map.getMaxZoom())).toBe(true);
    expect(map.getMaxZoom()).toBe(18);
    const regenerate = vi.spyOn(cluster, "_generateInitialClusters");
    cluster.clearLayers();
    cluster.addLayer(L.marker([35, 139]));
    expect(regenerate).toHaveBeenCalledOnce();
    expect(cluster.getLayers()).toHaveLength(1);
    vector.dispose();
  });

  it("combines active vector and overlay limits while hidden candidates leave limits and view alone", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const raster = L.tileLayer("/raster/{z}/{x}/{y}.png", { minZoom: 5, maxZoom: 18 }).addTo(map);
    const center = map.getCenter();
    const zoom = map.getZoom();
    const vector = createBasemapLayer(L, map, { ...record, min_zoom: 3, max_zoom: 17 });
    vector.setVisible(false);
    vector.layer.addTo(map);
    await vi.dynamicImportSettled();
    expect(map.getMinZoom()).toBe(5);
    expect(map.getMaxZoom()).toBe(18);
    expect(map.getZoom()).toBe(zoom);
    expect(map.getCenter()).toEqual(center);
    const overlay = L.tileLayer("/overlay/{z}/{x}/{y}.png", { minZoom: 2, maxZoom: 22 }).addTo(map);
    inner.loading.resolve();
    await vector.ready;
    vector.setVisible(true);
    map.removeLayer(raster);
    expect(map.getMinZoom()).toBe(2);
    expect(map.getMaxZoom()).toBe(22);
    map.removeLayer(overlay);
    expect(map.getMinZoom()).toBe(3);
    expect(map.getMaxZoom()).toBe(17);
    raster.addTo(map);
    vector.setVisible(false);
    expect(map.getMinZoom()).toBe(5);
    expect(map.getMaxZoom()).toBe(18);
    vector.dispose();
  });

  it("keeps raster creation synchronous without importing the optional GL module", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const attribution =
      '<span class="source">Existing source</span><br><a href="https://example.test">Credit</a>';
    const handle = createBasemapLayer(L, map, {
      ...record,
      attribution,
      kind: "raster",
      style_url: null,
    });
    expect(handle.ready).toBeUndefined();
    expect(handle.layer.options.attribution).toBe(attribution);
    handle.layer.addTo(map);
    await vi.dynamicImportSettled();
    expect(imported).not.toHaveBeenCalled();
    expect(handle.layer.getTileUrl({ x: 0, y: 0, z: 10 })).toContain("/tile/");
    handle.dispose();
    handle.dispose();
    expect(map.hasLayer(handle.layer)).toBe(false);
  });

  it("uses the current revision to fetch an archived raster without editing its definition", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const revision = "018f6ff0-08eb-7da6-8727-6531bc7b4414";
    window.__GEOCODE_TILE_PROXY_REVISION__ = revision;
    const { kind: _kind, style_url: _style, ...legacy } = record;
    const archived = Object.freeze(legacy);
    const handle = createBasemapLayer(L, map, archived);
    handle.layer.addTo(map);
    expect(handle.layer.getTileUrl({ x: 0, y: 0, z: 10 })).toBe(`/tile/10/0/0.png?v=${revision}`);
    expect(archived.url).toBe("/tile/{z}/{x}/{y}.png");
    handle.dispose();
  });

  it("hides a vector candidate and its attribution until it becomes the active background", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const handle = createBasemapLayer(L, map, record);
    const ready = vi.fn();
    void handle.ready!.then(ready);
    handle.setVisible(false);
    handle.layer.addTo(map);
    await vi.dynamicImportSettled();
    expect(createInner).toHaveBeenCalledOnce();
    expect(inner.container.style.opacity).toBe("0");
    expect(map.attributionControl.getContainer().textContent).not.toContain("Base attribution");
    callbacks.attribution("Provider attribution");
    expect(map.attributionControl.getContainer().textContent).not.toContain("Provider attribution");
    expect(ready).not.toHaveBeenCalled();
    inner.loading.resolve();
    await handle.ready;
    expect(ready).toHaveBeenCalledOnce();
    handle.setVisible(true);
    expect(inner.container.style.opacity).toBe("1");
    expect(map.attributionControl.getContainer().textContent).toContain("Provider attribution");
    callbacks.attribution("Updated provider attribution");
    expect(map.attributionControl.getContainer().textContent).toContain(
      "Updated provider attribution",
    );
    const changed = vi.fn();
    handle.layer.on("load", changed);
    callbacks.changed();
    expect(changed).toHaveBeenCalledOnce();
    handle.dispose();
    expect(inner.dispose).toHaveBeenCalledOnce();
    expect(inner.container.isConnected).toBe(false);
    expect(map.attributionControl.getContainer().textContent).not.toContain(
      "Updated provider attribution",
    );
  });

  it("rejects a pre-aborted request before loading GL", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const abort = new AbortController();
    abort.abort();
    expect(() => createBasemapLayer(L, map, record, { signal: abort.signal })).toThrow(
      "背景の切替を中止しました",
    );
    expect(imported).not.toHaveBeenCalled();
  });

  it("does not construct or attach GL after cancellation during module loading", async () => {
    const moduleReady = deferred();
    vi.doMock("../src/map/common/maplibre-basemap", async () => {
      imported();
      await moduleReady.promise;
      return { createMaplibreBasemap: createInner };
    });
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const abort = new AbortController();
    const handle = createBasemapLayer(L, map, record, { signal: abort.signal });
    handle.layer.addTo(map);
    abort.abort();
    await expect(handle.ready).rejects.toMatchObject({ name: "AbortError" });
    moduleReady.resolve();
    await vi.dynamicImportSettled();
    expect(createInner).not.toHaveBeenCalled();
    expect(map.hasLayer(handle.layer)).toBe(false);
  });

  it("disposes attached GL once when a pending candidate is aborted", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const abort = new AbortController();
    const handle = createBasemapLayer(L, map, record, { signal: abort.signal });
    handle.layer.addTo(map);
    await vi.dynamicImportSettled();
    expect(inner.container.isConnected).toBe(true);
    abort.abort();
    handle.dispose();
    await expect(handle.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(inner.dispose).toHaveBeenCalledOnce();
    expect(inner.container.isConnected).toBe(false);
    expect(map.hasLayer(handle.layer)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["module", "constructor"])(
    "rejects a %s failure and permits safe cleanup",
    async (failure) => {
      if (failure === "module") {
        vi.doMock("../src/map/common/maplibre-basemap", () => {
          throw Error("module unavailable");
        });
      } else {
        createInner.mockImplementation(() => {
          throw Error("WebGL unavailable");
        });
      }
      const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
      const handle = createBasemapLayer(L, map, record);
      const failed = vi.fn();
      handle.layer.on("basemaperror", failed);
      handle.layer.addTo(map);
      await vi.dynamicImportSettled();
      await expect(handle.ready).rejects.toThrow("背景地図を読み込めませんでした");
      expect(failed).toHaveBeenCalledOnce();
      expect(handle.layer.getPrintStatus()).toMatchObject({ loading: false, failed: true });
      handle.dispose();
      expect(map.hasLayer(handle.layer)).toBe(false);
      expect(inner.container.isConnected).toBe(false);
    },
  );

  it("cleans up a partially attached GL layer when its constructor fails during addTo", async () => {
    inner.layer.onAdd = () => {
      throw Error("WebGL unavailable");
    };
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const handle = createBasemapLayer(L, map, record);
    handle.layer.addTo(map);
    await vi.dynamicImportSettled();
    await expect(handle.ready).rejects.toThrow("背景地図を読み込めませんでした");
    handle.dispose();
    expect(inner.dispose).toHaveBeenCalledOnce();
    expect(map.hasLayer(inner.layer)).toBe(false);
    expect(map.hasLayer(handle.layer)).toBe(false);
    expect(inner.container.isConnected).toBe(false);
  });

  it("bounds a stalled optional-module download before the GL constructor is available", async () => {
    const moduleReady = deferred();
    vi.doMock("../src/map/common/maplibre-basemap", async () => {
      await moduleReady.promise;
      return { createMaplibreBasemap: createInner };
    });
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const handle = createBasemapLayer(L, map, record);
    handle.layer.addTo(map);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(handle.ready).rejects.toThrow("背景地図を読み込めませんでした");
    expect(createInner).not.toHaveBeenCalled();
    moduleReady.resolve();
    await vi.dynamicImportSettled();
    expect(createInner).not.toHaveBeenCalled();
    handle.dispose();
    expect(map.hasLayer(handle.layer)).toBe(false);
  });

  it("times out an unfinished first frame and propagates an error after initial readiness", async () => {
    const { createBasemapLayer } = await import("../src/map/common/basemap-layer");
    const pending = createBasemapLayer(L, map, record);
    const timedOut = vi.fn();
    pending.layer.on("basemaperror", timedOut);
    pending.layer.addTo(map);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(29999);
    expect(timedOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending.ready).rejects.toThrow("背景地図を読み込めませんでした");
    expect(timedOut).toHaveBeenCalledOnce();
    pending.dispose();

    inner = makeInner();
    const active = createBasemapLayer(L, map, record);
    const activeError = vi.fn();
    active.layer.on("basemaperror", activeError);
    active.layer.addTo(map);
    await vi.dynamicImportSettled();
    inner.loading.resolve();
    await active.ready;
    callbacks.fatal();
    callbacks.fatal();
    expect(activeError).toHaveBeenCalledOnce();
    active.dispose();
  });
});
