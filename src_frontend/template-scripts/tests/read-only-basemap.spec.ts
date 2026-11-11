import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import { initializeReadOnlyMapPage } from "../src/map/read-only-page";
import type { AnotherMapBootstrap, TemporaryMapBootstrap } from "../src/map/types";

const layers = vi.hoisted(() => ({
  vectors: [] as {
    layer: any;
    styleUrl: string;
    resolve(): void;
    reject(error: Error): void;
    dispose: () => void;
  }[],
}));
vi.mock("../src/map/common/basemap-layer", () => ({
  createBasemapLayer(leaflet: any, _map: any, record: any) {
    if (record.kind !== "vector")
      return {
        layer: leaflet.tileLayer(record.url, { attribution: record.attribution }),
        setVisible: () => {},
        dispose: () => {},
      };
    const layer = leaflet.layerGroup();
    let loading = true;
    layer.getPrintStatus = () => ({ loading, failed: false });
    const dispose = vi.fn();
    const ready = new Promise<void>((resolve, reject) => {
      layers.vectors.push({
        layer,
        styleUrl: record.style_url,
        resolve: () => {
          loading = false;
          resolve();
        },
        reject,
        dispose,
      });
    });
    return { layer, ready, setVisible: () => {}, dispose };
  },
}));

Object.assign(SVGSVGElement.prototype, { createSVGRect: () => ({}) });
const require = createRequire(import.meta.url);
const leaflet = require("leaflet");
let runtime: ReturnType<typeof initializeReadOnlyMapPage> | undefined;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fixture(): AnotherMapBootstrap {
  return {
    page: "map-anather",
    isCluster: false,
    initialView: { latitude: 35, longitude: 139, zoom: 10 },
    layers: {},
    markers: {},
    shapes: [],
    tileOverlays: [],
    tileServers: {
      "1": {
        id: 1,
        layer_name: "raster",
        label: "従来背景",
        url: "/tile/{z}/{x}/{y}.png",
        attribution: "raster",
        include_foreign_tiles: true,
        min_zoom: 0,
        max_zoom: 22,
      },
      "2": {
        id: 2,
        layer_name: "vector",
        label: "ベクタ背景",
        kind: "vector",
        style_url: "/assets/styles/vector.json",
        url: "/fallback/{z}/{x}/{y}.png",
        attribution: "vector",
        include_foreign_tiles: true,
        min_zoom: 0,
        max_zoom: 22,
      },
    },
  };
}

beforeEach(() => {
  layers.vectors.length = 0;
  localStorage.clear();
  document.body.innerHTML = '<div id="map"></div>';
  Object.assign(window, { L: leaflet, marked: new Marked(), filterXSS: (value: string) => value });
  vi.stubGlobal("L", leaflet);
  require("leaflet.markercluster");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value() {
        this.removeAttribute("open");
      },
    },
  });
  window.__GEOCODE_MAP_BOOTSTRAP__ = fixture();
});

afterEach(() => {
  runtime?.map.remove();
  runtime = undefined;
  delete window.__GEOCODE_MAP_BOOTSTRAP__;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function selectVector() {
  const radio = document.querySelector<HTMLInputElement>('.tile-radio[value="2"]')!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
}

describe("read-only basemap transitions", () => {
  it("ベクタ読み込み中に確定済みラスタをクリックすると切替を中止し、遅い完了を無視する", async () => {
    runtime = initializeReadOnlyMapPage("map-anather");
    const select = vi.spyOn(runtime.basemapController, "select");
    const raster = document.querySelector<HTMLInputElement>('.tile-radio[value="1"]')!;
    const vector = document.querySelector<HTMLInputElement>('.tile-radio[value="2"]')!;
    vector.click();
    expect(select.mock.calls).toEqual([["2"]]);
    expect(layers.vectors).toHaveLength(1);
    expect(runtime.basemapController.isPending()).toBe(true);
    expect(raster.checked).toBe(true);
    raster.click();
    expect(select.mock.calls).toEqual([["2"], ["1"]]);
    expect(runtime.basemapController.isPending()).toBe(false);
    expect(runtime.getPrintState().tileServerId).toBe("1");
    layers.vectors[0]!.resolve();
    await flush();
    expect(runtime.getPrintState().tileServerId).toBe("1");
    expect(raster.checked).toBe(true);
    expect(vector.checked).toBe(false);
    expect(layers.vectors[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("確定前は旧背景のIDを保ち、切替完了を待って共有する", async () => {
    runtime = initializeReadOnlyMapPage("map-anather");
    selectVector();
    expect(runtime.getPrintState().tileServerId).toBe("1");
    expect(document.querySelector<HTMLInputElement>('.tile-radio[value="1"]')!.checked).toBe(true);
    expect(() => runtime!.getShareSnapshot()).toThrow("切り替え完了後");
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    const share = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "現在の地図を共有する",
    )!;
    share.click();
    expect(post).not.toHaveBeenCalled();
    layers.vectors[0]!.resolve();
    await flush();
    expect(runtime.getPrintState().tileServerId).toBe("2");
    expect(document.querySelector<HTMLInputElement>('.tile-radio[value="2"]')!.checked).toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shareMapSnapshot",
        snapshot: expect.objectContaining({
          version: 2,
          state: expect.objectContaining({ tileServerId: "2" }),
          tileServers: expect.objectContaining({
            "2": expect.objectContaining({
              kind: "vector",
              style_url: "/assets/styles/vector.json",
            }),
          }),
        }),
      }),
      location.origin,
    );
  });

  it("v2共有はラスタを先に表示し、保存されたベクタの切替後に印刷を開始する", async () => {
    const base = fixture();
    const state = {
      view: base.initialView,
      tileServerId: "2",
      overlays: {},
      layerIds: [],
      markersVisible: true,
      shapesVisible: true,
      shapeNamesVisible: false,
    };
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...base,
      page: "temporary-map",
      isMaster: false,
      isChecked: false,
      isMapUiHidden: false,
      shapes: {},
      tileServers: {
        ...base.tileServers,
        "2": {
          ...base.tileServers["2"]!,
          kind: "vector",
          style_url: "/assets/styles/current.json",
        },
      },
      shareSnapshot: { version: 2, state, tileServers: base.tileServers, tileOverlays: [] },
    } satisfies TemporaryMapBootstrap;
    runtime = initializeReadOnlyMapPage("temporary-map");
    expect(layers.vectors[0]!.styleUrl).toBe("/assets/styles/vector.json");
    expect(runtime.getPrintState().tileServerId).toBe("1");
    const print = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "地図を印刷",
    )!;
    print.click();
    expect(document.querySelector(".map-print-host iframe")).toBeNull();
    layers.vectors[0]!.resolve();
    await flush();
    expect(document.querySelector(".map-print-host iframe")).not.toBeNull();
    expect(runtime.getPrintState().tileServerId).toBe("2");
  });

  it("切替失敗では元の確定背景とラジオを維持する", async () => {
    runtime = initializeReadOnlyMapPage("map-anather");
    selectVector();
    layers.vectors[0]!.reject(new Error("style unavailable"));
    await flush();
    expect(runtime.getPrintState().tileServerId).toBe("1");
    expect(document.querySelector<HTMLInputElement>('.tile-radio[value="1"]')!.checked).toBe(true);
    expect(runtime.basemapController.isPending()).toBe(false);
    expect(layers.vectors[0]!.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "背景地図を表示できません",
    );
  });
});
