import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readFrontendFile = (file: string, encoding: "utf8") =>
  readFileSync(resolve(frontendRoot, file), encoding);
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeReadOnlyMapPage } from "../../../template-scripts/src/map/read-only-page";
import {
  installAnswerColoring,
  type AnswerColoring,
} from "../../../template-scripts/src/map/answer-coloring";
import { createPrintPreview } from "../../../template-scripts/src/map/print/print-preview";

let L: any;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="map"></div>';
  localStorage.clear();
  for (const file of [
    "leaflet/dist/leaflet-src.js",
    "leaflet.markercluster/dist/leaflet.markercluster-src.js",
    "marked/lib/marked.umd.js",
    "xss/dist/xss.js",
  ])
    window.eval(readFrontendFile(`node_modules/${file}`, "utf8"));
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
  const fetchData = vi.fn().mockRejectedValue(new Error("回答地図の追加取得は禁止"));
  vi.stubGlobal("fetch", fetchData);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(count: number) {
  const markers = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `m${i}`,
      {
        id: `m${i}`,
        layer_id: "a",
        marker_name: `対象${i}`,
        detail: "",
        latitude: 35.68,
        longitude: 139.76,
      },
    ]),
  );
  const keys = Object.keys(markers).map((id) => `marker:${id}`);
  const state = {
    view: { latitude: 35.68, longitude: 139.76, zoom: 13 },
    tileServerId: "1",
    overlays: {},
    markersVisible: true,
    shapesVisible: true,
    shapeNamesVisible: false,
    layerIds: ["a"],
  };
  window.__GEOCODE_MAP_BOOTSTRAP__ = {
    page: "form-answer-map",
    isCluster: true,
    initialView: state.view,
    tileServers: {
      "1": {
        url: "https://tiles.example.test/{z}/{x}/{y}.png",
        attribution: "Test",
        label: "標準",
        layer_name: "標準",
        min_zoom: 0,
        max_zoom: 18,
      },
    },
    tileOverlays: [],
    layers: { a: { id: "a", layer_name: "対象レイヤ" } },
    markers,
    shapes: [],
    answerPreview: {
      query: {},
      targets: keys,
      parentOrigin: location.origin,
      requestId: "r",
      targetCount: count,
      answerCount: count,
    },
  };
  const coloring: AnswerColoring = {
    version: 1,
    rules: [
      { id: "red", label: "50年以上", color: "#d73027" },
      { id: "blue", label: "50年未満", color: "#2166ac" },
    ],
    targets: Object.fromEntries(keys.map((key, i) => [key, i < 9 ? "red" : "blue"])),
  };
  return { state, coloring, keys };
}
function visibleCluster(group: any) {
  return group.getVisibleParent(group.getLayers()[0]);
}
function assertCluster(group: any, count: number) {
  const cluster = visibleCluster(group);
  expect(cluster.getChildCount()).toBe(count);
  const icon = group.options.iconCreateFunction(cluster);
  const size = count < 10 ? "small" : count < 100 ? "medium" : "large";
  expect(icon.options.className).toBe(`marker-cluster marker-cluster-${size}`);
  expect(icon.options.iconSize.x).toBe(40);
  expect(icon.options.iconSize.y).toBe(40);
  expect(document.querySelector(".answer-neutral-cluster")).toBeNull();
}

describe("実Leafletで色分け後も通常のクラスタースタイルを維持する", () => {
  it("連続ズームとアニメーション中の解除でマーカーが消失しない", () => {
    fixture(9);
    const runtime = initializeReadOnlyMapPage("form-answer-map");
    dispose = () => runtime.map.remove();
    const group = runtime.visibleMarkerGroup;
    runtime.map.setZoom(15, { animate: false });
    vi.advanceTimersByTime(400);
    const input = document.querySelector<HTMLInputElement>(".marker-clustering-control input")!;
    input.click();
    const markers = group.getLayers();
    for (const zoom of [14, 16, 14, 15]) runtime.map.setZoom(zoom, { animate: false });
    expect(input.checked).toBe(true);
    input.click();
    vi.advanceTimersByTime(1000);
    expect(input.checked).toBe(false);
    expect(group.getLayers()).toHaveLength(9);
    expect(group.options.disableClusteringAtZoom).toBe(15);
    for (const marker of markers) {
      expect(group.getVisibleParent(marker)).toBe(marker);
      expect(marker.getElement()).not.toBeNull();
      expect(marker.getElement().style.opacity).not.toBe("0");
    }
  });

  it("クラスタ解除・再クラスタ化でも分類色と回答・凡例の絞り込みを維持する", () => {
    const f = fixture(100);
    const runtime = initializeReadOnlyMapPage("form-answer-map");
    dispose = () => runtime.map.remove();
    const group = runtime.visibleMarkerGroup;
    const original = group.options.iconCreateFunction;
    installAnswerColoring(runtime, L).apply(f.coloring);
    runtime.setAnswerTargets(f.keys.slice(0, 10));
    runtime.setLegendHiddenTargets([f.keys[0]]);
    const markers = group.getLayers();
    expect(markers).toHaveLength(9);
    runtime.map.setZoom(15, { animate: false });
    vi.advanceTimersByTime(400);
    const input = document.querySelector<HTMLInputElement>(".marker-clustering-control input")!;
    input.click();
    for (const marker of markers) expect(group.getVisibleParent(marker)).toBe(marker);
    expect(runtime.getPrintState().clusteringEnabled).toBe(false);
    expect(runtime.getPrintState().clusteringAllowed).toBe(true);
    expect(runtime.markers["marker-m1"].options.icon.options.html).toContain("#d73027");
    runtime.setLegendHiddenTargets([f.keys[0], f.keys[1]]);
    expect(group.getLayers()).toHaveLength(8);
    runtime.map.setZoom(14, { animate: false });
    vi.advanceTimersByTime(400);
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    assertCluster(group, 8);
    expect(group.options.iconCreateFunction).toBe(original);
    expect(group.getLayers()).not.toContain(runtime.markers["marker-m0"]);
    expect(group.getLayers()).not.toContain(runtime.markers["marker-m1"]);
    expect(runtime.visibleMarkerGroup).toBe(group);
  });

  it("印刷プレビューへ手動解除を引き継ぎ、縮小後は再クラスタ化する", () => {
    const f = fixture(9);
    const preview = createPrintPreview(
      {
        ...f.state,
        view: { ...f.state.view, zoom: 15 },
        clusteringEnabled: false,
        clusteringAllowed: true,
      },
      vi.fn(),
      "form-answer-map",
    );
    dispose = preview.dispose;
    let group: any;
    preview.map.eachLayer((layer: any) => {
      if (layer instanceof L.MarkerClusterGroup) group = layer;
    });
    const input = document.querySelector<HTMLInputElement>(".marker-clustering-control input")!;
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
    expect(group.options.disableClusteringAtZoom).toBe(15);
    for (const marker of group.getLayers()) expect(group.getVisibleParent(marker)).toBe(marker);
    preview.map.setZoom(14, { animate: false });
    vi.advanceTimersByTime(400);
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    assertCluster(group, 9);
    preview.map.setZoom(15, { animate: false });
    vi.advanceTimersByTime(400);
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it.each([
    [false, true],
    [true, false],
  ])("印刷はbootstrap=%s・引継ぎ設定=%sの固定OFFを優先する", (bootstrapAllowed, printAllowed) => {
    const f = fixture(9);
    (window.__GEOCODE_MAP_BOOTSTRAP__ as any).isCluster = bootstrapAllowed;
    const preview = createPrintPreview(
      { ...f.state, clusteringEnabled: true, clusteringAllowed: printAllowed },
      vi.fn(),
      "form-answer-map",
    );
    dispose = preview.dispose;
    const input = document.querySelector<HTMLInputElement>(".marker-clustering-control input")!;
    for (const zoom of [15, 14, 16]) {
      preview.map.setZoom(zoom, { animate: false });
      vi.advanceTimersByTime(400);
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(true);
      expect(document.querySelector(".marker-cluster")).toBeNull();
      expect(document.querySelectorAll(".leaflet-marker-icon")).toHaveLength(9);
    }
  });

  it.each([9, 10, 99, 100])(
    "%i件の境界で色分け・再適用・解除後も元の生成関数と40pxを維持する",
    (count) => {
      const f = fixture(count);
      const runtime = initializeReadOnlyMapPage("form-answer-map");
      dispose = () => runtime.map.remove();
      const group = runtime.visibleMarkerGroup;
      const original = group.options.iconCreateFunction;
      const center = runtime.map.getCenter(),
        zoom = runtime.map.getZoom();
      assertCluster(group, count);
      const controller = installAnswerColoring(runtime, L);
      controller.apply(f.coloring);
      expect(group.options.iconCreateFunction).toBe(original);
      assertCluster(group, count);
      expect(runtime.markers["marker-m0"].options.icon.options.html).toContain("#d73027");
      controller.apply({
        ...f.coloring,
        rules: f.coloring.rules.map((r) => ({ ...r, color: "#009e73" })),
      });
      expect(group.options.iconCreateFunction).toBe(original);
      assertCluster(group, count);
      controller.apply(null);
      expect(group.options.iconCreateFunction).toBe(original);
      assertCluster(group, count);
      expect(runtime.markers["marker-m0"].options.icon.options.className).not.toBe(
        "answer-value-marker",
      );
      expect(runtime.map.getCenter()).toEqual(center);
      expect(runtime.map.getZoom()).toBe(zoom);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("分類連動と回答条件で対象が減っても標準の件数区分を使い、除外対象を復活させない", () => {
    const f = fixture(100);
    const runtime = initializeReadOnlyMapPage("form-answer-map");
    dispose = () => runtime.map.remove();
    const group = runtime.visibleMarkerGroup,
      original = group.options.iconCreateFunction;
    installAnswerColoring(runtime, L).apply(f.coloring);
    runtime.setLegendHiddenTargets([f.keys[0]]);
    assertCluster(group, 99);
    runtime.setAnswerTargets(f.keys.slice(0, 10));
    assertCluster(group, 9);
    runtime.setLegendHiddenTargets([]);
    assertCluster(group, 10);
    expect(group.getLayers()).toHaveLength(10);
    expect(group.options.iconCreateFunction).toBe(original);
  });

  it("印刷の凡例連動で100件→9件→100件を切り替えても通常のクラスタを維持する", () => {
    const f = fixture(100);
    const preview = createPrintPreview(f.state, vi.fn(), "form-answer-map", undefined, f.coloring);
    dispose = preview.dispose;
    let group: any;
    preview.map.eachLayer((layer: any) => {
      if (layer instanceof L.MarkerClusterGroup) group = layer;
    });
    const original = group.options.iconCreateFunction;
    assertCluster(group, 100);
    const checkbox = (label: string) =>
      [...document.querySelectorAll(".answer-print-legend-settings label")]
        .find((element) => element.textContent?.trim() === label)!
        .querySelector<HTMLInputElement>("input")!;
    checkbox("50年未満").click();
    assertCluster(group, 100);
    checkbox("地図と連動").click();
    assertCluster(group, 9);
    checkbox("50年未満").click();
    assertCluster(group, 100);
    expect(group.options.iconCreateFunction).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });
});
