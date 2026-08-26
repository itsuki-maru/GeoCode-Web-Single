import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import { templateScriptNames, templateJsPath } from "./helpers/load-classic-script";

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
      isCluster: false,
      layersFromAxum: layerRecords,
      markersFromAxum: markerRecords,
      shapesFromAxum: [],
      tileServers,
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

function readFrontendFile(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function smokeLoadPage(page: SmokePage) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="map" style="width: 1024px; height: 768px"></div><div id="draw-status" class="is-hidden"></div></body></html>',
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://example.test/map",
    },
  );
  openWindows.push(dom);

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
      watchPosition: () => 1,
    },
  });
  Object.assign(dom.window, page.globals);

  const context = dom.getInternalVMContext();
  dependencyScripts.forEach((scriptPath) => {
    new Script(readFrontendFile(scriptPath), { filename: scriptPath }).runInContext(context);
  });
  templateScriptNames(page.templateName).forEach((scriptName) => {
    new Script(readFileSync(templateJsPath(scriptName), "utf8"), {
      filename: scriptName,
    }).runInContext(context);
  });
  new Script("globalThis.__templateSmokeMarkerCount = Object.keys(markers).length;").runInContext(
    context,
  );

  return dom;
}

afterEach(() => {
  openWindows.splice(0).forEach((dom) => dom.window.close());
});

describe("各地図テンプレートJavaScriptのランタイム初期化", () => {
  it.each(pages)("$fileNameが本番vendorとテンプレートスクリプトで初期化できる", (page) => {
    const dom = smokeLoadPage(page);
    const runtimeWindow = dom.window as unknown as {
      L: { Map: new (...args: never[]) => unknown };
      __templateSmokeMarkerCount: number;
      map: unknown;
    };

    expect(runtimeWindow.map).toBeInstanceOf(runtimeWindow.L.Map);
    expect(dom.window.document.querySelector(".leaflet-container")).not.toBeNull();
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
          mapEditorProfile.isShapeVisibleForMeasurement({ shapeId: "profile-test" }),
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
});
