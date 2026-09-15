import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrintPreview } from "../../../template-scripts/src/map/print/print-preview";
import {
  isPrintMapState,
  type PrintMapState,
} from "../../../template-scripts/src/map/common/print-state";

const state: PrintMapState = {
  view: { latitude: 35.68, longitude: 139.76, zoom: 12 },
  tileServerId: "2",
  overlays: { flood: false },
  markersVisible: true,
  shapesVisible: true,
  shapeNamesVisible: true,
  layerIds: ["group-a"],
};
let preview: ReturnType<typeof createPrintPreview> | undefined;
let L: any;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="map"></div>';
  localStorage.clear();
  localStorage.setItem(
    "geocode-web:last-map-view",
    JSON.stringify({ latitude: 1, longitude: 2, zoom: 3 }),
  );
  for (const file of [
    "leaflet/dist/leaflet-src.js",
    "leaflet.markercluster/dist/leaflet.markercluster-src.js",
    "marked/lib/marked.umd.js",
    "xss/dist/xss.js",
  ]) {
    window.eval(readFileSync(`node_modules/${file}`, "utf8"));
  }
  L = (window as any).L;
  vi.stubGlobal("L", L);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperties(document.getElementById("map"), {
    clientWidth: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 640 },
  });
  const tile = {
    url: "https://tiles.example.test/{z}/{x}/{y}.png",
    attribution: "Test attribution",
    label: "標準",
    layer_name: "標準",
    include_foreign_tiles: true,
    min_zoom: 0,
    max_zoom: 18,
  };
  window.__GEOCODE_MAP_BOOTSTRAP__ = {
    page: "map-anather",
    isCluster: false,
    initialView: { latitude: 30, longitude: 130, zoom: 5 },
    tileServers: { "1": tile, "2": { ...tile, layer_name: "写真", label: "写真" } },
    tileOverlays: [
      {
        id: "flood",
        name: "浸水想定",
        url: tile.url,
        attribution: "Flood attribution",
        min_zoom: 0,
        max_zoom: 18,
        opacity: 0.5,
        sort_order: 0,
      },
    ],
    tileVisibilityAccountId: "print-test",
    layers: {
      "group-a": { id: "group-a", layer_name: "避難所" },
      "group-b": { id: "group-b", layer_name: "施設" },
    },
    markers: {
      a: {
        id: "a",
        layer_id: "group-a",
        marker_name: "避難所A",
        detail: "",
        latitude: 35.68,
        longitude: 139.76,
      },
      b: {
        id: "b",
        layer_id: "group-b",
        marker_name: "施設B",
        detail: "",
        latitude: 35.68,
        longitude: 139.76,
      },
    },
    shapes: [
      {
        id: "shape-a",
        layer_id: "group-a",
        name: "区域",
        shape_type: "polygon",
        geojson: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.75, 35.67],
                [139.77, 35.67],
                [139.76, 35.69],
                [139.75, 35.67],
              ],
            ],
          },
        },
      },
    ],
  };
});
afterEach(() => {
  preview?.dispose();
  preview = undefined;
  document.body.replaceChildren();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function checkbox(text: string) {
  const label = [...document.querySelectorAll("#print-settings label")].find(
    (label) => label.textContent?.trim() === text,
  );
  return label!.querySelector<HTMLInputElement>("input")!;
}
function finishImages() {
  preview!.map.eachLayer((layer: any) => {
    if (layer.isLoading) vi.spyOn(layer, "isLoading").mockReturnValue(false);
  });
  document.querySelectorAll("#map img").forEach((img) => {
    Object.defineProperties(img, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 256 },
    });
  });
}
describe("印刷プレビューと実際のLeaflet", () => {
  it("現在の位置・背景・選択レイヤを引き継ぎ、印刷操作で保存設定を変更しない", () => {
    const before = { ...localStorage };
    const watchPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { watchPosition },
    });
    preview = createPrintPreview(state, vi.fn());
    expect(preview.map.getZoom()).toBe(12);
    expect(preview.map.getCenter().lat).toBeCloseTo(35.68);
    expect(document.querySelector<HTMLInputElement>(".tile-radio:checked")?.value).toBe("2");
    expect(checkbox("避難所").checked).toBe(true);
    expect(checkbox("施設").checked).toBe(false);
    expect(checkbox("浸水想定").checked).toBe(false);
    expect(document.querySelector("#map .leaflet-marker-icon")).not.toBeNull();
    checkbox("施設").click();
    checkbox("マーカー").click();
    checkbox("図形").click();
    checkbox("図形名").click();
    checkbox("浸水想定").click();
    preview.map.setView([34, 135], 11, { animate: false });
    expect({ ...localStorage }).toEqual(before);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("全用紙で中心位置を維持し、タイトルをテキストとして表示する", () => {
    preview = createPrintPreview(state, vi.fn());
    const select = document.getElementById("print-size") as HTMLSelectElement;
    for (const [value, width, height] of [
      ["a4-portrait", "210mm", "297mm"],
      ["a4-landscape", "297mm", "210mm"],
      ["a3-portrait", "297mm", "420mm"],
      ["a3-landscape", "420mm", "297mm"],
    ]) {
      select.value = value!;
      select.dispatchEvent(new Event("change"));
      expect(document.getElementById("print-paper")!.style.width).toBe(width);
      expect(document.getElementById("print-paper")!.style.height).toBe(height);
      expect(preview.map.getCenter().lat).toBeCloseTo(35.68);
    }
    const title = document.getElementById("print-title-input") as HTMLInputElement;
    title.value = '<img src=x onerror="alert(1)">';
    title.dispatchEvent(new Event("input"));
    expect(document.querySelector("#print-title img")).toBeNull();
    expect(document.getElementById("print-title")!.textContent).toBe(title.value);
    expect(document.querySelector("#map .leaflet-control-attribution")?.textContent).toContain(
      "Test attribution",
    );
    expect(document.querySelector("#map .leaflet-control-layers")).toBeNull();
  });

  it("印刷キーと親からの要求で同じ印刷処理を使い、長押しや不正な送信元を無視する", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(state, vi.fn());
    const press = (extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "p",
        ctrlKey: true,
        cancelable: true,
        bubbles: true,
        ...extra,
      });
      document.getElementById("print-title-input")!.dispatchEvent(event);
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(print).not.toHaveBeenCalled();
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    press({ repeat: true });
    expect(print).not.toHaveBeenCalled();
    press();
    expect(print).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    press({ ctrlKey: false, metaKey: true });
    expect(print).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    const send = (source: Window | null, origin = window.location.origin) =>
      window.dispatchEvent(
        new MessageEvent("message", { source, origin, data: { type: "printExecute" } }),
      );
    send(null);
    send(window.parent, "https://invalid.test");
    expect(print).toHaveBeenCalledTimes(2);
    send(window.parent);
    expect(print).toHaveBeenCalledTimes(3);
    preview.dispose();
    preview = undefined;
    send(window.parent);
    expect(print).toHaveBeenCalledTimes(3);
  });

  it("画像待機・失敗・再試行を処理し、印刷キャンセル後も操作できる", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(state, vi.fn());
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    button.click();
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
    checkbox("浸水想定").click();
    finishImages();
    const overlayImage = document.querySelector<HTMLImageElement>(
      ".leaflet-tileOverlays-pane img",
    )!;
    expect(overlayImage).not.toBeNull();
    Object.defineProperty(overlayImage, "naturalWidth", { configurable: true, value: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("現在の表示で印刷");
    expect(document.getElementById("print-status")!.textContent).toContain("一部を表示できません");
    expect((document.getElementById("print-retry") as HTMLButtonElement).hidden).toBe(false);
    button.click();
    expect(print).toHaveBeenCalledTimes(2);
    document.getElementById("print-retry")!.click();
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe("印刷");
    expect((document.getElementById("print-retry") as HTMLButtonElement).hidden).toBe(true);
    checkbox("浸水想定").click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    button.click();
    expect(print).toHaveBeenCalledTimes(3);
  });

  it("タイムアウト後は現在の表示で印刷でき、再試行で待機状態に戻る", async () => {
    preview = createPrintPreview(state, vi.fn());
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    await vi.advanceTimersByTimeAsync(31000);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("現在の表示で印刷");
    document.getElementById("print-retry")!.click();
    expect(button.disabled).toBe(true);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("印刷");
    expect((document.getElementById("print-retry") as HTMLButtonElement).hidden).toBe(true);
  });

  it("各欄の全解除・全選択はその欄の選択だけを切り替える", () => {
    const before = { ...localStorage };
    preview = createPrintPreview(state, vi.fn());
    const groups = document.querySelector<HTMLButtonElement>("#print-layers button")!;
    const overlays = document.querySelector<HTMLButtonElement>("#print-overlays button")!;
    expect(document.querySelector("#print-extra .layer-bulk-toggle-control")).toBeNull();
    groups.click();
    expect(groups.textContent).toBe("全選択");
    expect(checkbox("避難所").checked).toBe(false);
    expect(checkbox("マーカー").checked).toBe(true);
    groups.click();
    expect(checkbox("避難所").checked).toBe(true);
    expect(checkbox("施設").checked).toBe(true);
    overlays.click();
    expect(overlays.textContent).toBe("全選択");
    for (const label of ["マーカー", "図形", "図形名", "浸水想定"])
      expect(checkbox(label).checked).toBe(false);
    expect(checkbox("避難所").checked).toBe(true);
    expect(checkbox("施設").checked).toBe(true);
    overlays.click();
    for (const label of ["マーカー", "図形", "図形名", "浸水想定"])
      expect(checkbox(label).checked).toBe(true);
    expect({ ...localStorage }).toEqual(before);
  });

  it("不正な初期状態を拒否する", () => {
    expect(isPrintMapState(state)).toBe(true);
    expect(isPrintMapState({ ...state, view: { ...state.view, latitude: NaN } })).toBe(false);
    expect(isPrintMapState({ ...state, overlays: { flood: "true" } })).toBe(false);
    expect(isPrintMapState({ ...state, layerIds: [1] })).toBe(false);
  });
});
