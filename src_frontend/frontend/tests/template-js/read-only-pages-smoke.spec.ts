import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadOnlyMapRuntime } from "../../../template-scripts/src/map/common/map-runtime";
import { createPopupContentRuntime } from "../../../template-scripts/src/map/common/popup-content";
import * as baseModule from "../../../template-scripts/src/map/common/base";
import * as contentActionsModule from "../../../template-scripts/src/map/common/content-actions";
import * as contentModule from "../../../template-scripts/src/map/common/content";
import { makeSummaryDraggable } from "../../../template-scripts/src/map/common/draggable-summary";
import { createMapUiVisibilityRuntime } from "../../../template-scripts/src/map/common/map-ui-visibility";
import * as mapObjectFocusModule from "../../../template-scripts/src/map/common/map-object-focus";
import * as mapViewPersistenceModule from "../../../template-scripts/src/map/common/map-view-persistence";
import { createReadOnlyLayerGroupRuntime } from "../../../template-scripts/src/map/common/layer-groups";
import * as markerModule from "../../../template-scripts/src/map/common/marker";
import { installMarkerClustering } from "../../../template-scripts/src/map/common/marker-clustering";
import { createReadOnlyShapeMeasurementDisplayRuntime } from "../../../template-scripts/src/map/common/shape-measurement-display";
import { createReadOnlyShapeRestorationRuntime } from "../../../template-scripts/src/map/common/shape-restoration";
import { initializeReadOnlyMapPage } from "../../../template-scripts/src/map/read-only-page";
import { finishAnswerPreview } from "../../../template-scripts/src/map/answer-preview";
import * as mjpegCameraModule from "../../../template-scripts/src/map/common/mjpeg-camera";
import {
  createReadOnlyMarkerLayerControl,
  hydrateReadOnlyMarkers,
} from "../../../template-scripts/src/map/common/marker-layers";
import { installReadOnlyOverlayHandlers } from "../../../template-scripts/src/map/common/overlay-events";
import {
  addReadOnlyMapVisibilityControls,
  addReadOnlySearchControls,
} from "../../../template-scripts/src/map/common/page-controls";
import { createMapObjectSearchCoordinator } from "../../../template-scripts/src/map/common/search";
import * as searchModule from "../../../template-scripts/src/map/common/search";
import * as shapeArrowModule from "../../../template-scripts/src/map/common/shape-arrow";
import * as shapeLayerModule from "../../../template-scripts/src/map/common/shape-layer";
import * as shapeMeasurementModule from "../../../template-scripts/src/map/common/shape-measurement";
import * as shapeMemoModule from "../../../template-scripts/src/map/common/shape-memo";
import * as shapeRendererModule from "../../../template-scripts/src/map/common/shape-renderer";
import * as shapeStyleModule from "../../../template-scripts/src/map/common/shape-style";
import * as shapeViewportModule from "../../../template-scripts/src/map/common/shape-viewport";
import * as storageModule from "../../../template-scripts/src/map/common/storage";
import { createTileOverlayManager } from "../../../template-scripts/src/map/common/tile-overlays";
import {
  createMeasurementVisibilityControl,
  createTooltipVisibilityControl,
} from "../../../template-scripts/src/map/common/visibility-controls";
import { editorRuntimeSource } from "./helpers/editor-entry-source";

const dependencyScripts = [
  "node_modules/marked/lib/marked.umd.js",
  "node_modules/leaflet/dist/leaflet-src.js",
  "node_modules/xss/dist/xss.js",
  "node_modules/leaflet.markercluster/dist/leaflet.markercluster-src.js",
] as const;

const tileServers = {
  "1": {
    attribution: "Test tiles",
    include_foreign_tiles: true,
    label: "Test tiles",
    layer_name: "test-tiles",
    max_zoom: 18,
    min_zoom: 1,
    url: "https://tiles.example.test/{z}/{x}/{y}.png",
  },
};

const layerRecords = {
  "layer-1": {
    id: "layer-1",
    layer_name: "Test Layer",
  },
};

const markerRecords = {
  "marker-1": {
    detail: "**Safe marker detail**",
    id: "marker-1",
    latitude: 35.6812,
    layer_id: "layer-1",
    longitude: 139.7671,
    marker_name: "Tokyo Station",
  },
};

const shapeRecord = {
  geojson: {
    geometry: {
      coordinates: [
        [
          [139.76, 35.68],
          [139.77, 35.68],
          [139.77, 35.69],
          [139.76, 35.68],
        ],
      ],
      type: "Polygon",
    },
    properties: {
      memo: "**重要**な共有メモ\n\n<script>危険な内容</script>",
    },
    type: "Feature",
  },
  id: "shape-1",
  layer_id: "layer-1",
  name: "避難区域",
  shape_type: "polygon",
};

const shapeWithoutMemoRecord = {
  ...shapeRecord,
  geojson: {
    ...shapeRecord.geojson,
    geometry: {
      coordinates: [
        [
          [139.78, 35.7],
          [139.79, 35.7],
          [139.79, 35.71],
          [139.78, 35.7],
        ],
      ],
      type: "Polygon",
    },
    properties: { memo: "   " },
  },
  id: "shape-2",
  name: "メモなし区域",
};

type SmokePage = {
  fileName: string;
  templateName: string;
  globals: Record<string, unknown>;
  expectedControls: readonly string[];
  expectedVisibilityLabels: readonly string[];
};

const pages: readonly SmokePage[] = [
  {
    expectedControls: [".leaflet-control-layers", ".custom-search", "#draw-toggle-btn"],
    expectedVisibilityLabels: ["マーカー", "図形", "図形名", "現在位置"],
    fileName: "map.js",
    templateName: "map.html",
    globals: {
      is_master: true,
      latitude: 35.6812,
      layer: "master-layer",
      layersFromAxum: layerRecords,
      longitude: 139.7671,
      markerId: "0",
      markersFromAxum: markerRecords,
      shapesFromAxum: [],
      tileServers,
      zoom: 8,
    },
  },
  {
    expectedControls: [
      ".leaflet-control-layers",
      ".marker-search-input",
      "#draw-toggle-btn",
      ".map-ui-visibility-toggle-control",
    ],
    expectedVisibilityLabels: ["マーカー", "図形", "図形名", "現在位置"],
    fileName: "map-mobile.js",
    templateName: "map-mobile.html",
    globals: {
      is_master: true,
      latitude: 35.6812,
      layer: "master-layer",
      layersFromAxum: layerRecords,
      longitude: 139.7671,
      markerId: "0",
      markersFromAxum: markerRecords,
      shapesFromAxum: [],
      tileServers,
      zoom: 8,
    },
  },
  {
    expectedControls: [".leaflet-control-layers", ".marker-search-input"],
    expectedVisibilityLabels: ["マーカー", "図形", "図形名", "現在位置"],
    fileName: "map-anather.js",
    templateName: "map-anather.html",
    globals: {
      latitude: 37.65,
      isCluster: false,
      layersFromAxum: layerRecords,
      longitude: 138,
      markersFromAxum: markerRecords,
      shapesFromAxum: [],
      tileServers,
      zoom: 6,
    },
  },
  {
    expectedControls: [".leaflet-control-layers", ".marker-search-input"],
    expectedVisibilityLabels: ["マーカー", "現在位置"],
    fileName: "temporary-map.js",
    templateName: "temporary-map.html",
    globals: {
      isChecked: true,
      isMaster: false,
      latitude: 35.6812,
      layers: layerRecords,
      longitude: 139.7671,
      markersObj: markerRecords,
      shapesObj: {},
      tileServers,
      zoom: 8,
    },
  },
  {
    expectedControls: [
      ".leaflet-control-layers",
      ".marker-search-input",
      ".map-ui-visibility-toggle-control",
    ],
    expectedVisibilityLabels: ["マーカー", "現在位置"],
    fileName: "temporary-map-mobile.js",
    templateName: "temporary-map-mobile.html",
    globals: {
      initialIsMapUiHidden: false,
      isChecked: true,
      isMaster: false,
      latitude: 35.6812,
      layers: layerRecords,
      longitude: 139.7671,
      markersObj: markerRecords,
      shapesObj: {},
      tileServers,
      zoom: 8,
    },
  },
];

const openWindows: JSDOM[] = [];

interface SmokeLoadOptions {
  csis?: boolean;
  parentWindow?: { postMessage: ReturnType<typeof vi.fn> };
  currentPosition?: { latitude: number; longitude: number };
  lastMapView?: { latitude: number; longitude: number; zoom: number };
  savedSettings?: Record<string, string>;
  mobileAnswerMap?: boolean;
}

function readFrontendFile(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function smokeLoadPage(page: SmokePage, options: SmokeLoadOptions = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="map" style="width: 1024px; height: 768px"></div><div id="draw-status" class="is-hidden"></div></body></html>',
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: `https://example.test/map${options.mobileAnswerMap ? "?map_ui=mobile" : ""}`,
    },
  );
  openWindows.push(dom);
  const geocoderMeta = dom.window.document.createElement("meta");
  geocoderMeta.name = "geocoder-csis";
  geocoderMeta.content = String(options.csis ?? false);
  dom.window.document.head.append(geocoderMeta);
  if (options.parentWindow) {
    Object.defineProperty(dom.window, "parent", { value: options.parentWindow });
  }
  if (options.lastMapView) {
    dom.window.localStorage.setItem(
      mapViewPersistenceModule.LAST_MAP_VIEW_STORAGE_KEY,
      JSON.stringify(options.lastMapView),
    );
  }
  for (const [key, value] of Object.entries(options.savedSettings || {})) {
    dom.window.localStorage.setItem(key, value);
  }

  const mapElement = dom.window.document.getElementById("map");
  Object.defineProperties(mapElement, {
    clientHeight: { configurable: true, value: 768 },
    clientWidth: { configurable: true, value: 1024 },
  });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener() {},
      matches: false,
      removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window.navigator, "geolocation", {
    configurable: true,
    value: {
      clearWatch() {},
      watchPosition: (onSuccess: (position: GeolocationPosition) => void) => {
        if (options.currentPosition) {
          onSuccess({
            coords: {
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              latitude: options.currentPosition.latitude,
              longitude: options.currentPosition.longitude,
              speed: null,
              toJSON: () => ({}),
            },
            timestamp: 1,
            toJSON: () => ({}),
          });
        }
        return 1;
      },
    },
  });
  const readOnlyPageName = page.templateName.replace(/\.html$/, "");
  const usesTypeScriptReadOnlyEntry = [
    "map-anather",
    "form-answer-map",
    "temporary-map",
    "temporary-map-mobile",
  ].includes(readOnlyPageName);
  const bootstrap =
    readOnlyPageName === "map-anather" || readOnlyPageName === "form-answer-map"
      ? {
          initialView: {
            latitude: page.globals.latitude,
            longitude: page.globals.longitude,
            zoom: page.globals.zoom,
          },
          isCluster: page.globals.isCluster,
          layers: page.globals.layersFromAxum,
          markers: page.globals.markersFromAxum,
          page: readOnlyPageName,
          shapes: page.globals.shapesFromAxum,
          tileServers: page.globals.tileServers,
          answerPreview: page.globals.answerPreview,
        }
      : usesTypeScriptReadOnlyEntry
        ? {
            initialView: {
              latitude: page.globals.latitude,
              longitude: page.globals.longitude,
              zoom: page.globals.zoom,
            },
            isChecked: page.globals.isChecked,
            isMapUiHidden: page.globals.initialIsMapUiHidden ?? false,
            isMaster: false,
            layers: page.globals.layers,
            markers: page.globals.markersObj,
            page: readOnlyPageName,
            shapes: page.globals.shapesObj,
            tileServers: page.globals.tileServers,
          }
        : {
            page: readOnlyPageName,
            selectedLayer: page.globals.layer,
            isMaster: page.globals.is_master,
            markerId: page.globals.markerId,
            initialView: {
              latitude: page.globals.latitude,
              longitude: page.globals.longitude,
              zoom: page.globals.zoom,
            },
            tileServers: page.globals.tileServers,
            tileOverlays: [],
            tileVisibilityAccountId: "smoke-test-account",
            layers: page.globals.layersFromAxum,
            markers: page.globals.markersFromAxum,
            shapes: page.globals.shapesFromAxum,
          };
  Object.assign(bootstrap, {
    tileOverlays: page.globals.tileOverlays || [],
    tileVisibilityAccountId: "smoke-test-account",
  });
  Object.assign(dom.window, page.globals, {
    createPopupContentRuntime,
    makeSummaryDraggable,
    __GEOCODE_MAP_BOOTSTRAP__: bootstrap,
    addReadOnlyMapVisibilityControls,
    addReadOnlySearchControls,
    createMeasurementVisibilityControl,
    createMapObjectSearchCoordinator,
    createMapUiVisibilityRuntime,
    createReadOnlyLayerGroupRuntime,
    createReadOnlyShapeMeasurementDisplayRuntime,
    createReadOnlyShapeRestorationRuntime,
    createReadOnlyMarkerLayerControl,
    createReadOnlyMapRuntime,
    createTooltipVisibilityControl,
    createTileOverlayManager,
    installMarkerClustering,
    hydrateReadOnlyMarkers,
    installReadOnlyOverlayHandlers,
    ...baseModule,
    ...contentActionsModule,
    ...contentModule,
    ...mjpegCameraModule,
    ...mapObjectFocusModule,
    ...mapViewPersistenceModule,
    ...markerModule,
    ...searchModule,
    ...shapeArrowModule,
    ...shapeLayerModule,
    ...shapeMeasurementModule,
    ...shapeMemoModule,
    ...shapeRendererModule,
    ...shapeStyleModule,
    ...shapeViewportModule,
    ...storageModule,
  });

  const context = dom.getInternalVMContext();
  dependencyScripts.forEach((scriptPath) => {
    new Script(readFrontendFile(scriptPath), { filename: scriptPath }).runInContext(context);
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  // Imported modules and the vendor scripts must use the same DOM realm for
  // instanceof checks during deferred content and media initialization.
  for (const name of [
    "Event",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDetailsElement",
    "HTMLImageElement",
    "HTMLVideoElement",
    "HTMLIFrameElement",
  ] as const) {
    vi.stubGlobal(name, dom.window[name]);
  }
  vi.stubGlobal("L", (dom.window as unknown as { L: unknown }).L);
  vi.stubGlobal("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  vi.stubGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  // jsdom はレイアウトを計算しないため、実際のドラッグ処理は維持しつつ、
  // VM のウィンドウとインポート先の実行環境の両方に、ブラウザーの監視機能を補う。
  class SmokeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(dom.window, { ResizeObserver: SmokeResizeObserver });
  vi.stubGlobal("ResizeObserver", SmokeResizeObserver);
  if (usesTypeScriptReadOnlyEntry) {
    const result = initializeReadOnlyMapPage(
      readOnlyPageName as
        | "map-anather"
        | "form-answer-map"
        | "temporary-map"
        | "temporary-map-mobile",
    );
    if (readOnlyPageName === "form-answer-map") {
      finishAnswerPreview(result, bootstrap as any, (dom.window as any).L);
    }
    Object.assign(dom.window, {
      __templateSmokeRuntime: result,
      __templateSmokeMap: result.map,
      __templateSmokeMarkerCount: Object.keys(result.markers).length,
      __templateSmokeShapeLayers: result.shapeLayers,
      __templateSmokeShapeNameLabelManager: result.shapeNameLabelManager,
    });
    return dom;
  }
  const entryName = page.templateName === "map-mobile.html" ? "map-mobile" : "map";
  const implementationSource = editorRuntimeSource(entryName);
  new Script(
    `"use strict";\n${implementationSource}\nglobalThis.__templateSmokeMap = map;\nglobalThis.__templateSmokeMarkerCount = Object.keys(markers).length;\nglobalThis.__templateSmokeMarkerGroup = markersClusterGroup;`,
    { filename: page.fileName },
  ).runInContext(context);

  return dom;
}

afterEach(async () => {
  for (const dom of openWindows.splice(0)) {
    // 復元直後の遅延描画を完了させてから、ページのunload処理を実行する。
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    (dom.window as any).__templateSmokeShapeNameLabelManager?.destroy();
    (dom.window as any).__templateSmokeMap?.remove();
    dom.window.close();
  }
  vi.unstubAllGlobals();
});

describe("各地図テンプレートJavaScriptのランタイム初期化", () => {
  const clusteringPages = [
    ...pages.filter((page) =>
      ["map.html", "map-mobile.html", "map-anather.html"].includes(page.templateName),
    ),
    {
      ...pages.find((page) => page.templateName === "map-anather.html")!,
      templateName: "form-answer-map.html",
    },
  ];
  const clusteringPage = (page: SmokePage, isCluster = true): SmokePage => ({
    ...page,
    globals: {
      ...page.globals,
      isCluster,
      latitude: 35.6812,
      longitude: 139.7671,
      zoom: 14,
      markersFromAxum: {
        ...markerRecords,
        "marker-2": { ...markerRecords["marker-1"], id: "marker-2", marker_name: "Second marker" },
      },
      answerPreview:
        page.templateName === "form-answer-map.html"
          ? {
              parentOrigin: "https://example.test",
              requestId: "cluster-test",
              query: {},
              targets: ["marker:marker-1", "marker:marker-2"],
              answerCount: 2,
              targetCount: 2,
            }
          : undefined,
    },
  });

  it.each(clusteringPages)(
    "$templateNameは15以上で解除でき、縮小後は再クラスタ化する",
    async (page) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            markers: clusteringPage(page).globals.markersFromAxum,
            shapes: [],
          }),
        }),
      );
      const dom = smokeLoadPage(clusteringPage(page));
      const document = dom.window.document;
      const map = (dom.window as any).__templateSmokeMap;
      const group =
        (dom.window as any).__templateSmokeMarkerGroup ??
        (dom.window as any).__templateSmokeRuntime.visibleMarkerGroup;
      const input = document.querySelector<HTMLInputElement>(".marker-clustering-control input")!;
      // The answer entry fits its targets after initialization; start this check
      // at the zoom boundary rather than depending on that initial fit.
      map.setZoom(14, { animate: false });
      const layerLabel = [...document.querySelectorAll("label")].find(
        (label) => label.textContent?.trim() === "Test Layer",
      );
      const layerInput = layerLabel?.querySelector<HTMLInputElement>("input");
      if (layerInput && !layerInput.checked) layerInput.click();
      const markers = group.getLayers();
      expect(markers).toHaveLength(2);
      expect(input.checked).toBe(true);
      expect(input.disabled).toBe(true);
      map.setZoom(15, { animate: false });
      expect(input.disabled).toBe(false);
      input.click();
      await vi.waitFor(() => expect(group.options.disableClusteringAtZoom).toBe(15));
      expect(group.getLayers()).toEqual(expect.arrayContaining(markers));
      for (const marker of markers) expect(group.getVisibleParent(marker)).toBe(marker);
      map.setZoom(14, { animate: false });
      expect(input.checked).toBe(true);
      expect(input.disabled).toBe(true);
      await vi.waitFor(() => expect(group.options.disableClusteringAtZoom).toBeNull());
      expect(group.getVisibleParent(markers[0]).getChildCount()).toBe(2);
      map.setZoom(15, { animate: false });
      expect(input.checked).toBe(true);
      expect(input.disabled).toBe(false);
      map.removeLayer(group);
      input.click();
      await vi.waitFor(() => expect(group.options.disableClusteringAtZoom).toBe(15));
      expect(map.hasLayer(group)).toBe(false);
      expect(group.getLayers()).toEqual(expect.arrayContaining(markers));
    },
  );

  it.each(
    clusteringPages.filter((page) =>
      ["map-anather.html", "form-answer-map.html"].includes(page.templateName),
    ),
  )("$templateNameはis_cluster=falseを全ズームで優先する", (page) => {
    const dom = smokeLoadPage(clusteringPage(page, false));
    const input = dom.window.document.querySelector<HTMLInputElement>(
      ".marker-clustering-control input",
    )!;
    const runtime = (dom.window as any).__templateSmokeRuntime;
    for (const zoom of [15, 14, 16, 13]) {
      runtime.map.setZoom(zoom, { animate: false });
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(true);
      expect(runtime.getPrintState().clusteringAllowed).toBe(false);
      expect(runtime.getPrintState().clusteringEnabled).toBe(false);
    }
  });

  it.each(pages.filter((page) => page.templateName.startsWith("temporary-map")))(
    "$templateNameにはクラスタ切替を追加しない",
    (page) => {
      const dom = smokeLoadPage(page);
      expect(dom.window.document.querySelector(".marker-clustering-control")).toBeNull();
    },
  );

  it.each(pages)("$fileNameは1回の展開操作で住所候補を直接選択できる", async (page) => {
    const dom = smokeLoadPage(page);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ address: "東京都新宿区", latitude: 35.69, longitude: 139.7 }],
        }),
      }),
    );
    const document = dom.window.document;
    document.querySelector<HTMLInputElement>("#code-input")!.value = "東京都新宿区";
    document.querySelector<HTMLButtonElement>("#code-search-btn")!.click();
    const dropdown = document.querySelector<HTMLDetailsElement>(".address-results-dropdown")!;
    await vi.waitFor(() => expect(dropdown.hidden).toBe(false));
    const summary = dropdown.querySelector("summary")!;
    summary.click();
    expect(dropdown.open).toBe(true);
    expect(dropdown.querySelector("select")).toBeNull();
    const candidate = dropdown.querySelector<HTMLButtonElement>("#address-search-results button")!;
    expect(candidate.textContent).toBe("東京都新宿区");
    candidate.click();
    expect(dropdown.open).toBe(false);
    expect(summary.textContent).toBe("東京都新宿区");
    const map = (dom.window as unknown as { __templateSmokeMap: L.Map }).__templateSmokeMap;
    expect(map.getCenter().lat).toBeCloseTo(35.69);
    expect(map.getCenter().lng).toBeCloseTo(139.7);
    expect(document.querySelector(".leaflet-popup")).toBeNull();
  });

  it.each(pages)("$fileNameはCSIS利用表記をタイル切り替え後も維持する", (page) => {
    const dom = smokeLoadPage(page, { csis: true });
    const attribution = dom.window.document.querySelector(".leaflet-control-attribution")!;
    const link = attribution.querySelector<HTMLAnchorElement>(
      'a[href="https://geocode.csis.u-tokyo.ac.jp/"]',
    );
    expect(link?.textContent).toBe("CSISシンプルジオコーディング実験を利用");
    expect(attribution.textContent).toContain("Test tiles");
    dom.window.eval(`
      const replacementTile = L.tileLayer('https://example.test/{z}/{x}/{y}.png', { attribution: 'Replacement tiles' });
      __templateSmokeMap.eachLayer(layer => { if (layer instanceof L.TileLayer) __templateSmokeMap.removeLayer(layer); });
      replacementTile.addTo(__templateSmokeMap);
    `);
    expect(attribution.textContent).toContain("Replacement tiles");
    expect(attribution.textContent).not.toContain("Test tiles");
    expect(
      attribution.querySelectorAll('a[href="https://geocode.csis.u-tokyo.ac.jp/"]'),
    ).toHaveLength(1);
  });

  it("埋め込みPC地図のCtrl+Pを親に通知し、長押しとモバイルでは通知しない", () => {
    for (const templateName of ["map.html", "map-mobile.html"]) {
      const parentWindow = { postMessage: vi.fn() };
      const dom = smokeLoadPage(pages.find((page) => page.templateName === templateName)!, {
        parentWindow,
      });
      parentWindow.postMessage.mockClear();
      const press = (extra = {}) => {
        const event = new dom.window.KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          cancelable: true,
          ...extra,
        });
        dom.window.dispatchEvent(event);
        return event;
      };
      const desktop = templateName === "map.html";
      expect(press({ repeat: true }).defaultPrevented).toBe(desktop);
      expect(parentWindow.postMessage).not.toHaveBeenCalled();
      expect(press().defaultPrevented).toBe(desktop);
      press({ ctrlKey: false, metaKey: true });
      expect(parentWindow.postMessage).toHaveBeenCalledTimes(desktop ? 2 : 0);
      if (desktop)
        expect(parentWindow.postMessage).toHaveBeenLastCalledWith(
          { type: "printOpen" },
          "https://example.test",
        );
    }
  });
  it("モバイル共有地図の計測合計を複数計測ボタンの下の右上に表示する", () => {
    const page = pages.find((page) => page.templateName === "temporary-map-mobile.html")!;
    const dom = smokeLoadPage({
      ...page,
      globals: { ...page.globals, zoom: 14, shapesObj: { "shape-1": shapeRecord } },
    });
    const document = dom.window.document;
    const measurement = document.querySelector(".measurement-control")!;
    const summary = document.querySelector<HTMLElement>(".measurement-selection-summary")!;
    expect(measurement.parentElement?.classList.contains("leaflet-right")).toBe(true);
    expect(measurement.parentElement?.classList.contains("leaflet-top")).toBe(true);
    expect(measurement.nextElementSibling).toBe(summary);
    expect(document.querySelector(".leaflet-bottom.leaflet-left")?.contains(summary)).toBe(false);

    document.querySelector<HTMLButtonElement>("#measurement-toggle-btn")!.click();
    dom.window.eval(`Object.values(__templateSmokeShapeLayers)[0].fire("click");`);
    document.querySelector<HTMLButtonElement>("#measurement-selection-toggle-btn")!.click();
    expect(summary.hidden).toBe(false);
    expect(summary.textContent).toContain("合計");
    expect(measurement.nextElementSibling).toBe(summary);
    document.querySelector<HTMLButtonElement>("#measurement-toggle-btn")!.click();
    expect(summary.hidden).toBe(true);
  });

  const anotherMapPage = pages.find((page) => page.templateName === "map-anather.html")!;

  const tileSettingsPage = (answerMap = false): SmokePage => ({
    ...anotherMapPage,
    templateName: answerMap ? "form-answer-map.html" : "map-anather.html",
    globals: {
      ...anotherMapPage.globals,
      shapesFromAxum: [shapeRecord],
      tileServers: {
        ...tileServers,
        "2": {
          ...tileServers["1"],
          label: "Alternate tiles",
          layer_name: "alternate-tiles",
          url: "https://alternate.example.test/{z}/{x}/{y}.png",
        },
      },
      tileOverlays: ["flood", "rain", "new"].map((id) => ({
        id,
        name: id,
        url: `https://${id}.example.test/{z}/{x}/{y}.png`,
        attribution: id,
        min_zoom: 0,
        max_zoom: 18,
        opacity: 0.5,
        sort_order: 0,
      })),
      answerPreview: answerMap
        ? {
            parentOrigin: "https://example.test",
            requestId: "answer-tiles",
            query: { as_of: "2026-10-23T00:00:00Z" },
            targets: ["marker:marker-1", "shape:shape-1"],
            answerCount: 2,
            targetCount: 2,
          }
        : undefined,
    },
  });

  it.each(["2", "removed"])("全画面地図は保存した背景タイル%sを検証して復元する", (selected) => {
    const dom = smokeLoadPage(tileSettingsPage(), {
      savedSettings: { "geocode-web:selected-tile-server-id": selected },
    });
    const expected = selected === "2" ? "2" : "1";
    expect(dom.window.document.querySelector<HTMLInputElement>(".tile-radio:checked")!.value).toBe(
      expected,
    );
    const runtime = (dom.window as any).__templateSmokeRuntime;
    expect(runtime.getPrintState().tileServerId).toBe(expected);
    const urls: string[] = [];
    runtime.map.eachLayer((layer: any) => {
      if (layer._url) urls.push(layer._url);
    });
    expect(urls).toContain(
      expected === "2" ? "https://alternate.example.test/{z}/{x}/{y}.png" : tileServers["1"].url,
    );
  });

  it.each(["temporary-map.html", "temporary-map-mobile.html"])(
    "%sは所有者向けの背景設定を読み込まない",
    (templateName) => {
      const shared = pages.find((page) => page.templateName === templateName)!;
      const settings = tileSettingsPage().globals;
      const savedSettings = {
        "geocode-web:selected-tile-server-id": "2",
        "geocode-web:tile-overlay-visibility:smoke-test-account": '{"flood":false}',
      };
      const dom = smokeLoadPage(
        {
          ...shared,
          globals: {
            ...shared.globals,
            tileServers: settings.tileServers,
            tileOverlays: settings.tileOverlays,
          },
        },
        { savedSettings },
      );
      const state = (dom.window as any).__templateSmokeRuntime.getPrintState();
      expect(state).toMatchObject({
        tileServerId: "1",
        overlays: { flood: true, rain: true, new: true },
      });
      for (const [key, value] of Object.entries(savedSettings)) {
        expect(dom.window.localStorage.getItem(key)).toBe(value);
      }
    },
  );

  it.each([false, true])(
    "回答地図は背景だけを読み取り、操作後も通常地図の保存設定を変更しない（mobile=%s）",
    (mobileAnswerMap) => {
      const savedSettings = {
        "geocode-web:selected-tile-server-id": "2",
        "geocode-web:tile-overlay-visibility:smoke-test-account":
          '{"flood":false,"rain":true,"removed":false}',
        "geocode-web:tile-overlay-visibility:other-account": '{"flood":true,"rain":false}',
        "geocode-web:marker-visible": "false",
        "geocode-web:shape-layer-visible": "false",
        "geocode-web:shape-name-visible": "false",
      };
      const dom = smokeLoadPage(tileSettingsPage(true), {
        mobileAnswerMap,
        savedSettings,
        lastMapView: { latitude: 34, longitude: 135, zoom: 6 },
      });
      const runtime = (dom.window as any).__templateSmokeRuntime;
      const initial = runtime.getPrintState();
      expect(initial).toMatchObject({
        tileServerId: "2",
        overlays: { flood: false, rain: true, new: true },
        markersVisible: true,
        shapesVisible: true,
        shapeNamesVisible: true,
      });
      expect(initial.view.longitude).toBeGreaterThan(139);
      expect(initial.view.zoom).toBeGreaterThan(6);
      expect(dom.window.document.body.classList.contains("map-mobile-controls")).toBe(
        mobileAnswerMap,
      );
      const radio = dom.window.document.querySelector<HTMLInputElement>('.tile-radio[value="1"]')!;
      radio.checked = true;
      radio.dispatchEvent(new dom.window.Event("change"));
      for (const name of ["flood", "rain"]) {
        const label = [
          ...dom.window.document.querySelectorAll(".leaflet-control-layers label"),
        ].find((label) => label.textContent?.trim() === name)!;
        label.querySelector<HTMLInputElement>("input")!.click();
      }
      runtime.map.setView([36, 140], 10);
      expect(runtime.getPrintState()).toMatchObject({
        tileServerId: "1",
        overlays: { flood: true, rain: false, new: true },
        view: { latitude: 36, longitude: 140, zoom: 10 },
      });
      for (const [key, value] of Object.entries(savedSettings)) {
        expect(dom.window.localStorage.getItem(key)).toBe(value);
      }
      expect(
        JSON.parse(
          dom.window.localStorage.getItem(mapViewPersistenceModule.LAST_MAP_VIEW_STORAGE_KEY)!,
        ),
      ).toEqual({ latitude: 34, longitude: 135, zoom: 6 });
    },
  );

  const editorShapes = () =>
    [
      { id: "near", longitude: 139.767, latitude: 35.681, extent: 0.001 },
      { id: "far", longitude: 135.5, latitude: 34.69, extent: 0.001 },
      { id: "tiny", longitude: 139.767, latitude: 35.681, extent: 0.0000001 },
    ].map(({ id, longitude, latitude, extent }) => ({
      id,
      layer_id: "layer-1",
      name: id,
      shape_type: "polyline",
      geojson: {
        type: "Feature",
        properties: { memo: "pipe" },
        geometry: {
          type: "LineString",
          coordinates: [
            [longitude, latitude],
            [longitude + extent, latitude],
          ],
        },
      },
    }));
  const editorState = (dom: JSDOM) =>
    new Script(
      "({map, shapeRenderManager, drawnShapesGroup, applyShapeUpdateFromParent, applyMarkerUpdateFromParent, applyMarkerDeleteFromParent, applyShapeDeleteFromParent, applyEditorMapSnapshot, createShapeLayer, saveShape, deleteShape, undoDeletedShape})",
    ).runInContext(dom.getInternalVMContext()) as any;
  it.each(["map.html", "map-mobile.html"])(
    "%sは親の原本スナップショットを再取得なしで適用し、遅延描画と差分追加・削除を維持する",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, markersFromAxum: {}, shapesFromAxum: [] } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
      );
      const state = editorState(dom);
      const fetch = vi.fn();
      Object.assign(dom.window, { fetch });
      const records = editorShapes().map((record) => ({
        ...record,
        created_at: "2026-10-27T00:00:00",
        updated_at: "2026-10-27T00:00:00",
        user_id: "account",
      }));
      expect(
        await state.applyEditorMapSnapshot({
          markers: structuredClone(markerRecords),
          shapes: records,
        }),
      ).toBe(true);
      await state.shapeRenderManager.whenIdle();
      expect(state.shapeRenderManager.getStats().recordCount).toBe(3);
      expect(state.shapeRenderManager.getStats().createdCount).toBe(1);
      new Script(
        'isTooltipVisible = true; measurementSelectedShapes.add(shapeRenderManager.getLayer("near")); measurementSelectionType = "polyline";',
      ).runInContext(dom.getInternalVMContext());
      state.applyMarkerUpdateFromParent({
        objectType: "marker",
        object: { ...markerRecords["marker-1"], marker_name: "restored label" },
      });
      expect(
        new Script('markers["marker-marker-1"].isTooltipOpen()').runInContext(
          dom.getInternalVMContext(),
        ),
      ).toBe(true);
      const originalSelected = state.shapeRenderManager.getLayer("near");
      expect(
        await state.applyEditorMapSnapshot({
          markers: structuredClone(markerRecords),
          shapes: structuredClone(records),
        }),
      ).toBe(true);
      await state.shapeRenderManager.whenIdle();
      expect(
        new Script("measurementSelectedShapes.size").runInContext(dom.getInternalVMContext()),
      ).toBe(1);
      expect(
        new Script("[...measurementSelectedShapes][0]").runInContext(dom.getInternalVMContext()),
      ).toBe(state.shapeRenderManager.getLayer("near"));
      expect(state.shapeRenderManager.getLayer("near")).not.toBe(originalSelected);
      const added = {
        ...records[0],
        id: "added",
        name: "canonical",
        updated_at: "2026-10-27T01:00:00",
      };
      expect(state.applyShapeUpdateFromParent({ objectType: "shape", object: added })).toBe(true);
      await state.shapeRenderManager.whenIdle();
      expect(state.shapeRenderManager.getRecord("added").updated_at).toBe(added.updated_at);
      expect(state.applyShapeDeleteFromParent("added")).toBe(true);
      expect(state.applyShapeDeleteFromParent("added")).toBe(true);
      expect(state.shapeRenderManager.getRecord("added")).toBeNull();
      const newMarker = {
        ...markerRecords["marker-1"],
        id: "new-marker",
        marker_name: "canonical marker",
      };
      expect(state.applyMarkerUpdateFromParent({ objectType: "marker", object: newMarker })).toBe(
        true,
      );
      expect(state.applyMarkerDeleteFromParent("new-marker")).toBe(true);
      expect(state.applyMarkerDeleteFromParent("new-marker")).toBe(true);
      expect(await state.applyEditorMapSnapshot({ markers: {}, shapes: [] })).toBe(true);
      await state.shapeRenderManager.whenIdle();
      expect(state.shapeRenderManager.getStats().recordCount).toBe(0);
      expect(state.drawnShapesGroup.getLayers()).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["map.html", "map-mobile.html"])(
    "%sは保存を親へ委譲し、保存済みレコードを再取得なしで差分通知する",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const parentWindow = { postMessage: vi.fn() };
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: [] } },
        { parentWindow },
      );
      const canonical = {
        ...editorShapes()[0],
        id: "saved",
        user_id: "account",
        created_at: "server-created",
        updated_at: "server-updated",
      };
      (dom.window as any).__GEOCODE_MAP_BOOTSTRAP__.dataSource = "parent";
      const fetch = vi.fn();
      Object.assign(dom.window, { fetch });
      parentWindow.postMessage.mockImplementation((message) => {
        const data =
          message.type === "mapObjectWriteRequested"
            ? {
                type: "mapObjectWriteResult",
                runtimeId: message.runtimeId,
                requestId: message.request.requestId,
                status: 201,
                data: { id: canonical.id, message: "success", object: canonical },
              }
            : message.type === "mapObjectChanged"
              ? {
                  type: "mapObjectChangedResult",
                  runtimeId: message.runtimeId,
                  mutationId: message.change.mutationId,
                  success: true,
                }
              : null;
        if (data)
          queueMicrotask(() =>
            dom.window.dispatchEvent(
              new dom.window.MessageEvent("message", {
                origin: "https://example.test",
                source: parentWindow as any,
                data,
              }),
            ),
          );
      });
      const state = editorState(dom);
      const line = state.createShapeLayer("polyline", canonical.geojson, "pipe");
      await state.saveShape("polyline", line, "pipe", "layer-1");
      await state.shapeRenderManager.whenIdle();
      const write = parentWindow.postMessage.mock.calls.find(
        ([message]) => message.type === "mapObjectWriteRequested",
      )![0];
      expect(write.request).toMatchObject({
        method: "POST",
        url: "/shape",
        body: { layer_id: "layer-1" },
      });
      const delta = parentWindow.postMessage.mock.calls.find(
        ([message]) => message.type === "mapObjectChanged",
      )![0];
      expect(delta.change.object.updated_at).toBe("server-updated");
      expect(state.shapeRenderManager.getRecord("saved").updated_at).toBe("server-updated");
      expect(fetch).not.toHaveBeenCalled();
      expect(
        parentWindow.postMessage.mock.calls.some(
          ([message]) => message.type === "callParentReload",
        ),
      ).toBe(false);
    },
  );

  it("親から受信した4万件も全件をLeaflet化せず原本へ登録する", async () => {
    const page = pages[0]!;
    const dom = smokeLoadPage(
      { ...page, globals: { ...page.globals, markersFromAxum: {}, shapesFromAxum: [] } },
      { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
    );
    const state = editorState(dom);
    const far = editorShapes()[1]!;
    const shapes = Array.from({ length: 40000 }, (_, i) => ({ ...far, id: "far-" + i }));
    expect(await state.applyEditorMapSnapshot({ markers: {}, shapes })).toBe(true);
    await state.shapeRenderManager.whenIdle();
    expect(state.shapeRenderManager.getStats()).toMatchObject({
      recordCount: 40000,
      createdCount: 0,
      pendingCount: 0,
    });
  }, 15000);

  it.each(["map.html", "map-mobile.html"])(
    "%sは範囲外・微小図形を初期生成せず、移動・ズームで必要な図形だけ表示する",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: editorShapes() } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
      );
      const state = editorState(dom),
        manager = state.shapeRenderManager;
      await manager.whenIdle();
      expect(manager.getStats().recordCount).toBe(3);
      expect(manager.getStats().createdCount).toBe(1);
      expect(manager.getLayer("near")).not.toBeNull();
      expect(manager.getLayer("far")).toBeNull();
      expect(manager.getLayer("tiny")).toBeNull();
      const near = manager.getLayer("near");
      state.map.setView([34.69, 135.5], 14, { animate: false });
      await manager.whenIdle();
      expect(state.map.hasLayer(near)).toBe(false);
      expect(state.map.hasLayer(manager.getLayer("far"))).toBe(true);
      state.map.setView([35.681, 139.767], 5, { animate: false });
      await manager.whenIdle();
      expect(manager.getStats().renderedCount).toBe(0);
    },
  );
  it.each(["map.html", "map-mobile.html"])(
    "%sは縮尺別に図形を省略し、計測選択・検索フォーカス中の図形を保持する",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const records = [
        ["overview", 7, 10],
        ["middle", 5, 11],
        ["large", 12, 10],
      ].map(([id, pixels, zoom]) => {
        const width = (Number(pixels) * 360) / (256 * 2 ** Number(zoom));
        return {
          ...editorShapes()[0],
          id: String(id),
          name: "",
          geojson: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [139.767 - width / 2, 35.681],
                [139.767 + width / 2, 35.681],
              ],
            },
          },
        };
      });
      const original = JSON.stringify(records);
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, markersFromAxum: {}, shapesFromAxum: records } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 10 } },
      );
      const state = editorState(dom),
        manager = state.shapeRenderManager;
      await manager.whenIdle();
      expect(manager.getStats()).toMatchObject({ eligibleCount: 3, renderedCount: 1 });
      for (const [zoom, renderedCount] of [
        [11, 2],
        [14, 3],
      ]) {
        state.map.setView([35.681, 139.767], zoom, { animate: false });
        await manager.whenIdle();
        expect(manager.getStats().renderedCount).toBe(renderedCount);
      }
      const middle = manager.getLayer("middle");
      new Script(
        'isTooltipVisible = true; measurementSelectedShapes.add(shapeRenderManager.getLayer("middle")); measurementSelectionType = "polyline";',
      ).runInContext(dom.getInternalVMContext());
      state.map.setView([35.681, 139.767], 10, { animate: false });
      await manager.whenIdle();
      expect(manager.getStats().renderedCount).toBe(2);
      expect(manager.getLayer("middle")).toBe(middle);
      expect(state.map.hasLayer(middle)).toBe(true);
      new Script("measurementSelectedShapes.clear();").runInContext(dom.getInternalVMContext());
      manager.refresh();
      await manager.whenIdle();
      expect(manager.getStats().renderedCount).toBe(1);
      new Script('focusMapObject("shape", "overview", 35.681, 139.767);').runInContext(
        dom.getInternalVMContext(),
      );
      await manager.whenIdle();
      state.map.setView([35.681, 139.767], 10, { animate: false });
      await manager.whenIdle();
      expect(manager.getStats()).toMatchObject({
        recordCount: 3,
        eligibleCount: 3,
        renderedCount: 2,
      });
      expect(state.map.hasLayer(manager.getLayer("overview"))).toBe(true);
      expect(manager.getStats().createdCount).toBe(3);
      expect(JSON.stringify(records)).toBe(original);
    },
  );

  it.each(["map.html", "map-mobile.html"])(
    "%sは追加・再表示した図形の編集カーソルを現在のモードと図形種別に合わせる",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const circle = {
        ...shapeRecord,
        id: "circle",
        shape_type: "circle",
        geojson: {
          type: "Feature",
          properties: { radius: 200 },
          geometry: { type: "Point", coordinates: [139.767, 35.681] },
        },
      };
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: [...editorShapes(), circle] } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
      );
      const state = new Script(
        "({map,shapeRenderManager,setShapeGeometryEditingMode})",
      ).runInContext(dom.getInternalVMContext()) as any;
      const manager = state.shapeRenderManager;
      await manager.whenIdle();
      const near = manager.getLayer("near");
      const hasEditCursor = (layer: any) =>
        layer.getElement()?.classList.contains("is-shape-vertex-add-target");
      expect(hasEditCursor(near)).toBe(false);
      state.setShapeGeometryEditingMode("input");
      expect(hasEditCursor(near)).toBe(true);
      expect(hasEditCursor(manager.getLayer("circle"))).toBe(false);
      state.map.setView([34.69, 135.5], 14, { animate: false });
      await manager.whenIdle();
      expect(state.map.hasLayer(near)).toBe(false);
      state.setShapeGeometryEditingMode("view");
      state.map.setView([35.681, 139.767], 14, { animate: false });
      await manager.whenIdle();
      expect(manager.getLayer("near")).toBe(near);
      expect(hasEditCursor(near)).toBe(false);
    },
  );
  const shapeVisibilityPageNames = ["map.html", "map-mobile.html", "map-anather.html"];
  const initialShapeVisibilityCases = [
    ...[2000, 2001, 10000].map((count) => ({
      count,
      savedShapes: undefined,
      savedNames: undefined,
    })),
    ...[
      [true, true],
      [false, false],
      [true, false],
      [false, true],
    ].map(([savedShapes, savedNames]) => ({ count: 2001, savedShapes, savedNames })),
  ];
  const shapeVisibilityInput = (dom: JSDOM, name: string) =>
    [...dom.window.document.querySelectorAll(".leaflet-control-layers label")]
      .find((label) => label.textContent?.trim() === name)!
      .querySelector<HTMLInputElement>("input")!;
  const shapeRuntime = (dom: JSDOM, templateName: string) =>
    templateName === "map-anather.html"
      ? {
          map: (dom.window as any).__templateSmokeRuntime.map,
          manager: (dom.window as any).__templateSmokeRuntime.shapeRenderer,
        }
      : { map: editorState(dom).map, manager: editorState(dom).shapeRenderManager };
  const selectReadOnlyShapeGroup = (dom: JSDOM, templateName: string) => {
    if (templateName !== "map-anather.html") return;
    // 別画面は所属レイヤを初期OFFにするため、選択後の遅延描画も確認する。
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) => new Response(JSON.stringify(url.startsWith("/shapes") ? [] : {})),
      ),
    );
    shapeVisibilityInput(dom, "Test Layer").click();
  };
  it.each(
    shapeVisibilityPageNames.flatMap((templateName) =>
      initialShapeVisibilityCases.map((test) => ({ templateName, ...test })),
    ),
  )(
    "$templateNameは件数で初期表示を抑止せず保存設定を維持する（$count件・図形$savedShapes・名前$savedNames）",
    async ({ templateName, count, savedShapes, savedNames }) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const [near, far, tiny] = editorShapes();
      const shapes = [
        near!,
        tiny!,
        ...Array.from({ length: count - 2 }, (_, i) => ({ ...far!, id: "far-" + i })),
      ];
      const savedSettings: Record<string, string> = {};
      if (savedShapes !== undefined)
        savedSettings["geocode-web:shape-layer-visible"] = String(savedShapes);
      if (savedNames !== undefined)
        savedSettings["geocode-web:shape-name-visible"] = String(savedNames);
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: shapes } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 }, savedSettings },
      );
      const { manager } = shapeRuntime(dom, templateName);
      await manager.whenIdle();
      if (templateName === "map-anather.html") expect(manager.getStats().createdCount).toBe(0);
      selectReadOnlyShapeGroup(dom, templateName);
      await manager.whenIdle();
      const shapesVisible = savedShapes ?? true;
      const namesVisible = savedNames ?? true;
      expect(shapeVisibilityInput(dom, "図形").checked).toBe(shapesVisible);
      expect(shapeVisibilityInput(dom, "図形名").checked).toBe(namesVisible);
      expect(manager.getStats()).toMatchObject({
        recordCount: count,
        renderedCount: shapesVisible ? 1 : 0,
        createdCount: shapesVisible ? 1 : 0,
      });
      expect(manager.getLayer("far-0")).toBeNull();
      expect(manager.getLayer("tiny")).toBeNull();
      const names = () =>
        [...dom.window.document.querySelectorAll(".shape-name-tooltip")].map((element) =>
          element.textContent?.trim(),
        );
      await vi.waitFor(() =>
        expect(names()).toEqual(shapesVisible && namesVisible ? ["near"] : []),
      );
      expect(dom.window.localStorage.getItem("geocode-web:shape-layer-visible")).toBe(
        savedShapes === undefined ? null : String(savedShapes),
      );
      expect(dom.window.localStorage.getItem("geocode-web:shape-name-visible")).toBe(
        savedNames === undefined ? null : String(savedNames),
      );
    },
  );
  it.each(
    shapeVisibilityPageNames.flatMap((templateName) =>
      ["move", "hide"].map((action) => ({ templateName, action })),
    ),
  )(
    "$templateNameは大量図形の初期生成中でも操作に追従する（$action）",
    async ({ templateName, action }) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const [near, far] = editorShapes();
      const shapes = [
        ...Array.from({ length: 3000 }, (_, i) => ({ ...near!, id: "near-" + i, name: "" })),
        far!,
      ];
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: shapes } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
      );
      const { map, manager } = shapeRuntime(dom, templateName);
      selectReadOnlyShapeGroup(dom, templateName);
      const initial = manager.getStats();
      expect(initial.pendingCount).toBeGreaterThan(0);
      expect(initial.createdCount).toBeLessThan(3000);
      if (action === "hide") {
        shapeVisibilityInput(dom, "図形").click();
        await manager.whenIdle();
        expect(manager.getStats().renderedCount).toBe(0);
        expect(manager.getStats().createdCount).toBe(initial.createdCount);
      } else {
        map.setView([34.69, 135.5], 5, { animate: false });
        await manager.whenIdle();
        expect(manager.getStats().renderedCount).toBe(0);
        expect(manager.getStats().createdCount).toBe(initial.createdCount);
        map.setView([34.69, 135.5], 14, { animate: false });
        await manager.whenIdle();
        expect(manager.getStats().renderedCount).toBe(1);
        expect(manager.getStats().createdCount).toBe(initial.createdCount + 1);
        expect(map.hasLayer(manager.getLayer("far"))).toBe(true);
      }
      expect(manager.getStats().inactiveCachedCount).toBeLessThanOrEqual(256);
      expect(manager.getStats().inactiveCachedVertices).toBeLessThanOrEqual(50000);
    },
  );
  it.each(["map.html", "map-mobile.html"])(
    "%sは未生成図形の親更新を保持し、後の描画へ反映する",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const shapes = editorShapes();
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: shapes } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 14 } },
      );
      const state = editorState(dom),
        manager = state.shapeRenderManager;
      await manager.whenIdle();
      expect(manager.getLayer("far")).toBeNull();
      const geojson = structuredClone(shapes[1]!.geojson);
      geojson.properties.memo = "updated memo";
      expect(
        state.applyShapeUpdateFromParent({
          id: "far",
          layerId: "layer-1",
          shapeType: "polyline",
          name: "updated",
          geojson,
        }),
      ).toBe(true);
      expect(manager.getRecord("far").name).toBe("updated");
      expect(manager.getLayer("far")).toBeNull();
      state.map.setView([34.69, 135.5], 16, { animate: false });
      await manager.whenIdle();
      expect(manager.getLayer("far").shapeName).toBe("updated");
      expect(manager.getLayer("far").shapeMemo).toBe("updated memo");
    },
  );

  it.each(["map.html", "map-mobile.html"])(
    "%sは新規作成とUndoの微小図形もmanagerで追跡し、次の移動で通常判定へ戻す",
    async (templateName) => {
      const page = pages.find((page) => page.templateName === templateName)!;
      const dom = smokeLoadPage(
        { ...page, globals: { ...page.globals, shapesFromAxum: [] } },
        { lastMapView: { latitude: 35.681, longitude: 139.767, zoom: 5 } },
      );
      let created = 0;
      Object.assign(dom.window, {
        fetch: vi.fn(async (url: string) => ({
          ok: true,
          json: async () => ({ id: "created-" + ++created }),
        })),
      });
      const state = editorState(dom),
        manager = state.shapeRenderManager;
      const shape = state.createShapeLayer("polyline", editorShapes()[2]!.geojson, "new pipe");
      await state.saveShape("polyline", shape, "new pipe", "layer-1");
      await manager.whenIdle();
      expect(state.map.hasLayer(shape)).toBe(true);
      expect(manager.getStats().renderedCount).toBe(1);
      state.map.setView([35.69, 139.77], 5, { animate: false });
      await manager.whenIdle();
      expect(state.map.hasLayer(shape)).toBe(false);
      expect(manager.getStats().renderedCount).toBe(0);
      expect(await state.deleteShape(shape)).toBe(true);
      expect(manager.getRecord("created-1")).toBeNull();
      await state.undoDeletedShape();
      await manager.whenIdle();
      const restored = manager.getLayer("created-2");
      expect(restored).not.toBeNull();
      expect(state.map.hasLayer(restored)).toBe(true);
      state.map.setView([35.7, 139.78], 5, { animate: false });
      await manager.whenIdle();
      expect(state.map.hasLayer(restored)).toBe(false);
      expect(manager.getStats().renderedCount).toBe(0);
    },
  );

  it.each(["map.html", "map-mobile.html"])(
    "%sは親画面の要求に現在の中心とズームを返す",
    (templateName) => {
      const dom = smokeLoadPage(pages.find((page) => page.templateName === templateName)!);
      const map = (dom.window as any).__templateSmokeMap;
      map.setView([34.6937, 135.5023], 14, { animate: false });
      const post = vi.spyOn(dom.window, "postMessage").mockImplementation(() => {});
      const request = (origin: string, source: typeof dom.window | null = dom.window) =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            origin,
            source,
            data: { type: "mapViewRequest", requestId: "view-test" },
          }),
        );
      request("https://invalid.test");
      request("https://example.test", null);
      expect(post).not.toHaveBeenCalled();
      request("https://example.test");
      expect(post).toHaveBeenCalledExactlyOnceWith(
        {
          type: "mapViewResult",
          requestId: "view-test",
          view: { latitude: 34.6937, longitude: 135.5023, zoom: 14 },
        },
        "https://example.test",
      );
    },
  );

  it("PC地図は親画面からの要求に現在の印刷用状態を返す", () => {
    const dom = smokeLoadPage(pages.find((page) => page.templateName === "map.html")!);
    const post = vi.spyOn(dom.window, "postMessage").mockImplementation(() => {});
    const request = (origin: string) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin,
          source: dom.window,
          data: { type: "printStateRequest", requestId: "print-test" },
        }),
      );
    request("https://invalid.test");
    expect(post).not.toHaveBeenCalled();
    request("https://example.test");
    expect(post).toHaveBeenCalledWith(
      {
        type: "printStateResult",
        requestId: "print-test",
        state: {
          view: { latitude: 35.6812, longitude: 139.7671, zoom: 8 },
          tileServerId: "1",
          overlays: {},
          clusteringEnabled: true,
          clusteringAllowed: true,
          markersVisible: true,
          shapesVisible: true,
          shapeNamesVisible: true,
        },
      },
      "https://example.test",
    );
    (dom.window as any).__templateSmokeMap.setZoom(15, { animate: false });
    dom.window.document
      .querySelector<HTMLInputElement>(".marker-clustering-control input")!
      .click();
    request("https://example.test");
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ clusteringEnabled: false, clusteringAllowed: true }),
      }),
      "https://example.test",
    );
  });

  it("map-anatherは保存された表示位置を復元する", () => {
    const dom = smokeLoadPage(anotherMapPage, {
      lastMapView: { latitude: 34.6937, longitude: 135.5023, zoom: 12 },
    });
    const map = (dom.window as unknown as { __templateSmokeMap: L.Map }).__templateSmokeMap;

    expect(map.getCenter().lat).toBeCloseTo(34.6937);
    expect(map.getCenter().lng).toBeCloseTo(135.5023);
    expect(map.getZoom()).toBe(12);
  });

  it("map-anatherは保存位置がなければ現在位置を使用する", () => {
    const dom = smokeLoadPage(anotherMapPage, {
      currentPosition: { latitude: 35.6812, longitude: 139.7671 },
    });
    const map = (dom.window as unknown as { __templateSmokeMap: L.Map }).__templateSmokeMap;

    expect(map.getCenter().lat).toBeCloseTo(35.6812);
    expect(map.getCenter().lng).toBeCloseTo(139.7671);
    expect(map.getZoom()).toBe(16);
  });

  it("map-anatherは現在位置を取得できなければバックエンド位置を使用する", () => {
    const dom = smokeLoadPage(anotherMapPage);
    const map = (dom.window as unknown as { __templateSmokeMap: L.Map }).__templateSmokeMap;

    expect(map.getCenter().lat).toBeCloseTo(37.65);
    expect(map.getCenter().lng).toBeCloseTo(138);
    expect(map.getZoom()).toBe(6);
  });

  it("一時共有地図は保存された表示位置を使用しない", () => {
    const temporaryPage = pages.find((page) => page.templateName === "temporary-map.html")!;
    const dom = smokeLoadPage(temporaryPage, {
      lastMapView: { latitude: 34.6937, longitude: 135.5023, zoom: 12 },
    });
    const map = (dom.window as unknown as { __templateSmokeMap: L.Map }).__templateSmokeMap;

    expect(map.getCenter().lat).toBeCloseTo(35.6812);
    expect(map.getCenter().lng).toBeCloseTo(139.7671);
    expect(map.getZoom()).toBe(8);
  });

  it.each(pages)("$fileNameが本番vendorとテンプレートスクリプトで初期化できる", (page) => {
    const dom = smokeLoadPage(page);
    const runtimeWindow = dom.window as unknown as {
      L: { Map: new (...args: never[]) => unknown };
      __templateSmokeMarkerCount: number;
      __templateSmokeMap: unknown;
    };

    expect(runtimeWindow.__templateSmokeMap).toBeInstanceOf(runtimeWindow.L.Map);
    expect(dom.window.document.querySelector(".leaflet-container")).not.toBeNull();
    expect(
      dom.window.document.querySelector(".leaflet-control-attribution")?.textContent,
    ).not.toContain("CSIS");
    expect(runtimeWindow.__templateSmokeMarkerCount).toBe(1);
    page.expectedControls.forEach((selector) => {
      expect(dom.window.document.querySelector(selector), selector).not.toBeNull();
    });
  });

  it.each(pages)("$fileNameの表示切替項目が所定の順序で並ぶ", (page) => {
    const dom = smokeLoadPage(page);
    const overlayGroups = Array.from(
      dom.window.document.querySelectorAll(".leaflet-control-layers-overlays"),
    );
    const visibilityGroup = overlayGroups.find((group) => group.textContent?.includes("マーカー"));
    const labels = Array.from(visibilityGroup?.querySelectorAll("label") || []).map((label) =>
      label.textContent?.trim(),
    );

    expect(labels).toEqual(page.expectedVisibilityLabels);
  });

  it.each([
    {
      eventTypes: ["click"],
      page: {
        ...pages[2],
        globals: { ...pages[2].globals, shapesFromAxum: [shapeRecord] },
      },
    },
    {
      eventTypes: ["click"],
      page: {
        ...pages[3],
        globals: { ...pages[3].globals, shapesObj: { "shape-1": shapeRecord } },
      },
    },
    {
      eventTypes: ["touchend", "click"],
      page: {
        ...pages[4],
        globals: { ...pages[4].globals, shapesObj: { "shape-1": shapeRecord } },
      },
    },
  ])("$page.fileNameの図形名操作でMarkdownメモを開く", async ({ eventTypes, page }) => {
    const dom = smokeLoadPage(page);
    new Script(`
      (() => {
        const testShapeLayer = __templateSmokeRuntime.shapeRenderer.ensureLayer("shape-1");
        const testMap = globalThis.__templateSmokeMap || map;
        const labelManager = globalThis.__templateSmokeShapeNameLabelManager || shapeNameLabelManager;
        testShapeLayer.addTo(testMap);
        testMap.setView([35.685, 139.765], 14);
        labelManager.refresh();
      })();
    `).runInContext(dom.getInternalVMContext());
    await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));

    new Script(`
      globalThis.__shapeMemoPopupOpenCount = 0;
      (globalThis.__templateSmokeMap || map).on("popupopen", () => { globalThis.__shapeMemoPopupOpenCount += 1; });
    `).runInContext(dom.getInternalVMContext());

    const shapeNameTooltip = dom.window.document.querySelector(".shape-name-tooltip");
    expect(shapeNameTooltip).not.toBeNull();
    eventTypes.forEach((eventType) => {
      shapeNameTooltip!.dispatchEvent(new dom.window.Event(eventType, { bubbles: true }));
    });

    // Shared shape popups initialize their progressive body on the next tick.
    // Check the rendered result rather than the placeholder immediately after a tap.
    await vi.waitFor(() => {
      const content = dom.window.document.querySelector(".leaflet-popup-content");
      expect(content?.querySelector("strong")?.textContent).toBe("重要");
      expect(content?.textContent).toContain("な共有メモ");
    });
    const popupContent = dom.window.document.querySelector(".leaflet-popup-content");
    expect(popupContent?.querySelector("h1")?.textContent).toBe("避難区域");
    expect(popupContent?.querySelector("strong")?.textContent).toBe("重要");
    expect(popupContent?.querySelector("script")).toBeNull();
    expect(
      (dom.window as unknown as { __shapeMemoPopupOpenCount: number }).__shapeMemoPopupOpenCount,
    ).toBe(1);
  });

  it.each([
    {
      expectedHover: true,
      expectedLabelSuppressed: true,
      fileName: "map.js",
      page: pages[0],
      prepareSuppression: "suppressShapeLabelClick(1000);",
    },
    {
      expectedHover: false,
      expectedLabelSuppressed: false,
      fileName: "map-mobile.js",
      page: pages[1],
      prepareSuppression: "",
    },
  ])("$fileNameが画面固有の編集プロファイルを維持する", (contract) => {
    const dom = smokeLoadPage(contract.page);
    new Script(`
      ${contract.prepareSuppression}
      handleRadioChange({ target: { value: "input" } });
      globalThis.__mapEditorProfileContract = {
        bindPolylineHoverHighlight: mapEditorProfile.bindPolylineHoverHighlight,
        isShapeVisibleForMeasurement:
          mapEditorProfile.isShapeVisibleForMeasurement({ shapeId: "profile-test", options: {shapeRecord: {id:"profile-test",layer_id:"layer-1"}} }),
        shouldSuppressShapeLabelClick:
          mapEditorProfile.shouldSuppressShapeLabelClick(),
        modeDescription: document.getElementById("mode-description")?.textContent,
      };
    `).runInContext(dom.getInternalVMContext());

    const profile = (
      dom.window as unknown as {
        __mapEditorProfileContract: {
          bindPolylineHoverHighlight: boolean;
          isShapeVisibleForMeasurement: boolean;
          modeDescription: string;
          shouldSuppressShapeLabelClick: boolean;
        };
      }
    ).__mapEditorProfileContract;

    expect(profile.bindPolylineHoverHighlight).toBe(contract.expectedHover);
    expect(profile.isShapeVisibleForMeasurement).toBe(true);
    expect(profile.shouldSuppressShapeLabelClick).toBe(contract.expectedLabelSuppressed);
    expect(profile.modeDescription).toContain("入力モード");
  });

  it.each(
    [false, true].flatMap((restricted) =>
      [pages[0], pages[1]].map((page) => ({ page, restricted, fileName: page.fileName })),
    ),
  )(
    "$fileName（自由記述制限:$restricted）で頂点の追加・削除・移動ができる",
    async ({ page, restricted }) => {
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          shapesFromAxum: [structuredClone(shapeRecord)],
          layersFromAxum: {
            ...layerRecords,
            "layer-1": { ...layerRecords["layer-1"], restrict_free_text: restricted },
          },
        },
      });
      const requests: any[] = [];
      const serverShape = structuredClone(shapeRecord);
      Object.assign(dom.window, {
        fetch: vi.fn(async (url, options) => {
          requests.push({ url, options });
          if (String(url).endsWith("/geometry")) {
            const body = JSON.parse(options.body);
            serverShape.geojson.geometry.coordinates = body.coordinates;
            serverShape.shape_type = body.shape_type;
            serverShape.geojson.properties.memo = "最新の本文とフォーム回答";
          }
          return { ok: true, status: 200, json: async () => structuredClone(serverShape) };
        }),
      });
      new Script(`
      drawnShapesGroup.addTo(map);
      map.setView([35.68,139.765],18,{animate:false});
      shapeRenderManager.refresh();
      handleRadioChange({target:{value:"input"}});
      const diagnosticShape=Array.from(searchableShapeLayers).find(layer=>layer.shapeId==="shape-1");
      diagnosticShape.getElement().dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:512,clientY:384}));
      globalThis.__geometryDiagnostic={
        restricted:isShapeInputRestricted(diagnosticShape),
        inputSelected:geometryEditingShapeLayer===diagnosticShape,
        inputHandles:shapeGeometryEditHandles.getLayers().length,
      };
      __geometryDiagnostic.added=tryAddShapeVertexAtLatLng({type:"click",latlng:L.latLng(35.68,139.765),originalEvent:new MouseEvent("click")});
    `).runInContext(dom.getInternalVMContext());
      await vi.waitFor(() =>
        expect(requests.filter((r) => r.options?.method === "PUT")).toHaveLength(1),
      );
      await new Promise((r) => dom.window.setTimeout(r, 20));
      new Script(`
      __geometryDiagnostic.verticesAfterAdd=flattenShapeLatLngs(diagnosticShape.getLatLngs()).length;
      handleRadioChange({target:{value:"edit"}});
      diagnosticShape.getElement().dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:512,clientY:384}));
      __geometryDiagnostic.moveSelected=geometryEditingShapeLayer===diagnosticShape;
      __geometryDiagnostic.moveHandles=shapeGeometryEditHandles.getLayers().length;
      __geometryDiagnostic.draggable=shapeGeometryEditHandles.getLayers().every(handle=>handle.dragging.enabled());
      const diagnosticHandle=shapeGeometryEditHandles.getLayers()[0];
      diagnosticHandle.fire("dragstart");
      diagnosticHandle.setLatLng(L.latLng(35.679,139.759));
      diagnosticHandle.fire("drag");
      diagnosticHandle.fire("dragend");
    `).runInContext(dom.getInternalVMContext());
      await vi.waitFor(() =>
        expect(requests.filter((r) => r.options?.method === "PUT")).toHaveLength(2),
      );
      await vi.waitFor(() =>
        expect(new Script("isShapeGeometrySaving").runInContext(dom.getInternalVMContext())).toBe(
          false,
        ),
      );
      expect((dom.window as any).__geometryDiagnostic).toMatchObject({
        restricted,
        inputSelected: true,
        inputHandles: 3,
        added: true,
        verticesAfterAdd: 4,
        moveSelected: true,
        moveHandles: 4,
        draggable: true,
      });
      const last = JSON.parse(requests.filter((r) => r.options?.method === "PUT")[1].options.body);
      expect(last.coordinates[0][0]).toEqual([139.759, 35.679]);
      expect(last).not.toHaveProperty("geojson");
      expect(last).not.toHaveProperty("name");
      new Script(`globalThis.__deleteVertex = (async()=>{
        handleRadioChange({target:{value:"input"}});
        activateShapeForVertexAdd(diagnosticShape);
        await deleteShapeVertex(diagnosticShape,0);
        return {vertices:flattenShapeLatLngs(diagnosticShape.getLatLngs()).length,memo:diagnosticShape.shapeMemo,minimumRejected:!(await deleteShapeVertex(diagnosticShape,0))};
      })();`).runInContext(dom.getInternalVMContext());
      expect(await (dom.window as any).__deleteVertex).toMatchObject({
        vertices: 3,
        memo: "最新の本文とフォーム回答",
        minimumRejected: true,
      });
      expect(requests.filter((r) => r.options?.method === "PUT")).toHaveLength(3);
    },
  );

  it.each([pages[0], pages[1]])(
    "$fileNameの頂点保存が競合した場合は元の形状へ戻す",
    async (page) => {
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          shapesFromAxum: [structuredClone(shapeRecord)],
          layersFromAxum: {
            ...layerRecords,
            "layer-1": { ...layerRecords["layer-1"], restrict_free_text: true },
          },
        },
      });
      const fetch = vi.fn(async () => ({ ok: false, status: 409 }));
      Object.assign(dom.window, { fetch });
      new Script(`
      drawnShapesGroup.addTo(map);
      map.setView([35.685,139.765],16,{animate:false});
      shapeRenderManager.refresh();
      handleRadioChange({target:{value:"edit"}});
      const conflictShape=Array.from(searchableShapeLayers).find(layer=>layer.shapeId==="shape-1");
      selectShapeForGeometryEdit(conflictShape);
      const conflictHandle=shapeGeometryEditHandles.getLayers()[0];
      conflictHandle.fire("dragstart");conflictHandle.setLatLng(L.latLng(35.67,139.75));conflictHandle.fire("drag");conflictHandle.fire("dragend");
    `).runInContext(dom.getInternalVMContext());
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(new Script("isShapeGeometrySaving").runInContext(dom.getInternalVMContext())).toBe(
          false,
        ),
      );
      const actual = new Script("JSON.stringify(conflictShape.toGeoJSON().geometry)").runInContext(
        dom.getInternalVMContext(),
      );
      expect(JSON.parse(actual)).toEqual(shapeRecord.geojson.geometry);
      expect(dom.window.document.querySelector("#draw-status")!.textContent).toContain(
        "他の操作で形状が変更",
      );
    },
  );
  it.each([pages[0], pages[1]])(
    "$fileNameのポップアップが本番Markdown処理で自由入力とフォーム回答を切り替える",
    async (page) => {
      const body = "自由\n\n**回答**";
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          markersFromAxum: { "marker-1": { ...markerRecords["marker-1"], detail: body } },
        },
      });
      Object.assign(dom.window, {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            body,
            free_text: "自由",
            managed_markdown: "**回答**",
            sync_required: false,
          }),
        })),
      });
      new Script(
        'markers["marker-marker-1"].getPopup().setLatLng([35.68,139.76]).openOn(map);',
      ).runInContext(dom.getInternalVMContext());
      const select = dom.window.document.querySelector<HTMLSelectElement>(
        ".popup-content-toolbar select",
      )!;
      await vi.waitFor(() => expect(select.options[0].disabled).toBe(false));
      expect(select.value).toBe("normal");
      select.value = "free";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      expect(dom.window.document.querySelector(".popup-content-body")!.textContent?.trim()).toBe(
        "自由",
      );
      select.value = "answers";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      expect(dom.window.document.querySelector(".popup-content-body strong")!.textContent).toBe(
        "回答",
      );
    },
  );

  it.each([pages[0], pages[1]])("$fileNameがVue側で削除されたマーカーを完全に除去する", (page) => {
    const dom = smokeLoadPage({
      ...page,
      globals: {
        ...page.globals,
        markersFromAxum: structuredClone(markerRecords),
      },
    });
    new Script(`
      (() => {
        const marker = markers["marker-marker-1"];
        globalThis.__markerDeleteContract = {
          success: applyMarkerDeleteFromParent("marker-1"),
          markerExists: Boolean(markers["marker-marker-1"]),
          recordExists: Boolean(markersFromAxum["marker-1"]),
          clusterContainsMarker: markersClusterGroup.hasLayer(marker),
        };
      })();
    `).runInContext(dom.getInternalVMContext());

    expect(
      (
        dom.window as unknown as {
          __markerDeleteContract: {
            clusterContainsMarker: boolean;
            markerExists: boolean;
            recordExists: boolean;
            success: boolean;
          };
        }
      ).__markerDeleteContract,
    ).toEqual({
      clusterContainsMarker: false,
      markerExists: false,
      recordExists: false,
      success: true,
    });
  });

  it.each([pages[0], pages[1]])(
    "$fileNameが非表示中のフォーカス対象図形だけを表示してMarkdownメモを開く",
    (page) => {
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          shapesFromAxum: [shapeRecord, shapeWithoutMemoRecord],
        },
      });
      new Script(`
        (() => {
          map.removeLayer(drawnShapesGroup);

          focusMapObject("shape", "shape-1", 35.685, 139.765);
          const firstShape = shapeRenderManager.getLayer("shape-1");
          const firstFocus = {
            groupVisible: map.hasLayer(drawnShapesGroup),
            firstVisible: map.hasLayer(firstShape),
            secondVisible: Boolean(shapeRenderManager.getLayer("shape-2") && map.hasLayer(shapeRenderManager.getLayer("shape-2"))),
            popupText: document.querySelector(".leaflet-popup-content strong")?.textContent || "",
          };

          focusMapObject("shape", "shape-2", 35.705, 139.785);
          const secondShape = shapeRenderManager.getLayer("shape-2");
          const secondFocus = {
            firstVisible: map.hasLayer(firstShape),
            secondVisible: map.hasLayer(secondShape),
            popupVisible: Boolean(document.querySelector(".leaflet-popup-content")),
          };

          map.setView([35.695,139.775],14,{animate:false});
          drawnShapesGroup.addTo(map);
          shapeRenderManager.refresh();
          const allVisibleWhenEnabled =
            map.hasLayer(firstShape) && map.hasLayer(secondShape);
          map.removeLayer(drawnShapesGroup);
          const noneVisibleAfterDisable =
            !map.hasLayer(firstShape) && !map.hasLayer(secondShape);

          globalThis.__shapeFocusContract = {
            firstFocus,
            secondFocus,
            allVisibleWhenEnabled,
            noneVisibleAfterDisable,
          };
        })();
      `).runInContext(dom.getInternalVMContext());

      expect(
        (
          dom.window as unknown as {
            __shapeFocusContract: {
              allVisibleWhenEnabled: boolean;
              firstFocus: {
                firstVisible: boolean;
                groupVisible: boolean;
                popupText: string;
                secondVisible: boolean;
              };
              noneVisibleAfterDisable: boolean;
              secondFocus: {
                firstVisible: boolean;
                popupVisible: boolean;
                secondVisible: boolean;
              };
            };
          }
        ).__shapeFocusContract,
      ).toEqual({
        firstFocus: {
          groupVisible: false,
          firstVisible: true,
          secondVisible: false,
          popupText: "重要",
        },
        secondFocus: {
          firstVisible: false,
          secondVisible: true,
          // Empty content still exposes the content selector and an empty-state message.
          popupVisible: true,
        },
        allVisibleWhenEnabled: true,
        noneVisibleAfterDisable: true,
      });
    },
  );

  it.each([pages[0], pages[1]])(
    "$fileNameが共通処理でマーカーへ移動し図形の一時表示を解除する",
    (page) => {
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          markersFromAxum: structuredClone(markerRecords),
          shapesFromAxum: [shapeRecord],
        },
      });
      new Script(`
        (() => {
          const marker = markers["marker-marker-1"];
          map.removeLayer(drawnShapesGroup);
          focusMapObject("shape", "shape-1", 35.685, 139.765);
          const shapeLayer = shapeRenderManager.getLayer("shape-1");

          markersClusterGroup.removeLayer(marker);
          markersClusterGroup.zoomToShowLayer = (_layer, callback) => callback();
          focusMapObject(undefined, "marker-1", 35.6812, 139.7671);

          globalThis.__markerFocusContract = {
            markerRestored: markersClusterGroup.hasLayer(marker),
            markerPopupOpen: marker.isPopupOpen(),
            temporaryShapeCleared: !map.hasLayer(shapeLayer),
            zoom: map.getZoom(),
          };
        })();
      `).runInContext(dom.getInternalVMContext());

      expect(
        (
          dom.window as unknown as {
            __markerFocusContract: {
              markerPopupOpen: boolean;
              markerRestored: boolean;
              temporaryShapeCleared: boolean;
              zoom: number;
            };
          }
        ).__markerFocusContract,
      ).toEqual({
        markerRestored: true,
        markerPopupOpen: true,
        temporaryShapeCleared: true,
        zoom: 16,
      });
    },
  );

  it.each([pages[0], pages[1]])(
    "$fileNameが図形名表示を有効化せずフォーカス対象の名前だけを表示する",
    async (page) => {
      const dom = smokeLoadPage({
        ...page,
        globals: {
          ...page.globals,
          shapesFromAxum: [shapeRecord, shapeWithoutMemoRecord],
        },
      });
      new Script(`
        map.removeLayer(shapeNameVisibilityLayer);
        map.removeLayer(drawnShapesGroup);
        focusMapObject("shape", "shape-1", 35.685, 139.765);
      `).runInContext(dom.getInternalVMContext());
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 50));

      new Script(`
        globalThis.__focusedShapeNameContract = {
          nameControlVisible: map.hasLayer(shapeNameVisibilityLayer),
          tooltipText:
            document.querySelector(".shape-name-tooltip")?.textContent?.trim() || "",
          popupText:
            document.querySelector(".leaflet-popup-content strong")?.textContent || "",
          visibleShapeNameCount:
            document.querySelectorAll(".shape-name-tooltip").length,
        };
      `).runInContext(dom.getInternalVMContext());

      expect(
        (
          dom.window as unknown as {
            __focusedShapeNameContract: {
              nameControlVisible: boolean;
              popupText: string;
              tooltipText: string;
              visibleShapeNameCount: number;
            };
          }
        ).__focusedShapeNameContract,
      ).toEqual({
        nameControlVisible: false,
        tooltipText: "避難区域",
        popupText: "重要",
        visibleShapeNameCount: 1,
      });

      new Script(`
        markersClusterGroup.zoomToShowLayer = (_layer, callback) => callback();
        focusMapObject("marker", "marker-1", 35.6812, 139.7671);
        globalThis.__focusedShapeNameCleared =
          document.querySelectorAll(".shape-name-tooltip").length === 0;
      `).runInContext(dom.getInternalVMContext());
      expect(
        (dom.window as unknown as { __focusedShapeNameCleared: boolean }).__focusedShapeNameCleared,
      ).toBe(true);
    },
  );
});
