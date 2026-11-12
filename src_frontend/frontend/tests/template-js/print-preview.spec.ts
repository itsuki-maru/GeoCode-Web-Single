import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readFrontendFile = (file: string, encoding: "utf8") =>
  readFileSync(resolve(frontendRoot, file), encoding);
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
let fetchData: ReturnType<typeof vi.fn<typeof fetch>>;
const originalImageDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="map"></div>';
  // 実際の CSS を明示的に読み込む。Vitest は既定で ?inline のインポートをスタブ化するが、
  // 配布される Markdown スタイルでは凡例の ul/li が 16px に固定される。
  for (const file of [
    "public/github.css",
    "../template-scripts/src/map/print/print-preview.css",
    "../template-scripts/src/map/common/color-legend.css",
  ]) {
    const style = document.createElement("style");
    style.textContent = readFrontendFile(file, "utf8");
    document.head.append(style);
  }
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
    window.eval(readFrontendFile(`node_modules/${file}`, "utf8"));
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
  const bootstrap = {
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
        detail: "マーカーの詳細",
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
          properties: { memo: "図形の詳細" },
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
  // 初期データはメタデータだけとし、選択したグループの内容を取得 API から返す。
  window.__GEOCODE_MAP_BOOTSTRAP__ = { ...bootstrap, markers: {}, shapes: [] };
  fetchData = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.origin);
    const layerId = url.searchParams.get("layer") ?? url.searchParams.get("layer_id");
    if (url.searchParams.get("is_master") !== "false")
      throw new Error("テスト用の取得 API にはグループの絞り込みが必要です。");
    if (url.pathname === "/marker/read/all") {
      return new Response(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(bootstrap.markers).filter(([, marker]) => marker.layer_id === layerId),
          ),
        ),
      );
    }
    if (url.pathname === "/shapes") {
      return new Response(
        JSON.stringify(bootstrap.shapes.filter((shape) => shape.layer_id === layerId)),
      );
    }
    throw new Error(`想定していない取得先です: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchData);
});
afterEach(() => {
  preview?.dispose();
  preview = undefined;
  document.body.replaceChildren();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalImageDecode)
    Object.defineProperty(HTMLImageElement.prototype, "decode", originalImageDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
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
async function finishObjectLoads() {
  await vi.waitFor(() => {
    const selected = [...document.querySelectorAll<HTMLElement>("[data-layer-load-id]")].filter(
      (label) => label.closest("label")?.querySelector<HTMLInputElement>("input")?.checked,
    );
    expect(selected.length).toBeGreaterThan(0);
    for (const label of selected) {
      expect(label.querySelector<HTMLElement>(".layer-object-load-state")?.dataset.state).toBe(
        "loaded",
      );
    }
  });
}
function addPrintCanvas(decode = vi.fn().mockResolvedValue(undefined)) {
  // jsdom は inert の初期値を実装していないため、ブラウザーの既定値を明示する。
  document.getElementById("print-viewport")!.inert = false;
  const canvas = document.createElement("canvas");
  canvas.dataset.geocodeMaplibreCanvas = "";
  canvas.style.cssText = "position:absolute;width:900px;height:640px";
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 900,
    bottom: 640,
    width: 900,
    height: 640,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/png;base64,BACKGROUND");
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    value: decode,
    configurable: true,
  });
  document.getElementById("map")!.append(canvas);
  return canvas;
}

async function mockVectorBackgrounds(decode = vi.fn().mockResolvedValue(undefined)) {
  const renderer = await import("../../../template-scripts/src/map/common/basemap-layer");
  const createRaster = renderer.createBasemapLayer;
  const vectors: { layer: any; canvas: HTMLCanvasElement }[] = [];
  vi.spyOn(renderer, "createBasemapLayer").mockImplementation((leaflet, map, record, options) => {
    if (record.kind !== "vector") return createRaster(leaflet, map, record, options);
    const canvas = addPrintCanvas(decode);
    const VectorLayer = L.Layer.extend({
      options: { minZoom: record.min_zoom ?? 5, maxZoom: record.max_zoom ?? 18 },
      onAdd() {
        map.getPane("tilePane").append(canvas);
        map._addZoomLimit(this);
      },
      onRemove() {
        canvas.remove();
        map._removeZoomLimit(this);
      },
      getPrintStatus: () => ({ loading: false, failed: false }),
    });
    const layer = new VectorLayer();
    vectors.push({ layer, canvas });
    return {
      layer,
      ready: Promise.resolve(),
      setVisible: (visible) => {
        canvas.style.opacity = visible ? "1" : "0";
      },
      // 破棄済みLayerのリスナーを観測可能にし、GLの解放は別に検証する。
      dispose: () => {},
    };
  });
  return vectors;
}

describe("印刷プレビューと実際のLeaflet", () => {
  it.each(["印刷終了", "背景のload通知"])("%sの直後にPDFを無効にし、安定後に再び有効にする", async (change) => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    if (change === "印刷終了") {
      addPrintCanvas();
      vi.spyOn(window, "print").mockImplementation(() => {
        window.dispatchEvent(new Event("beforeprint"));
        window.dispatchEvent(new Event("afterprint"));
      });
    }
    await vi.advanceTimersByTimeAsync(1000);
    const submit = document.getElementById("print-submit") as HTMLButtonElement;
    const pdf = document.getElementById("pdf-export") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
    if (change === "印刷終了") {
      submit.click();
      await vi.advanceTimersByTimeAsync(0);
    } else {
      let background: any;
      preview.map.eachLayer((layer: any) => {
        if (layer instanceof L.TileLayer) background = layer;
      });
      expect(background).toBeDefined();
      background.fire("load");
    }
    // 200msごとの状態更新前にも、700msの安定待ちとボタン表示を一致させる。
    expect(submit.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(submit.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
  });

  it("ベクタ背景を画像化してから印刷し、終了後に元のcanvasと操作を復元する", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    const canvas = addPrintCanvas();
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      expect(canvas.style.display).toBe("none");
      expect(document.querySelector("[data-geocode-maplibre-print-image]")).not.toBeNull();
      expect(document.getElementById("print-viewport")!.inert).toBe(true);
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    });
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).toHaveBeenCalledOnce();
    expect(canvas.isConnected).toBe(true);
    expect(canvas.style.display).toBe("");
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
  });

  it("背景の画像化に失敗した場合は印刷せず、操作とcanvasを復元する", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    const canvas = addPrintCanvas();
    vi.mocked(canvas.toDataURL).mockReturnValue("data:,");
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).not.toHaveBeenCalled();
    expect(document.getElementById("print-status")!.textContent).toContain("印刷画面を開けません");
    expect(canvas.style.display).toBe("");
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
  });

  it("画像の準備中に背景が故障してラスタへ代替すると印刷を中止し、新しい表示で再試行できる", async () => {
    let finishDecode!: () => void;
    const decode = vi.fn().mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDecode = resolve;
      }),
    );
    const vectors = await mockVectorBackgrounds(decode);
    const messages = await import("../../../template-scripts/src/map/common/map-message-dialog");
    vi.spyOn(messages, "createMapMessageDialog").mockReturnValue({
      dialog: document.createElement("dialog"),
      show: vi.fn(),
      close: vi.fn(),
      dispose: vi.fn(),
    });
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    Object.assign(bootstrap.tileServers["2"], { kind: "vector", style_url: "/styles/test.json" });
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    const { layer: activeVector, canvas } = vectors[0]!;
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(decode).toHaveBeenCalledOnce();
    activeVector.fire("basemaperror", { error: new Error("WebGL context lost") });
    expect((preview.map as any)._geocodeBasemap.getSelectedId()).toBe("1");
    expect(canvas.isConnected).toBe(false);
    finishDecode();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).not.toHaveBeenCalled();
    expect(document.getElementById("print-status")!.textContent).toContain("地図が変更されました");
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    // ラスタ経路は同期処理を保ち、キャンバスのデコードを繰り返さない。
    expect(print).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
  });

  it("画像の準備中に表示位置が変わると旧画像では印刷せず、新しい表示で再試行できる", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    let finishDecode!: () => void;
    const decode = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishDecode = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const canvas = addPrintCanvas(decode);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    preview.map.setView([35.69, 139.77], 13, { animate: false });
    finishDecode();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).not.toHaveBeenCalled();
    expect(canvas.style.display).toBe("");
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("画像準備中の描画完了通知だけでは同じ背景の印刷を中止しない", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    let finishDecode!: () => void;
    const decode = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finishDecode = resolve;
      }),
    );
    addPrintCanvas(decode);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    await vi.advanceTimersByTimeAsync(0);
    (preview.map as any)._geocodeBasemap.getLayer().fire("load");
    finishDecode();
    await vi.advanceTimersByTimeAsync(0);
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
  });

  it("背景画像の準備中は操作を止め、破棄時は待機を中止して一時画像を除去する", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    const decode = vi.fn().mockReturnValue(new Promise(() => {}));
    const canvas = addPrintCanvas(decode);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    const button = document.getElementById("print-submit")!;
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(decode).toHaveBeenCalledOnce();
    expect(document.getElementById("print-viewport")!.inert).toBe(true);
    expect(canvas.style.display).toBe("none");
    button.click();
    expect(decode).toHaveBeenCalledOnce();
    const resume = vi.fn();
    preview.map.on("printresume", resume);
    preview.dispose();
    const disposedStatus = document.getElementById("print-status")!.textContent;
    await vi.advanceTimersByTimeAsync(0);
    expect(print).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(document.getElementById("print-status")!.textContent).toBe(disposedStatus);
    expect(canvas.style.display).toBe("");
    expect(document.querySelector("[data-geocode-maplibre-print-image]")).toBeNull();
    expect(document.getElementById("print-viewport")!.inert).toBe(false);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
  });

  it("20回の背景切替で旧背景の監視を残さず、遅い旧イベントは印刷待機を再開しない", async () => {
    const vectors = await mockVectorBackgrounds();
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    const base = bootstrap.tileServers["2"];
    for (let id = 2; id <= 22; id++) {
      bootstrap.tileServers[String(id)] = {
        ...base,
        id,
        kind: "vector",
        style_url: `/styles/${id}.json`,
        layer_name: `vector-${id}`,
      };
    }
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    const controller = (preview.map as any)._geocodeBasemap;
    for (let id = 3; id <= 22; id++) expect(await controller.select(String(id))).toBe(true);
    expect(vectors).toHaveLength(21);
    expect(controller.getSelectedId()).toBe("22");
    const retired = vectors.slice(0, -1);
    for (const { layer, canvas } of retired) {
      expect(layer.listens("load")).toBe(false);
      expect(layer.listens("loading")).toBe(false);
      expect(layer.listens("tileerror")).toBe(false);
      expect(canvas.isConnected).toBe(false);
    }
    expect(vectors.at(-1)!.layer.listens("load")).toBe(true);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    for (const { layer } of retired) layer.fire("load");
    expect(button.disabled).toBe(false);
    preview.dispose();
    expect(vectors.every(({ layer }) => !layer.listens("load"))).toBe(true);
  });

  it("除去したグループの監視を外し、再表示すると一度だけ監視を再登録する", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    const group = L.layerGroup();
    const on = vi.spyOn(group, "on");
    group.addTo(preview.map);
    expect(group.listens("load")).toBe(true);
    preview.map.removeLayer(group);
    expect(group.listens("load")).toBe(false);
    group.addTo(preview.map);
    expect(
      on.mock.calls.filter(
        ([events]) => events === "loading load tileloadstart tileload tileerror",
      ),
    ).toHaveLength(2);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    group.fire("load");
    expect(button.disabled).toBe(true);
    preview.map.removeLayer(group);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    group.fire("load");
    expect(button.disabled).toBe(false);
  });

  it.each([
    { markerIds: ["a"], shapeIds: ["shape-a"], markers: 1, shapes: 1 },
    { markerIds: ["a"], shapeIds: [], markers: 1, shapes: 0 },
    { markerIds: [], shapeIds: ["shape-a"], markers: 0, shapes: 1 },
    { markerIds: [], shapeIds: [], markers: 0, shapes: 0 },
    { markerIds: null, shapeIds: null, markers: 2, shapes: 1 },
  ])("検索結果を遅延取得・レイヤ再表示・地図移動後も維持する: %j", async (filter) => {
    preview = createPrintPreview({ ...state, ...filter, layerIds: null }, vi.fn());
    await finishObjectLoads();
    const check = () => {
      const markers: any[] = [];
      const shapes: any[] = [];
      preview!.map.eachLayer((layer: any) => {
        if (layer.options?.icon && layer.getTooltip?.()) markers.push(layer);
        if (layer.shapeId) shapes.push(layer);
      });
      expect(markers).toHaveLength(filter.markers);
      expect(shapes).toHaveLength(filter.shapes);
      if (filter.markerIds) {
        expect(markers.every((m) => String(m.getTooltip().getContent()).includes("避難所A"))).toBe(
          true,
        );
      }
      if (filter.shapes === 0)
        expect(document.querySelector("#map")!.textContent).not.toContain("区域");
    };
    await vi.waitFor(check);
    checkbox("避難所").click();
    checkbox("避難所").click();
    checkbox("マーカー").click();
    checkbox("マーカー").click();
    checkbox("図形").click();
    checkbox("図形").click();
    preview.map.setView([35.681, 139.761], 13, { animate: false });
    await finishObjectLoads();
    await vi.waitFor(check);
  });

  it("色分け未使用の通常印刷に凡例設定を追加しない", () => {
    preview = createPrintPreview(state, vi.fn());
    expect(document.querySelector(".answer-print-legend")).toBeNull();
    expect(document.querySelector(".answer-print-legend-settings")).toBeNull();
  });

  it("通常印刷はstateの分類色と凡例を遅延取得後も引き継ぎ、凡例の連動解除で検索範囲を広げない", async () => {
    preview = createPrintPreview(
      {
        ...state,
        layerIds: null,
        markerIds: ["a"],
        shapeIds: [],
        coloring: {
          version: 1,
          rules: [{ id: "r", label: "分類A", color: "#ff0000" }],
          targets: { "marker:a": "r", "marker:b": "r", "shape:shape-a": "r" },
        },
      },
      vi.fn(),
    );
    await finishObjectLoads();
    const checkVisible = (count: number) => {
      const markers: any[] = [],
        shapes: any[] = [];
      preview!.map.eachLayer((layer: any) => {
        if (layer.options?.icon && layer.getTooltip?.()) markers.push(layer);
        if (layer.shapeId) shapes.push(layer);
      });
      expect(markers).toHaveLength(count);
      expect(shapes).toHaveLength(0);
      if (count) expect(String(markers[0].getTooltip().getContent())).toContain("避難所A");
    };
    await vi.waitFor(() => {
      checkVisible(1);
      expect(document.querySelectorAll("#map .answer-value-marker")).toHaveLength(1);
      expect(document.querySelector(".answer-print-legend li")?.textContent).toBe("分類A");
    });
    checkbox("地図と連動").click();
    checkbox("分類A").click();
    await vi.waitFor(() => checkVisible(0));
    checkbox("地図と連動").click();
    await vi.waitFor(() => checkVisible(1));
  });

  it("登録地図の凡例を分類ごとにまとめ、同分類のマーカー・図形を一括切替しても非選択レイヤを復活させない", async () => {
    const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__ as any;
    bootstrap.page = "form-answer-map";
    bootstrap.markers = {
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
        layer_id: "group-a",
        marker_name: "施設B",
        detail: "",
        latitude: 35.69,
        longitude: 139.77,
      },
      c: {
        id: "c",
        layer_id: "group-b",
        marker_name: "施設C",
        detail: "",
        latitude: 35.7,
        longitude: 139.78,
      },
    };
    bootstrap.shapes = [
      {
        id: "s",
        layer_id: "group-a",
        name: "区域",
        shape_type: "circle",
        geojson: {
          type: "Feature",
          // ズーム12でも描画対象となる大きさにし、凡例による表示切替を検証する。
          properties: { radius: 200 },
          geometry: { type: "Point", coordinates: [139.76, 35.68] },
        },
      },
    ];
    bootstrap.answerPreview = {
      query: {},
      targets: ["marker:a", "marker:b", "marker:c", "shape:s"],
      parentOrigin: location.origin,
      requestId: "r",
      answerCount: 4,
      targetCount: 4,
    };
    const before = JSON.stringify(bootstrap);
    // トップページのフィルターを、独立した共通フォームの印刷ルートに反映させない。
    preview = createPrintPreview(
      { ...state, markerIds: [], shapeIds: [] },
      vi.fn(),
      "form-answer-map",
      undefined,
      {
        version: 1,
        rules: [
          { id: "r", label: "耐用年数50年以上", color: "#ff0000" },
          { id: "empty", label: "該当なし", color: "#0000ff" },
        ],
        targets: { "marker:a": "r", "marker:c": "r", "shape:s": "r" },
      },
    );
    const map = preview.map;
    const center = map.getCenter();
    const zoom = map.getZoom();
    let markerA: any, markerB: any, markerC: any, shape: any;
    map.eachLayer((layer: any) => {
      if (layer.options?.icon) {
        if (String(layer.getTooltip?.()?.getContent()).includes("避難所A")) markerA = layer;
        if (String(layer.getTooltip?.()?.getContent()).includes("施設B")) markerB = layer;
        if (String(layer.getTooltip?.()?.getContent()).includes("施設C")) markerC = layer;
      } else if (layer.shapeId === "s" || layer.options?.color === "#ff0000") shape = layer;
    });
    expect(markerA).toBeDefined();
    expect(markerB).toBeDefined();
    expect(markerC).toBeDefined();
    expect(shape).toBeDefined();
    expect(map.hasLayer(markerC)).toBe(true);
    checkbox("施設").click();
    expect(map.hasLayer(markerC)).toBe(false);
    expect(shape.options.color).toBe("#ff0000");
    expect(document.querySelectorAll("#map .answer-value-marker")).toHaveLength(1);
    const entries = document.querySelectorAll(".answer-print-legend li");
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toBe("耐用年数50年以上");
    expect(document.querySelector(".answer-print-legend")!.textContent).not.toContain("避難所A");
    expect(document.querySelector(".answer-print-legend")!.textContent).not.toContain("区域");
    expect(document.querySelector(".answer-print-legend-settings")!.textContent).not.toContain(
      "該当なし",
    );
    expect(fetchData).not.toHaveBeenCalled();
    checkbox("耐用年数50年以上").click();
    expect(map.hasLayer(markerA)).toBe(true);
    expect(map.hasLayer(shape)).toBe(true);
    checkbox("地図と連動").click();
    expect(map.hasLayer(markerA)).toBe(false);
    expect(map.hasLayer(shape)).toBe(false);
    expect(map.hasLayer(markerC)).toBe(false);
    expect(map.hasLayer(markerB)).toBe(true);
    checkbox("凡例を表示").click();
    expect(document.querySelector<HTMLElement>(".answer-print-legend")!.hidden).toBe(true);
    expect(map.hasLayer(markerA)).toBe(false);
    checkbox("避難所").click();
    checkbox("耐用年数50年以上").click();
    expect(map.hasLayer(markerA)).toBe(false);
    expect(map.hasLayer(shape)).toBe(false);
    expect(map.hasLayer(markerB)).toBe(false);
    expect(map.hasLayer(markerC)).toBe(false);
    checkbox("地図と連動").click();
    expect(map.hasLayer(markerA)).toBe(false);
    checkbox("避難所").click();
    expect(map.hasLayer(markerA)).toBe(true);
    expect(map.hasLayer(shape)).toBe(true);
    expect(map.hasLayer(markerB)).toBe(true);
    expect(map.hasLayer(markerC)).toBe(false);
    expect(preview.map).toBe(map);
    expect(map.getCenter()).toEqual(center);
    expect(map.getZoom()).toBe(zoom);
    expect(JSON.stringify(bootstrap)).toBe(before);
    expect(fetchData).not.toHaveBeenCalled();
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect((document.getElementById("print-submit") as HTMLButtonElement).disabled).toBe(false);
    checkbox("凡例を表示").click();
    const panel = document.querySelector<HTMLElement>(".answer-print-legend")!;
    const font = document.querySelector<HTMLSelectElement>('[aria-label="凡例の文字サイズ"]')!;
    expect(font.value).toBe("12");
    for (const size of [8, 12, 18, 32]) {
      font.value = String(size);
      font.dispatchEvent(new Event("change", { bubbles: true }));
      expect(getComputedStyle(panel).fontSize).toBe(`${size}px`);
      expect(getComputedStyle(panel.querySelector("strong")!).fontSize).toBe(`${size}px`);
      expect(getComputedStyle(panel.querySelector("li")!).fontSize).toBe(`${size}px`);
      expect(getComputedStyle(panel.querySelector(".answer-print-legend-swatch")!).fontSize).toBe(
        `${size}px`,
      );
      expect(
        getComputedStyle(document.querySelector(".answer-print-legend-option")!).fontSize,
      ).toBe("13px");
    }
    const ordinaryList = document.createElement("ul");
    ordinaryList.innerHTML = "<li>通常の本文ラベル</li>";
    document.body.append(ordinaryList);
    expect(getComputedStyle(ordinaryList.firstElementChild!).fontSize).toBe("16px");
    ordinaryList.remove();
    font.value = "18";
    font.dispatchEvent(new Event("change", { bubbles: true }));
    expect((document.getElementById("print-submit") as HTMLButtonElement).disabled).toBe(true);
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect((document.getElementById("print-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(preview.map).toBe(map);
    expect(map.getCenter()).toEqual(center);
    expect(map.getZoom()).toBe(zoom);
    expect(JSON.stringify(bootstrap)).toBe(before);
    Object.defineProperties(panel, { clientHeight: { value: 100 }, scrollHeight: { value: 200 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect((document.getElementById("print-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("pdf-export") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("print-status")!.textContent).toContain(
      "凡例が枠に収まりません",
    );
    checkbox("凡例を表示").click();
    await vi.advanceTimersByTimeAsync(1000);
    expect((document.getElementById("print-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["marker", "shape"])("%sのポップアップを印刷中・キャンセル後も保持する", async (kind) => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    let target: any;
    preview.map.eachLayer((layer: any) => {
      if (kind === "marker" ? layer instanceof L.Marker : layer.shapeMemo === "図形の詳細")
        target = layer;
    });
    expect(target).toBeDefined();
    if (kind === "marker") target.openPopup();
    else target.fire("click", { latlng: L.latLng(35.68, 139.76) });
    const content = kind === "marker" ? "マーカーの詳細" : "図形の詳細";
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      window.dispatchEvent(new Event("beforeprint"));
      expect(document.querySelector(".leaflet-popup-content")?.textContent).toContain(content);
      window.dispatchEvent(new Event("afterprint"));
    });
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById("print-submit")!.click();
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".leaflet-popup-content")?.textContent).toContain(content);
    expect(document.body.classList.contains("print-preparing")).toBe(false);
  });

  it("ポップアップ画像の読み込み・失敗を反映し、閉じた詳細の画像は待たない", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    L.popup({ autoPan: false })
      .setLatLng([35.68, 139.76])
      .setContent(
        '<img id="popup-image" src="/popup.png"><details><img src="/hidden.png"></details>',
      )
      .openOn(preview.map);
    finishImages();
    const img = document.getElementById("popup-image") as HTMLImageElement;
    const hidden = document.querySelector(".leaflet-popup-content details img")!;
    Object.defineProperty(hidden, "complete", { configurable: true, value: false });
    Object.defineProperty(img, "complete", { configurable: true, value: false });
    await vi.advanceTimersByTimeAsync(1000);
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    Object.defineProperty(img, "complete", { configurable: true, value: true });
    img.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 0 });
    img.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe("現在の表示で印刷");
    expect((document.getElementById("pdf-export") as HTMLButtonElement).disabled).toBe(true);
    preview.map.closePopup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe("印刷");
    expect((document.getElementById("pdf-export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("現在の位置・背景・選択レイヤを引き継ぎ、印刷操作で保存設定を変更しない", async () => {
    localStorage.setItem("geocode-web:selected-tile-server-id", "1");
    localStorage.setItem("geocode-web:tile-overlay-visibility:print-test", '{"flood":true}');
    const before = { ...localStorage };
    const watchPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { watchPosition },
    });
    preview = createPrintPreview(state, vi.fn());
    expect(document.querySelector("#map .leaflet-marker-icon")).toBeNull();
    await finishObjectLoads();
    expect(fetchData).toHaveBeenCalledTimes(2);
    for (const [input] of fetchData.mock.calls) {
      const url = new URL(String(input), window.location.origin);
      expect(url.searchParams.get("layer") ?? url.searchParams.get("layer_id")).toBe("group-a");
    }
    expect(preview.map.getZoom()).toBe(12);
    expect(preview.map.getCenter().lat).toBeCloseTo(35.68);
    expect(document.querySelector<HTMLInputElement>(".tile-radio:checked")?.value).toBe("2");
    expect(checkbox("避難所").checked).toBe(true);
    expect(checkbox("施設").checked).toBe(false);
    expect(checkbox("浸水想定").checked).toBe(false);
    expect(document.querySelector("#map .leaflet-marker-icon")).not.toBeNull();
    checkbox("施設").click();
    await finishObjectLoads();
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
      ["b5-portrait", "182mm", "257mm"],
      ["b5-landscape", "257mm", "182mm"],
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

  it("タイトル確定時のchangeイベントで出力待機をやり直さない", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    const title = document.getElementById("print-title-input") as HTMLInputElement;
    title.value = "避難所案内";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect((document.getElementById("pdf-export") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("print-submit")!.click();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("印刷キーと親からの要求で同じ印刷処理を使い、長押しや不正な送信元を無視する", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
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
    await finishObjectLoads();
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
    await finishObjectLoads();
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

  it("背景切替中はタイムアウト後も印刷とPDFを止め、確定後に描画完了を待つ", async () => {
    preview = createPrintPreview(state, vi.fn());
    await finishObjectLoads();
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    const controller = (preview.map as any)._geocodeBasemap;
    const pending = vi.spyOn(controller, "isPending").mockReturnValue(true);
    const active = controller.getLayer();
    active.getPrintStatus = vi.fn(() => ({ loading: true, failed: false }));
    preview.map.fire("basemaploadingchange");
    await vi.advanceTimersByTimeAsync(31000);
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    const pdf = document.getElementById("pdf-export") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    expect(document.getElementById("print-status")!.textContent).toContain("背景地図を切り替え");
    pending.mockReturnValue(false);
    preview.map.fire("basemaploadingchange");
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    active.getPrintStatus.mockReturnValue({ loading: false, failed: false });
    active.fire("load");
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
  });

  it("グループの取得中・取得失敗時は出力を止め、再試行の成功後に印刷できる", async () => {
    let failMarkers!: (response: Response) => void;
    fetchData.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        failMarkers = resolve;
      }),
    );
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview = createPrintPreview(state, vi.fn());
    const button = document.getElementById("print-submit") as HTMLButtonElement;
    const pdf = document.getElementById("pdf-export") as HTMLButtonElement;
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    expect(document.getElementById("print-status")!.textContent).toContain(
      "グループのデータを読み込んでいます",
    );
    button.click();
    expect(print).not.toHaveBeenCalled();

    failMarkers(new Response("取得失敗", { status: 500 }));
    await vi.advanceTimersByTimeAsync(31000);
    expect(button.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    expect(document.getElementById("print-status")!.textContent).toContain(
      "グループのデータを取得できませんでした",
    );
    button.click();
    expect(print).not.toHaveBeenCalled();

    document.getElementById("print-retry")!.click();
    await finishObjectLoads();
    finishImages();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchData).toHaveBeenCalledTimes(4);
    expect(button.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
    button.click();
    expect(print).toHaveBeenCalledOnce();
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
