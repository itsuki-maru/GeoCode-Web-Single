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
        const testShapeLayer = Object.values(shapeLayers)[0];
        testShapeLayer.addTo(map);
        map.setView([35.685, 139.765], 14);
        shapeNameLabelManager.refresh();
      })();
    `).runInContext(dom.getInternalVMContext());
    await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));

    new Script(`
      globalThis.__shapeMemoPopupOpenCount = 0;
      map.on("popupopen", () => { globalThis.__shapeMemoPopupOpenCount += 1; });
    `).runInContext(dom.getInternalVMContext());

    const shapeNameTooltip = dom.window.document.querySelector(".shape-name-tooltip");
    expect(shapeNameTooltip).not.toBeNull();
    eventTypes.forEach((eventType) => {
      shapeNameTooltip!.dispatchEvent(new dom.window.Event(eventType, { bubbles: true }));
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
          const shapeLayersById = Object.fromEntries(
            Array.from(searchableShapeLayers).map((layer) => [String(layer.shapeId), layer]),
          );
          const firstShape = shapeLayersById["shape-1"];
          const secondShape = shapeLayersById["shape-2"];
          map.removeLayer(drawnShapesGroup);

          focusMapObject("shape", "shape-1", 35.685, 139.765);
          const firstFocus = {
            groupVisible: map.hasLayer(drawnShapesGroup),
            firstVisible: map.hasLayer(firstShape),
            secondVisible: map.hasLayer(secondShape),
            popupText: document.querySelector(".leaflet-popup-content strong")?.textContent || "",
          };

          focusMapObject("shape", "shape-2", 35.705, 139.785);
          const secondFocus = {
            firstVisible: map.hasLayer(firstShape),
            secondVisible: map.hasLayer(secondShape),
            popupVisible: Boolean(document.querySelector(".leaflet-popup-content")),
          };

          drawnShapesGroup.addTo(map);
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
          popupVisible: false,
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
          const shapeLayer = Array.from(searchableShapeLayers)[0];
          const marker = markers["marker-marker-1"];
          map.removeLayer(drawnShapesGroup);
          focusMapObject("shape", "shape-1", 35.685, 139.765);

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
