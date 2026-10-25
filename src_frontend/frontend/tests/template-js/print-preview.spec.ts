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
let fetchData: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="map"></div>';
  // Load the real CSS explicitly: Vitest stubs ?inline imports by default, while
  // the shipped Markdown styles would otherwise fix legend ul/li at 16px.
  for (const file of ["public/github.css", "../template-scripts/src/map/print/print-preview.css"]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(file, "utf8");
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
describe("印刷プレビューと実際のLeaflet", () => {
  it("色分け未使用の通常印刷に凡例設定を追加しない", () => {
    preview = createPrintPreview(state, vi.fn());
    expect(document.querySelector(".answer-print-legend")).toBeNull();
    expect(document.querySelector(".answer-print-legend-settings")).toBeNull();
  });

  it("回答地図の凡例を分類ごとにまとめ、同分類のマーカー・図形を一括切替しても非選択レイヤを復活させない", async () => {
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
          properties: { radius: 30 },
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
    preview = createPrintPreview(state, vi.fn(), "form-answer-map", undefined, {
      version: 1,
      rules: [
        { id: "r", label: "耐用年数50年以上", color: "#ff0000" },
        { id: "empty", label: "該当なし", color: "#0000ff" },
      ],
      targets: { "marker:a": "r", "marker:c": "r", "shape:s": "r" },
    });
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
