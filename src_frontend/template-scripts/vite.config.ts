import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import { createBundledNotices } from "./build-license-notices";

import {
  editorEntrySources,
  type EditorEntryName,
} from "./src/entries/editor-entry-sources";

const editorVirtualPrefix = "virtual:geocode-editor:";
const templateScriptsDirectory = fileURLToPath(new URL("./", import.meta.url));

export const editorCommonPrelude = `
import { createMapXssOptions, sanitizeMapHtml } from "/src/map/common/markdown-sanitizer.ts";
import { createPopupContentRuntime } from "/src/map/common/popup-content.ts";
let popupContent;
import { installAnswerColoring, isAnswerColoring } from "/src/map/answer-coloring.ts";
import { createColorLegend } from "/src/map/common/color-legend.ts";
let editorColoring;
const editorColorShapeLayers = {};
import { makeSummaryDraggable } from "/src/map/common/draggable-summary.ts";
import { bindFloatingMeasurementLabels } from "/src/map/common/floating-measurement-labels.ts";
import { renderCameraImage, installMjpegCameras } from "/src/map/common/mjpeg-camera.ts";
import { createTileOverlayManager } from "/src/map/common/tile-overlays.ts";
import { installMarkerClustering } from "/src/map/common/marker-clustering.ts";
import { createLayerBulkToggleControl, extractYouTubeId } from "/src/map/common/base.ts";
import { installMapContentActions, resolveSameOriginContentUrl } from "/src/map/common/content-actions.ts";
import { createNestedTokenizer, isLocalhost, isPDF, isValidCoordinate, renderProgressiveMarkdown, renderIframe, setupDetailsLazyImages } from "/src/map/common/content.ts";
import { createMapObjectFocusController } from "/src/map/common/map-object-focus.ts";
import { loadLastMapView, observeMapView } from "/src/map/common/map-view-persistence.ts";
import { createMarkerPopupRuntime, enableMarkerIconFallback, escapeHtml, initializeUserLocation, markerOptionsForLayer } from "/src/map/common/marker.ts";
import { createLayeredMarkerDisplayManager, createLayeredShapeDisplayManager, createMapSearchRuntime, filterMeasurementMarkersForBounds, getShapeRecords, matchesMarkerSearch, matchesShapeSearch, normalizeMarkerSearchText, resetMapSearchStatus } from "/src/map/common/search.ts";
import { createShapeArrowRuntime } from "/src/map/common/shape-arrow.ts";
import { createShapeLayerRuntime } from "/src/map/common/shape-layer.ts";
import { createShapeRenderManager } from "/src/map/common/shape-renderer.ts";
import { createShapeMeasurementRuntime } from "/src/map/common/shape-measurement.ts";
import { SHAPE_MEMO_MAX_LENGTH, createShapeMemoRuntime, getShapeMemoFromGeoJson, normalizeShapeMemo, normalizeShapeName } from "/src/map/common/shape-memo.ts";
import { SHAPE_ARROW_TYPE_OPTIONS, SHAPE_LINE_TYPE_OPTIONS, SHAPE_WEIGHT_MAX, SHAPE_WEIGHT_MIN, createShapeStyleCore } from "/src/map/common/shape-style.ts";
import { createShapeViewportRuntime } from "/src/map/common/shape-viewport.ts";
import { createMapStorage } from "/src/map/common/storage.ts";
import { createBasemapController, getBasemapController, installBasemapController } from "/src/map/common/basemap-controller.ts";
import { createMapMessageDialog } from "/src/map/common/map-message-dialog.ts";

function renderMapMarkdown(markdown, links) {
  return renderProgressiveMarkdown(markdown, (html) => renderIframe(sanitizeMapHtml(html, filterXSS, xssOptions)), links);
}

const {
  enableTileServerSelectionPersistence,
  getDefaultTileServerId,
  getInitialMapMobileUiHidden,
  getInitialMarkerVisibility,
  getInitialShapeLayerVisibility,
  getInitialShapeNameVisibility,
  getInitialTileServerId,
  getInitialUserLocationVisibility,
  saveMapMobileUiHidden,
  saveMarkerVisibility,
  saveSelectedTileServerId,
  saveShapeLayerVisibility,
  saveShapeNameVisibility,
  saveUserLocationVisibility,
} = createMapStorage(tileServers);

function syncEditorBasemapSelection(id) {
  document.querySelectorAll(".tile-radio").forEach((radio) => {
    radio.checked = radio.value === id;
  });
}

let editorBasemapErrorDialog;
function showEditorBasemapError() {
  if (!editorBasemapErrorDialog) {
    editorBasemapErrorDialog = createMapMessageDialog();
    map.on("unload", () => editorBasemapErrorDialog.dispose());
  }
  editorBasemapErrorDialog.show("背景地図を読み込めませんでした。現在の背景地図を維持します。", "背景地図の読み込みエラー");
}

function handleTileChange(event) {
  const controller = getBasemapController(map);
  const id = event.target?.value;
  if (!controller || !id) return;
  void controller.select(id);
  syncEditorBasemapSelection(controller.getSelectedId());
}

function handleTileClick(event) {
  const controller = getBasemapController(map);
  if (controller?.isPending() && event.target?.value === controller.getSelectedId())
    handleTileChange(event);
}

const {
  getDefaultShapeStyle,
  getShapeDashArray,
  getShapeLineTypeFromDashArray,
  getShapeStyleFromGeoJson,
  normalizeDashArrayValue,
  normalizeShapeArrowType,
  normalizeShapeColor,
  normalizeShapeDashArray,
  normalizeShapeLineType,
  normalizeShapeWeight,
} = createShapeStyleCore(() => SHAPE_STYLE);

const {
  applyShapeArrowStyle,
  bindPolylineHoverHighlight,
  bindShapeArrowStyle,
  ensureShapeArrowMarker,
  getShapeArrowMarkerId,
} = createShapeArrowRuntime({
  getDefaultStyle: () => SHAPE_STYLE,
  normalizeShapeArrowType,
  normalizeShapeColor,
  normalizeShapeWeight,
});

const {
  createViewportShapeLabelManager,
  createViewportShapeMeasurementManager,
} = createShapeViewportRuntime();

const {
  attachShapeMemoPopup,
  attachShapeMemoTooltipOpen,
  openShapeMemoPopup,
  releaseLayer: releaseShapeMemoLayer,
  isShapePopupOpen: isEditorShapePopupOpen,
  renderShapeMemoPopupContent,
} = createShapeMemoRuntime({
  renderPopup: (layer) => popupContent.render({kind: "shape", id: layer.shapeId, name: layer.shapeName || "", body: layer.shapeMemo || ""}),
  escapeHtml,
  getLeaflet: () => L,
  getMap: () => map,
  renderIframe,
  renderMarkdown: renderMapMarkdown,
  sanitizeHtml: (html) => sanitizeMapHtml(html, filterXSS, xssOptions),
  setupDetailsLazyImages: (root) => setupDetailsLazyImages(root, renderMapMarkdown),
});

const {
  buildMeasurementLabelHtml,
  calculateProjectedPolygonArea,
  createGroupedSegmentEndpointMarkers,
  createGroupedSegmentMeasurementMarkers,
  createMeasurementLabelMarker,
  createMeasurementVertexMarker,
  formatArea,
  formatDistance,
  getCircleRadiusFromGeoJson,
  getMeasurementVertexLatLngs,
  getPolylineCenterLatLng,
  getSegmentGroupCenterLatLng,
  getSegmentMidpoint,
  measureCircle,
  measurePolyline,
  setMeasurementMarkerVisibility,
  trimClosedLatLngs,
} = createShapeMeasurementRuntime({
  escapeHtml,
  flattenShapeLatLngs: (value) => flattenShapeLatLngs(value),
  getDefaultShapeColor: () => SHAPE_STYLE.color,
  getLeaflet: () => L,
  getMap: () => map,
  getSegmentLabelGroupSize: () => MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE,
  normalizeShapeColor,
});

const { createLeafletShapeLayer, toggleTooltips } = createShapeLayerRuntime({
  bindShapeArrowStyle,
  getCircleRadiusFromGeoJson,
  getLeaflet: () => L,
  getMap: () => map,
  getTooltipVisible: () => isTooltipVisible,
  setTooltipVisible: (visible) => { isTooltipVisible = visible; },
});

const {
  createCodeSearchControl,
  createFlatMarkerSearchControl,
  createMarkerSearchControl,
  toggleMeasurementSegmentMerge,
  updateMeasurementControlState,
} = createMapSearchRuntime({
  getLeaflet: () => L,
  getMap: () => map,
  getMeasurementSegmentMerged: () => isMeasurementSegmentMerged,
  getMeasurementVisible: () => isMeasurementVisible,
  isValidCoordinate,
  refreshAllShapeMeasurementMarkers: () => refreshAllShapeMeasurementMarkers(),
  setMeasurementSegmentMerged: (value) => { isMeasurementSegmentMerged = value; },
});

const { openMarkerPopup } = createMarkerPopupRuntime({
  getLeafletNamespace: () => L,
  getMarkers: () => markers,
});

installMapContentActions({
  downloadFile: (path) => downloadFile(path),
  previewImage: (path) => callParentImagePreview(path),
});
`;

export const editorFocusBridge = `
const mapObjectFocusController = createMapObjectFocusController({
  createLatLng: (latitude, longitude) => new L.LatLng(latitude, longitude),
  drawnShapesGroup,
  isValidCoordinate,
  map,
  markers,
  markersClusterGroup,
  normalizeShapeName,
  openMarkerPopup,
  openShapeMemoPopup,
  searchableShapeLayers,
  shapeNameLabelManager,
  getShapeLayer: (id) => shapeRenderManager?.ensureLayer(id) ?? null,
  onFocusedShapeChange: (id) => {
    focusedEditorShapeId = id;
    shapeRenderManager?.scheduleRefresh();
  },
});
function clearFocusedShapeFocus(targetLayer = null) {
  mapObjectFocusController.clearFocusedShapeFocus(targetLayer);
}
function focusMapObject(objectType, id, latitude, longitude) {
  mapObjectFocusController.focusMapObject(objectType, id, latitude, longitude);
}
`;

function editorEntryPlugin(): Plugin {
  return {
    name: "geocode-editor-entries",
    resolveId(id) {
      return id.startsWith(editorVirtualPrefix) ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith(`\0${editorVirtualPrefix}`)) return null;
      const entryName = id.slice(
        `\0${editorVirtualPrefix}`.length,
      ) as EditorEntryName;
      const sources = editorEntrySources[entryName];
      if (!sources) throw new Error(`Unknown editor map entry: ${entryName}`);

      const isMobileEditor = entryName === "map-mobile";
      const editorEntryProfile = `\nconst editorEntryProfile = Object.freeze({ isMobile: ${isMobileEditor}, interactionVerb: "${isMobileEditor ? "タップ" : "クリック"}" });\n`;
      return editorCommonPrelude + editorEntryProfile + sources
        .map((relativePath) => {
          const sourcePath = resolve(templateScriptsDirectory, relativePath);
          const focusBridge = relativePath === "src/map/editor/map-editor-final.ts"
            ? editorFocusBridge
            : "";
          return `${focusBridge}\n// ソース: ${relativePath}\n${readFileSync(sourcePath, "utf8")}`;
        })
        .join("\n");
    },
  };
}

export default defineConfig({
  // 印刷時に遅延読み込みするチャンクも、配信されたentryと同じディレクトリから読む。
  base: "./",
  resolve: {
    alias: [{
      find: /^leaflet$/,
      replacement: resolve(templateScriptsDirectory, "src/map/common/vendor-leaflet.ts"),
    }],
  },
  // /assets/{uri}は階層のないファイル名で配信するため、Workerも同じ配置にする。
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: "template-[name]-[hash].js",
        chunkFileNames: "template-[name]-[hash].js",
        assetFileNames: "template-[name]-[hash][extname]",
      },
    },
  },
  plugins: [editorEntryPlugin(), {
    name: "bundled-third-party-licenses",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "template-third-party-licenses.txt",
        source: createBundledNotices(this.getModuleIds()),
      });
    },
  }],
  build: {
    emptyOutDir: true,
    manifest: "template-manifest.json",
    outDir: "dist",
    rollupOptions: {
      input: {
        "form-answer-map-print": fileURLToPath(new URL("./src/entries/form-answer-map-print.ts", import.meta.url)),
        "form-answer-map": fileURLToPath(new URL("./src/entries/form-answer-map.ts", import.meta.url)),
        "image-preview": fileURLToPath(
          new URL("./src/entries/image-preview.ts", import.meta.url),
        ),
        "live-map": fileURLToPath(
          new URL("./src/entries/live-map.ts", import.meta.url),
        ),
        "map-anather": fileURLToPath(
          new URL("./src/entries/map-anather.ts", import.meta.url),
        ),
        map: `${editorVirtualPrefix}map`,
        "marker-form": fileURLToPath(
          new URL("./src/entries/marker-form.ts", import.meta.url),
        ),
        "map-mobile": `${editorVirtualPrefix}map-mobile`,
        "read-only-map-print": fileURLToPath(
          new URL("./src/entries/read-only-map-print.ts", import.meta.url),
        ),
        "temporary-map": fileURLToPath(
          new URL("./src/entries/temporary-map.ts", import.meta.url),
        ),
        "temporary-map-mobile": fileURLToPath(
          new URL("./src/entries/temporary-map-mobile.ts", import.meta.url),
        ),
      },
      output: {
        assetFileNames: "template-[name]-[hash][extname]",
        chunkFileNames: "template-[name]-[hash].js",
        entryFileNames: "template-[name].js",
      },
    },
    target: "es2022",
  },
});
