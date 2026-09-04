import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import {
  editorEntrySources,
  type EditorEntryName,
} from "./src/entries/editor-entry-sources";

const editorVirtualPrefix = "virtual:geocode-editor:";
const templateScriptsDirectory = fileURLToPath(new URL("./", import.meta.url));

export const editorCommonPrelude = `
import { createLayerBulkToggleControl, extractYouTubeId } from "/src/map/common/base.ts";
import { installMapContentActions, resolveSameOriginContentUrl } from "/src/map/common/content-actions.ts";
import { createNestedTokenizer, isLocalhost, isPDF, isValidCoordinate, renderIframe, setupDetailsLazyImages } from "/src/map/common/content.ts";
import { createMapObjectFocusController } from "/src/map/common/map-object-focus.ts";
import { loadLastMapView, observeMapView } from "/src/map/common/map-view-persistence.ts";
import { createMarkerPopupRuntime, enableMarkerIconFallback, escapeHtml, initializeUserLocation, markerOptionsForLayer } from "/src/map/common/marker.ts";
import { createLayeredMarkerDisplayManager, createLayeredShapeDisplayManager, createMapSearchRuntime, filterMeasurementMarkersForBounds, getShapeRecords, matchesMarkerSearch, matchesShapeSearch, normalizeMarkerSearchText } from "/src/map/common/search.ts";
import { createShapeArrowRuntime } from "/src/map/common/shape-arrow.ts";
import { createShapeLayerRuntime } from "/src/map/common/shape-layer.ts";
import { createShapeMeasurementRuntime } from "/src/map/common/shape-measurement.ts";
import { SHAPE_MEMO_MAX_LENGTH, createShapeMemoRuntime, getShapeMemoFromGeoJson, normalizeShapeMemo, normalizeShapeName } from "/src/map/common/shape-memo.ts";
import { SHAPE_ARROW_TYPE_OPTIONS, SHAPE_LINE_TYPE_OPTIONS, SHAPE_WEIGHT_MAX, SHAPE_WEIGHT_MIN, createShapeStyleCore } from "/src/map/common/shape-style.ts";
import { createShapeViewportRuntime } from "/src/map/common/shape-viewport.ts";
import { createMapStorage, createTileChangeHandler } from "/src/map/common/storage.ts";

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

const handleTileChange = createTileChangeHandler({
  createTileLayer: (tileServer) => L.tileLayer(tileServer.url, {
    minZoom: tileServer.min_zoom ?? 5,
    maxZoom: tileServer.max_zoom ?? 18,
    attribution: tileServer.attribution,
  }).addTo(map),
  getBounds: () => bounds,
  getMap: () => map,
  getTileLayer: () => tileLayer,
  saveSelectedTileServerId,
  setTileLayer: (nextTileLayer) => { tileLayer = nextTileLayer; },
  tileServers,
});

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
  shouldSuppressInitialShapeRendering,
} = createShapeViewportRuntime({ getShapeRecords });

const {
  attachShapeMemoPopup,
  attachShapeMemoTooltipOpen,
  openShapeMemoPopup,
  renderShapeMemoPopupContent,
} = createShapeMemoRuntime({
  escapeHtml,
  getLeaflet: () => L,
  getMap: () => map,
  renderIframe,
  renderMarkdown: (markdown) => marked.parse(markdown),
  sanitizeHtml: (html) => filterXSS(html, xssOptions),
  setupDetailsLazyImages,
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
          return `${focusBridge}\n// source: ${relativePath}\n${readFileSync(sourcePath, "utf8")}`;
        })
        .join("\n");
    },
  };
}

export default defineConfig({
  plugins: [editorEntryPlugin()],
  build: {
    emptyOutDir: true,
    manifest: "template-manifest.json",
    outDir: "dist",
    rollupOptions: {
      input: {
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
