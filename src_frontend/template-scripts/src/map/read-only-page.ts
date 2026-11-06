// @ts-nocheck -- この統合境界では Leaflet プラグイン間の型定義に互換性がないため、型チェックを省略する。
import { evaluateMapAnalysis } from "./common/map-analysis";
import { installAnswerColoring, type AnswerColoring } from "./answer-coloring";
import { createAdvancedMapSearchModal, attributeTransport } from "./common/advanced-map-search";
import { createTileOverlayManager } from "./common/tile-overlays";
import { createTileVisibilityStorage } from "./common/tile-visibility-storage";
import { createPopupContentRuntime } from "./common/popup-content";
import { createLazyLayerObjects } from "./common/lazy-layer-objects";
import { createShareMapSnapshot, resolveShareParentOrigin } from "./common/share-snapshot";
import { installReadOnlyFullscreenClose } from "./common/read-only-fullscreen-close";
import { createMapMessageDialog } from "./common/map-message-dialog";
import { createColorLegend } from "./common/color-legend";
import { openMapPrintPreview, READ_ONLY_MAP_PRINT_PATH } from "./common/map-print-host";
import type { PrintMapState } from "./common/print-state";
import { createReadOnlyPrintSnapshot } from "./print/read-only-print-snapshot";
import type { AnotherMapBootstrap, TemporaryMapBootstrap } from "./types";
import { readMapBootstrap } from "./bootstrap";
import { createAnswerVisibility } from "./answer-visibility";
import { createLayerBulkToggleControl, extractYouTubeId } from "./common/base";
import {
  createNestedTokenizer,
  isLocalhost,
  isPDF,
  isValidCoordinate,
  renderProgressiveMarkdown,
  renderIframe,
  setupDetailsLazyImages,
} from "./common/content";
import { installMapContentActions } from "./common/content-actions";
import { installMjpegCameras } from "./common/mjpeg-camera";
import { createReadOnlyLayerGroupRuntime } from "./common/layer-groups";
import { installMapMarkdownExtensions } from "./common/markdown-extensions";
import { downloadMapContentFile, installMapMarkdownRenderer } from "./common/markdown-renderer";
import { createReadOnlyMapRuntime } from "./common/map-runtime";
import { createMapUiVisibilityRuntime } from "./common/map-ui-visibility";
import { isValidMapView, loadLastMapView, observeMapView } from "./common/map-view-persistence";
import {
  enableMarkerIconFallback,
  escapeHtml,
  initializeUserLocation,
  markerOptionsForLayer,
} from "./common/marker";
import { createReadOnlyMarkerLayerControl, hydrateReadOnlyMarkers } from "./common/marker-layers";
import { installMarkerClustering } from "./common/marker-clustering";
import { installReadOnlyOverlayHandlers } from "./common/overlay-events";
import {
  addReadOnlyMapVisibilityControls,
  addReadOnlySearchControls,
} from "./common/page-controls";
import {
  createLayeredMarkerDisplayManager,
  createMapObjectSearchCoordinator,
  createMapSearchRuntime,
  filterMeasurementMarkersForBounds,
  getShapeRecords,
  matchesShapeSearch,
  matchesMarkerSearch,
  normalizeMarkerSearchText,
} from "./common/search";
import {
  createShapeRenderManager,
  getShapeGeometryInfo as getRecordGeometryInfo,
} from "./common/shape-renderer";
import { createShapeArrowRuntime } from "./common/shape-arrow";
import { createShapeLayerRuntime } from "./common/shape-layer";
import { createShapeMeasurementRuntime } from "./common/shape-measurement";
import { createMeasurementSelection } from "./common/measurement-selection";
import { makeSummaryDraggable } from "./common/draggable-summary";
import { createReadOnlyShapeMeasurementDisplayRuntime } from "./common/shape-measurement-display";
import {
  createShapeMemoRuntime,
  getShapeMemoFromGeoJson,
  normalizeShapeName,
} from "./common/shape-memo";
import { createReadOnlyShapeRestorationRuntime } from "./common/shape-restoration";
import { createShapeStyleCore } from "./common/shape-style";
import { createShapeViewportRuntime } from "./common/shape-viewport";
import {
  createMapStorage,
  createTileChangeHandler,
  loadSelectedTileServerId,
} from "./common/storage";
import {
  createMeasurementVisibilityControl,
  createTooltipVisibilityControl,
} from "./common/visibility-controls";

type ReadOnlyPageName =
  | "map-anather"
  | "form-answer-map"
  | "temporary-map"
  | "temporary-map-mobile";

type DynamicRecord = Record<string, any>;

interface BrowserLibraries {
  L: DynamicRecord;
  filterXSS(html: string, options: unknown): string;
  marked: DynamicRecord;
}

const SHAPE_STYLE = {
  color: "#d94841",
  fillColor: "#d94841",
  fillOpacity: 0.16,
  weight: 5,
};
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;

function getBrowserLibraries(): BrowserLibraries {
  const browserWindow = window as unknown as DynamicRecord;
  if (!browserWindow.L || !browserWindow.marked || !browserWindow.filterXSS) {
    throw new Error("Read-only map vendor libraries are unavailable");
  }
  return {
    L: browserWindow.L,
    filterXSS: browserWindow.filterXSS,
    marked: browserWindow.marked,
  };
}

function initializeCollapsibleLayerControl({
  L,
  layersControl,
  map,
  overlayCount,
}: DynamicRecord): void {
  if (overlayCount < 4) return;
  const container = layersControl.getContainer();
  const overlayContainer = container?.querySelector(".leaflet-control-layers-overlays");
  if (!container || !overlayContainer) return;

  const applyCollapsibleItems = (): number => {
    const items = Array.from(overlayContainer.querySelectorAll("label") as NodeListOf<HTMLElement>);
    items.forEach((item) => item.classList.remove("temporary-layer-control-collapsible-item"));
    items
      .slice(2)
      .forEach((item) => item.classList.add("temporary-layer-control-collapsible-item"));
    return items.length;
  };
  if (applyCollapsibleItems() < 4) return;

  container.classList.add("temporary-layer-control");
  const toggleButton = L.DomUtil.create(
    "button",
    "custom-control-button temporary-layer-control-toggle",
    container,
  ) as HTMLButtonElement;
  toggleButton.type = "button";
  const updateToggleState = (): void => {
    const collapsed = container.classList.contains("is-collapsed");
    toggleButton.textContent = collapsed ? "すべて表示" : "折り畳む";
    toggleButton.setAttribute("aria-expanded", String(!collapsed));
  };
  L.DomEvent.on(toggleButton, "click", (event: Event) => {
    L.DomEvent.stop(event);
    applyCollapsibleItems();
    container.classList.toggle("is-collapsed");
    updateToggleState();
  });
  map.on("overlayadd overlayremove", () => setTimeout(applyCollapsibleItems, 0));
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation?.(container);
  updateToggleState();
}

export function initializeReadOnlyMapPage(
  expectedPage: ReadOnlyPageName,
  printState?: PrintMapState,
  snapshotBootstrap?: AnotherMapBootstrap | TemporaryMapBootstrap,
) {
  const bootstrap = snapshotBootstrap ?? readMapBootstrap();
  if (bootstrap.page !== expectedPage) {
    throw new Error(`Unexpected map bootstrap page: ${bootstrap.page}`);
  }
  if (bootstrap.page === "map" || bootstrap.page === "map-mobile") {
    throw new Error("Editable map bootstrap is not supported");
  }

  const { L, filterXSS, marked } = getBrowserLibraries();
  const isAnother = expectedPage === "map-anather" || expectedPage === "form-answer-map";
  const isSnapshotPrint = Boolean(snapshotBootstrap);
  const isPrint = (isAnother || isSnapshotPrint) && Boolean(printState);
  const isAnswerPreview =
    expectedPage === "form-answer-map" || (isAnother && Boolean(bootstrap.answerPreview));
  // 印刷元の絞り込みは、共通フォームの回答フィルターや凡例フィルターとは独立している。
  const usesPrintTargetIds = isPrint && !isAnswerPreview;
  const printMarkerIds =
    usesPrintTargetIds && Array.isArray(printState?.markerIds)
      ? new Set(printState.markerIds)
      : null;
  const printShapeIds =
    usesPrintTargetIds && Array.isArray(printState?.shapeIds) ? new Set(printState.shapeIds) : null;
  const answerVisibility = createAnswerVisibility(() => {
    layeredMarkerDisplay.rebuildVisibleMarkers();
    layeredShapeDisplay.rebuildVisibleShapes();
    groups.syncAllShapeGroupsVisibility();
    map.fire("answerfilterchange");
    refreshColorLegend?.();
  });
  const persistSettings = isAnother && !isPrint && !isAnswerPreview;
  const isMobileAnswerMap =
    expectedPage === "form-answer-map" &&
    !isPrint &&
    new URLSearchParams(window.location.search).get("map_ui") === "mobile";
  const isMobile = expectedPage === "temporary-map-mobile" || isMobileAnswerMap;
  if (isMobileAnswerMap) document.body.classList.add("map-mobile-controls");
  const isTemporary = !isAnother;
  const temporaryBootstrap = isTemporary
    ? (bootstrap as Extract<typeof bootstrap, { page: "temporary-map" | "temporary-map-mobile" }>)
    : null;
  const sharedSnapshot = temporaryBootstrap?.shareSnapshot || null;
  const hasCapturedView = Boolean(sharedSnapshot || isSnapshotPrint);
  const initialState = printState ?? sharedSnapshot?.state;
  const tileServers = bootstrap.tileServers;
  const layers = bootstrap.layers;
  const markerRecords = bootstrap.markers;
  const shapeRecords = bootstrap.shapes;

  const storage = createMapStorage(
    tileServers,
    isAnswerPreview || hasCapturedView
      ? {
          getStorage: () => ({ getItem: () => null, setItem: () => {} }) as Storage,
        }
      : undefined,
  );
  const shapeStyle = createShapeStyleCore(() => SHAPE_STYLE);
  const shapeArrow = createShapeArrowRuntime({
    getDefaultStyle: () => SHAPE_STYLE,
    normalizeShapeArrowType: shapeStyle.normalizeShapeArrowType,
    normalizeShapeColor: shapeStyle.normalizeShapeColor,
    normalizeShapeWeight: shapeStyle.normalizeShapeWeight,
  });
  const viewport = createShapeViewportRuntime();

  installMapMarkdownExtensions({
    createNestedTokenizer: (type) =>
      createNestedTokenizer(type, {
        renderDeferredBody: (text, links) =>
          renderProgressiveMarkdown(
            text,
            (html) => renderIframe(filterXSS(html, xssOptions)),
            links,
          ),
      }),
    extractYouTubeId,
    marked,
  });
  const xssOptions = installMapMarkdownRenderer({
    printing: isPrint,
    enablePwaDownloads: isAnother && !isSnapshotPrint,
    imageMode: isMobile ? "html-preview" : "direct-preview",
    isLocalhost,
    isPdf: isPDF,
    marked,
  });
  const renderContentMarkdown = (markdown, links) =>
    renderProgressiveMarkdown(markdown, (html) => renderIframe(filterXSS(html, xssOptions)), links);

  let map: DynamicRecord;
  let bounds: unknown;
  let tileLayer: DynamicRecord;
  const handleTileChange = createTileChangeHandler({
    createTileLayer: (server) =>
      L.tileLayer(server.url, {
        attribution: server.attribution,
        maxZoom: server.max_zoom ?? 18,
        minZoom: server.min_zoom ?? 5,
      }).addTo(map),
    getBounds: () => bounds,
    getMap: () => map,
    getTileLayer: () => tileLayer,
    saveSelectedTileServerId: storage.saveSelectedTileServerId,
    setTileLayer: (nextLayer) => {
      tileLayer = nextLayer;
    },
    tileServers,
  });

  let registerHideableMapControl: ((control: object) => void) | undefined;
  let MapUiVisibilityToggleControl: (new () => object) | undefined;
  if (isMobile) {
    const mobileUi = createMapUiVisibilityRuntime({
      initialHidden: temporaryBootstrap?.isMapUiHidden ?? false,
      hideButtonLabel: isMobileAnswerMap ? "機能を非表示" : undefined,
      togglePosition: isMobileAnswerMap ? "topleft" : undefined,
      leaflet: L,
    });
    registerHideableMapControl = mobileUi.registerHideableMapControl;
    MapUiVisibilityToggleControl = mobileUi.MapUiVisibilityToggleControl;
  }

  const lastMapView = isAnother && !isAnswerPreview && !isSnapshotPrint ? loadLastMapView() : null;
  const answerMapView =
    isAnswerPreview && isValidMapView(bootstrap.answerPreview?.initialView)
      ? bootstrap.answerPreview.initialView
      : null;
  const initialView =
    initialState?.view ??
    answerMapView ??
    (isAnother ? (lastMapView ?? bootstrap.initialView) : temporaryBootstrap!.initialView);
  const mapRuntime = createReadOnlyMapRuntime({
    ...(hasCapturedView ? { initialTileServerId: initialState.tileServerId } : {}),
    center: [initialView.latitude, initialView.longitude],
    escapeHtml,
    handleTileChange,
    leaflet: L,
    onTileControlAdded: registerHideableMapControl,
    tileServers,
    zoom: initialView.zoom,
  });
  map = mapRuntime.map as DynamicRecord;
  const popupContent =
    isAnother && !isSnapshotPrint
      ? createPopupContentRuntime({
          map,
          sanitizeHtml: (html) => filterXSS(html, xssOptions),
          analysis: bootstrap.popupAnalysis,
          renderMarkdown: renderContentMarkdown,
          setupImages: setupDetailsLazyImages,
          snapshot: isAnswerPreview ? bootstrap.popupBodies || {} : undefined,
          answerMap: isAnswerPreview,
          loadBody: async (kind, id) => {
            let response = await fetch(`/${kind}/${id}/form/body`, {
              credentials: "same-origin",
              cache: "no-store",
            });
            if (response.status === 401) {
              const renewed = await fetch("/account/refresh", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              if (renewed.ok)
                response = await fetch(`/${kind}/${id}/form/body`, {
                  credentials: "same-origin",
                  cache: "no-store",
                });
            }
            if (!response.ok) throw Error("Popup request failed");
            return response.json();
          },
        })
      : undefined;
  if (isMobileAnswerMap) map.addControl(new MapUiVisibilityToggleControl!());
  if (!isPrint) installMjpegCameras(map);
  if (persistSettings) observeMapView(map);
  bounds = mapRuntime.bounds;
  tileLayer = mapRuntime.tileLayer as DynamicRecord;
  const initialTileServerId = initialState
    ? initialState.tileServerId
    : isAnother
      ? loadSelectedTileServerId(tileServers)
      : undefined;
  if (!hasCapturedView && initialTileServerId && tileServers[initialTileServerId]) {
    const radio = Array.from(document.querySelectorAll<HTMLInputElement>(".tile-radio")).find(
      (input) => input.value === initialTileServerId,
    );
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change"));
    }
    map.setView([initialView.latitude, initialView.longitude], initialView.zoom, {
      animate: false,
    });
  }

  let isTooltipVisible = false;
  let isMeasurementVisible = false;
  let isMeasurementSegmentMerged = false;
  let shapeNameLabelManager: DynamicRecord | null = null;
  let shapeMeasurementManager: DynamicRecord | null = null;
  let layeredMarkerDisplay: DynamicRecord;
  const clusterGroups: DynamicRecord = {};
  const layerVisibilityGroups: DynamicRecord = {};
  const shapeGroups: DynamicRecord = {};
  const shapeLayers: DynamicRecord = {};
  let shapeRenderer: ReturnType<typeof createShapeRenderManager>;
  let shapeRenderStatus: HTMLElement | null = null;
  let shapeSearchQuery = initialState?.objectQuery || "";
  let coloringController;
  let refreshColorLegend: (() => void) | undefined;
  let colorSpecification = null;
  let analysisRevision = 0;
  let advancedSearch;
  const shapeSearchMatches = new WeakMap<object, { query: string; result: boolean }>();
  const shapeCreatedListeners = new Set<(layer: any, record: any) => void>();
  const shapeEvictedListeners = new Set<(layer: any, record: any) => void>();
  const markers: DynamicRecord = {};
  const layerNames: Record<string, string> = {};
  const clusteringAllowed = hasCapturedView
    ? initialState.clusteringAllowed !== false
    : !isAnother || (bootstrap.isCluster !== false && printState?.clusteringAllowed !== false);
  const visibleMarkerGroup = clusteringAllowed ? L.markerClusterGroup() : L.featureGroup();
  if (initialState?.markersVisible ?? (isTemporary || storage.getInitialMarkerVisibility()))
    visibleMarkerGroup.addTo(map);
  const drawnShapesGroup = isAnother ? L.featureGroup() : undefined;
  const shapeVisibilityLayer = L.layerGroup();
  if (initialState?.shapesVisible ?? (isTemporary || storage.getInitialShapeLayerVisibility())) {
    shapeVisibilityLayer.addTo(map);
  }
  const shapeNameVisibilityLayer = L.layerGroup();
  if (initialState?.shapeNamesVisible ?? (isAnother && storage.getInitialShapeNameVisibility())) {
    shapeNameVisibilityLayer.addTo(map);
  }

  const measurement = createShapeMeasurementRuntime({
    escapeHtml,
    flattenShapeLatLngs: (value) => measurementDisplay.flattenShapeLatLngs(value),
    getDefaultShapeColor: () => SHAPE_STYLE.color,
    getLeaflet: () => L,
    getMap: () => map,
    getSegmentLabelGroupSize: () => MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE,
    normalizeShapeColor: shapeStyle.normalizeShapeColor,
  });
  const shapeLayer = createShapeLayerRuntime({
    bindShapeArrowStyle: shapeArrow.bindShapeArrowStyle,
    getCircleRadiusFromGeoJson: measurement.getCircleRadiusFromGeoJson,
    getLeaflet: () => L,
    getMap: () => map,
    getTooltipVisible: () => isTooltipVisible,
    setTooltipVisible: (visible) => {
      isTooltipVisible = visible;
    },
  });
  const memo = createShapeMemoRuntime({
    renderPopup: popupContent
      ? (layer) =>
          popupContent.render({
            kind: "shape",
            id: layer.shapeId,
            name: layer.shapeName || "",
            body: layer.shapeMemo || "",
          })
      : undefined,
    onShapeClick: (layer, event) => selection.select(layer, event),
    escapeHtml,
    getLeaflet: () => L,
    getMap: () => map,
    renderIframe,
    renderMarkdown: renderContentMarkdown,
    sanitizeHtml: (html) => filterXSS(html, xssOptions),
    setupDetailsLazyImages: (root) => setupDetailsLazyImages(root, renderContentMarkdown),
  });
  if (!isSnapshotPrint) {
    installMapContentActions({
      downloadFile: isAnother ? downloadMapContentFile : undefined,
      previewImage: (path) =>
        window.parent.postMessage({ message: path, type: "callParentFunction" }, "*"),
    });
  }

  const groups = createReadOnlyLayerGroupRuntime({
    clusterGroups,
    drawnShapesGroup,
    getLayeredMarkerDisplay: () => layeredMarkerDisplay,
    getMeasurementVisible: () => isMeasurementVisible,
    getShapeMeasurementManager: () => shapeMeasurementManager,
    layerVisibilityGroups,
    leaflet: L,
    map,
    setMeasurementMarkerVisibility: measurement.setMeasurementMarkerVisibility,
    shapeGroups,
    shapeVisibilityLayer,
  });
  const measurementDisplay = createReadOnlyShapeMeasurementDisplayRuntime({
    ...measurement,
    ensureShapeGroup: groups.ensureShapeGroup,
    filterMeasurementMarkersForBounds,
    getMeasurementSegmentMerged: () => isMeasurementSegmentMerged,
    getMeasurementVisible: () => isMeasurementVisible,
    getShapeMeasurementManager: () => shapeMeasurementManager,
    map,
  });
  const selection = createMeasurementSelection({
    getEnabled: () => isMeasurementVisible,
    isVisible: (layer) => isShapeLogicallyVisible(layer.shapeId),
    measure: (layer) => {
      if (layer.shapeType === "polyline")
        return { area: 0, distance: measurement.measurePolyline(layer).totalDistance };
      if (layer.shapeType === "circle")
        return { area: measurement.measureCircle(layer).area, distance: 0 };
      const value = measurementDisplay.measurePolygon(layer);
      return { area: value.area, distance: value.perimeter };
    },
    formatArea: measurement.formatArea,
    formatDistance: measurement.formatDistance,
    refresh: () => {
      shapeMeasurementManager?.scheduleRefresh();
      map.fire("measurementselectionchange");
    },
    closePopup: () => map.closePopup(),
    stopEvent: (event) => {
      const original = event?.originalEvent || event;
      if (original) L.DomEvent.stop(original);
    },
  });
  const restoration = createReadOnlyShapeRestorationRuntime({
    attachShapeMemoPopup: memo.attachShapeMemoPopup,
    attachShapeMemoTooltipOpen: memo.attachShapeMemoTooltipOpen,
    bindPolylineHoverHighlight: shapeArrow.bindPolylineHoverHighlight,
    createLeafletShapeLayer: (...args) => {
      if (!isAnswerPreview) return shapeLayer.createLeafletShapeLayer(...args);
      try {
        return shapeLayer.createLeafletShapeLayer(...args);
      } catch {
        return null;
      }
    },
    escapeHtml,
    getDefaultShapeColor: () => SHAPE_STYLE.color,
    getShapeMemoFromGeoJson,
    getShapeNameLabelManager: () => shapeNameLabelManager,
    getShapeRecords,
    getShapeStyleFromGeoJson: shapeStyle.getShapeStyleFromGeoJson,
    labelAppearance: isAnother || sharedSnapshot ? "pill" : "plain",
    normalizeShapeColor: shapeStyle.normalizeShapeColor,
    normalizeShapeName,
  });
  const searchRuntime = createMapSearchRuntime({
    getMap: () => map,
    getMeasurementSegmentMerged: () => isMeasurementSegmentMerged,
    getMeasurementVisible: () => isMeasurementVisible,
    isValidCoordinate,
    refreshAllShapeMeasurementMarkers: () => measurementDisplay.refreshAllShapeMeasurementMarkers(),
    setMeasurementSegmentMerged: (value) => {
      isMeasurementSegmentMerged = value;
    },
  });

  // 地図オブジェクトの取得を待たず、メタデータから選択欄を作成する。
  if (isAnother || hasCapturedView) Object.keys(layers).forEach(groups.createMarkerGroupForLayer);
  const hydrateMarkers = (records) =>
    hydrateReadOnlyMarkers({
      renderPopup: popupContent
        ? (record) =>
            popupContent.render({
              kind: "marker",
              id: String(record.id),
              name: record.marker_name,
              body: record.detail || "",
            })
        : undefined,
      onMarkerCreated:
        isAnother || hasCapturedView
          ? (marker, record) => {
              coloringController?.refreshTarget(`marker:${record.id}`, marker);
              marker.on("add", () => {
                if (isTooltipVisible) marker.openTooltip?.();
              });
            }
          : undefined,
      clusterGroups,
      createMarkerGroupForLayer: groups.createMarkerGroupForLayer,
      enableMarkerIconFallback: isTemporary ? enableMarkerIconFallback : undefined,
      escapeHtml,
      initialLayersVisible: isAnswerPreview || (!hasCapturedView && temporaryBootstrap?.isChecked),
      layerNames,
      layerRecords: layers,
      layerVisibilityGroups,
      leaflet: L,
      map,
      markerOptionsForLayer,
      markerRecords: records,
      markers,
      parseMarkdown: renderContentMarkdown,
      renderIframe,
      sanitizeHtml: (html) => filterXSS(html, xssOptions),
      setupDetailsLazyImages: (root) => setupDetailsLazyImages(root, renderContentMarkdown),
      shapeRecords,
    });
  hydrateMarkers(markerRecords);

  if (initialState) {
    for (const [id, group] of Object.entries(layerVisibilityGroups)) {
      if (initialState.layerIds === null || initialState.layerIds.includes(id)) group.addTo(map);
    }
  }

  // 表示設定・検索・回答条件は描画済みオブジェクトの有無とは独立して判定する。
  const matchesCurrentShapeSearch = (record) => {
    if (!shapeSearchQuery) return true;
    const cached = shapeSearchMatches.get(record);
    if (cached?.query === shapeSearchQuery) return cached.result;
    const result = matchesShapeSearch(record, shapeSearchQuery);
    shapeSearchMatches.set(record, { query: shapeSearchQuery, result });
    return result;
  };
  let attributeTargetMask = null;
  const isShapeRecordVisible = (record) =>
    map.hasLayer(shapeVisibilityLayer) &&
    layeredMarkerDisplay.isLayerVisible(record.layer_id) &&
    (!printShapeIds || printShapeIds.has(String(record.id))) &&
    answerVisibility.allows(`shape:${record.id}`) &&
    (!attributeTargetMask || attributeTargetMask.has(`shape:${record.id}`)) &&
    matchesCurrentShapeSearch(record);
  const isShapeLogicallyVisible = (id) => {
    const record = shapeRenderer?.getRecord(id);
    return Boolean(record && shapeRenderer.isRenderable(id) && isShapeRecordVisible(record));
  };
  const hasSharedShapes = getShapeRecords(shapeRecords).some((record) =>
    Boolean(getRecordGeometryInfo(record)),
  );
  const isMarkerRecordAllowed = (record) =>
    (!printMarkerIds || printMarkerIds.has(String(record.id))) &&
    matchesMarkerSearch(record, printState?.objectQuery || "") &&
    answerVisibility.allows(`marker:${record.id}`) &&
    (!attributeTargetMask || attributeTargetMask.has(`marker:${record.id}`));

  // 共有・印刷・凡例は、画面内の描画結果ではなく同じレコードの表示条件を使う。
  const getVisibleObjectKeys = (assignments?: AnswerColoring["targets"]): Set<string> => {
    const targets = new Set<string>();
    if (map.hasLayer(visibleMarkerGroup)) {
      for (const record of Object.values(markerRecords)) {
        const key = `marker:${record.id}`;
        if (
          (!assignments || Object.hasOwn(assignments, key)) &&
          layeredMarkerDisplay.isLayerVisible(record.layer_id) &&
          isMarkerRecordAllowed(record) &&
          matchesMarkerSearch(record, shapeSearchQuery)
        )
          targets.add(key);
      }
    }
    for (const record of getShapeRecords(shapeRecords)) {
      const key = `shape:${record.id}`;
      if (
        (!assignments || Object.hasOwn(assignments, key)) &&
        isShapeRecordVisible(record) &&
        shapeRenderer.getGeometryInfo(record.id)
      )
        targets.add(key);
    }
    return targets;
  };

  const markerLayerControl = createReadOnlyMarkerLayerControl({
    formatLayerName: isAnother
      ? (id, name) =>
          `<span data-layer-load-id="${escapeHtml(id)}">${name}<span class="layer-object-load-state" role="status" aria-live="polite"></span></span>`
      : undefined,
    clusterGroups,
    createLayeredMarkerDisplayManager: (options) =>
      createLayeredMarkerDisplayManager({
        ...options,
        isRecordAllowed: isMarkerRecordAllowed,
      }),
    escapeHtml,
    layerNames,
    layerVisibilityGroups,
    leaflet: L,
    map,
    markerRecords,
    markers,
    skipUnnamedLayers: isTemporary,
    visibleMarkerGroup,
  });
  layeredMarkerDisplay = markerLayerControl.layeredMarkerDisplay;
  if (isMobile) registerHideableMapControl!(markerLayerControl.layersControl);
  if (isTemporary && !hasCapturedView && hasSharedShapes) shapeNameVisibilityLayer.addTo(map);

  shapeNameLabelManager = viewport.createViewportShapeLabelManager({
    bindLabel: restoration.bindShapeNameLabelTooltip,
    enabled: map.hasLayer(shapeNameVisibilityLayer),
    getLabelLatLng: (layer) => measurementDisplay.getShapeLabelLatLng(layer),
    getLayers: () => Object.values(shapeLayers),
    map,
    shouldBind: (layer) => Boolean(normalizeShapeName(layer.shapeName)),
  });
  shapeNameLabelManager.refresh();
  shapeMeasurementManager = viewport.createViewportShapeMeasurementManager({
    isLayerVisible: (layer) => map.hasLayer(layer) && selection.includes(layer),
    attachMarkers: (layer, viewportBounds) =>
      measurementDisplay.attachShapeMeasurementMarkers(
        layer,
        (layer as DynamicRecord).layerId,
        viewportBounds,
      ),
    getLayers: () => Object.values(shapeLayers),
    map,
    removeMarkers: measurementDisplay.removeShapeMeasurementMarkers,
  });
  map.on("unload", () => {
    shapeNameLabelManager?.destroy();
    shapeMeasurementManager?.destroy();
  });
  shapeRenderer = createShapeRenderManager({
    map,
    records: getShapeRecords(shapeRecords),
    // 印刷は用紙上の縮尺を使い、小図形の視認性抑止を適用しない。
    minPixelSize: isPrint ? 0 : undefined,
    isRecordVisible: isShapeRecordVisible,
    isPinned: (_id, layer) =>
      Boolean(layer && (selection.includes(layer) || memo.isShapePopupOpen(layer))),
    createLayer: (record) =>
      restoration.restoreShape(record, {
        applyShapeStyle: isAnother || Boolean(sharedSnapshot),
        bindPolylineHover: !isMobile,
        restoreShapeStyleOnHover: isAnother || Boolean(sharedSnapshot),
        shapeLayers,
      }),
    addLayer: (layer, record) => {
      groups.addShapeLayerToManagedGroups(layer, record.layer_id);
      // 新しいグループだけを地図へ加え、追加のたびに全図形を走査しない。
      const group = groups.ensureShapeGroup(record.layer_id);
      if (group && !map.hasLayer(group) && isShapeRecordVisible(record)) group.addTo(map);
    },
    removeLayer: (layer, record) => {
      measurementDisplay.removeShapeMeasurementMarkers(layer);
      groups.removeShapeLayerFromManagedGroups(layer, record.layer_id);
    },
    disposeLayer: (layer) => {
      measurementDisplay.removeShapeMeasurementMarkers(layer);
      memo.releaseLayer(layer);
      popupContent?.release("shape", String(layer.shapeId));
      layer.unbindTooltip?.();
      layer.unbindPopup?.();
      layer.off?.();
    },
    onLayerCreated: (layer, record) => {
      shapeCreatedListeners.forEach((listener) => listener(layer, record));
    },
    onLayerEvicted: (layer, record) => {
      if (shapeLayers[`shape-${record.id}`] === layer) delete shapeLayers[`shape-${record.id}`];
      shapeEvictedListeners.forEach((listener) => listener(layer, record));
    },
    onRefresh: () => {
      shapeNameLabelManager?.scheduleRefresh();
      shapeMeasurementManager?.scheduleRefresh();
      if (shapeRenderStatus) {
        const stats = shapeRenderer.getStats();
        const message = stats.pendingCount > 0 ? "図形を表示しています…" : "";
        shapeRenderStatus.hidden = !message;
        if (shapeRenderStatus.textContent !== message) shapeRenderStatus.textContent = message;
      }
      map.fire("shaperenderchange");
      map.fire("objectloadingchange");
    },
  });
  map.on("unload", () => {
    shapeRenderer.destroy();
    shapeCreatedListeners.clear();
    shapeEvictedListeners.clear();
  });
  const layeredShapeDisplay = {
    rebuildVisibleShapes() {
      selection.prune();
      shapeRenderer.refresh();
    },
    setSearchQuery(query) {
      shapeSearchQuery = normalizeMarkerSearchText(query);
      this.rebuildVisibleShapes();
    },
    clearSearch() {
      shapeSearchQuery = "";
      this.rebuildVisibleShapes();
    },
  };
  const searchCoordinator = createMapObjectSearchCoordinator({
    markerDisplay: layeredMarkerDisplay,
    shapeDisplay: layeredShapeDisplay,
    syncShapeVisibility: () => {
      groups.syncAllShapeGroupsVisibility();
      refreshColorLegend?.();
    },
  });

  const addBulkControl = (): object => {
    const control = createLayerBulkToggleControl({
      map,
      overlayLayers: markerLayerControl.layerControlOverlayLayers,
    });
    map.addControl(control);
    return control;
  };
  groups.syncAllShapeGroupsVisibility();
  if (isAnother) {
    const bulkControl = addBulkControl();
    if (isMobileAnswerMap) registerHideableMapControl!(bulkControl);
  } else {
    const bulkControl = addBulkControl();
    if (isMobile) {
      registerHideableMapControl!(bulkControl);
      initializeCollapsibleLayerControl({
        L,
        layersControl: markerLayerControl.layersControl,
        map,
        overlayCount: markerLayerControl.layerControlOverlayLayers.length,
      });
    }
  }

  installReadOnlyOverlayHandlers({
    clearMapObjectSearch: searchCoordinator.clearMapObjectSearch,
    findLayerIdByMarkerGroup: groups.findLayerIdByMarkerGroup,
    map,
    markerDisplay: layeredMarkerDisplay,
    onMarkerVisibilityChange: persistSettings ? storage.saveMarkerVisibility : undefined,
    onShapeNameVisibilityChange: persistSettings ? storage.saveShapeNameVisibility : undefined,
    onShapeVisibilityChange: (visible) => {
      if (persistSettings) storage.saveShapeLayerVisibility(visible);
      layeredShapeDisplay.rebuildVisibleShapes();
    },
    shapeDisplay: layeredShapeDisplay,
    shapeNameLabelManager,
    shapeNameVisibilityLayer,
    shapeVisibilityLayer,
    syncAllShapeGroupsVisibility: groups.syncAllShapeGroupsVisibility,
    syncShapeGroupVisibility: groups.syncShapeGroupVisibility,
    visibleMarkerGroup: isAnother ? visibleMarkerGroup : undefined,
  });

  const toggleMeasurementLabels = (): void => {
    isMeasurementVisible = !isMeasurementVisible;
    if (!isMeasurementVisible) selection.clear();
    selection.update();
    shapeMeasurementManager?.setEnabled(isMeasurementVisible);
    searchRuntime.updateMeasurementControlState();
  };
  const tooltipControl = createTooltipVisibilityControl({
    leaflet: L,
    onToggle: shapeLayer.toggleTooltips,
    position: isAnother || isMobile ? "topleft" : "topright",
  });
  map.addControl(tooltipControl);
  if (isMobileAnswerMap) registerHideableMapControl!(tooltipControl);
  const includeMeasurementControl = isAnother || hasSharedShapes;
  if (includeMeasurementControl) {
    const SummaryControl = L.Control.extend({
      options: { position: isMobile ? "topright" : "bottomleft" },
      onAdd() {
        const element = L.DomUtil.create("div", "measurement-selection-summary");
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        L.DomEvent.disableClickPropagation(element);
        L.DomEvent.disableScrollPropagation(element);
        selection.bindSummary(element);
        return element;
      },
    });
    const summaryControl = new SummaryControl();
    const control = createMeasurementVisibilityControl({
      onSelectionToggle: selection.toggle,
      onSelectionButton: selection.bindButton,
      leaflet: L,
      onMergeToggle: searchRuntime.toggleMeasurementSegmentMerge,
      onToggle: toggleMeasurementLabels,
      onUpdateState: searchRuntime.updateMeasurementControlState,
      position: isAnother ? "topleft" : "topright",
    });
    map.addControl(control);
    if (isMobile) registerHideableMapControl!(control);
    map.addControl(summaryControl);
    if (isAnother || isSnapshotPrint) {
      map.on(
        "unload",
        makeSummaryDraggable(summaryControl.getContainer(), map.getContainer(), () =>
          map.fire("measurementselectionchange"),
        ),
      );
    }
  }
  map.on("overlayremove overlayadd", () => selection.prune());

  if (!isPrint)
    addReadOnlySearchControls({
      clusterGroups,
      createCodeSearchControl: searchRuntime.createCodeSearchControl,
      createMarkerSearchControl: searchRuntime.createMarkerSearchControl,
      map,
      markerRecords,
      markers,
      onClear: searchCoordinator.clearMapObjectSearch,
      onCodeSearchControlAdded: isMobile ? registerHideableMapControl : undefined,
      onSearch: searchCoordinator.setMapObjectSearchQuery,
    });
  if (isAnother && !isAnswerPreview && !isPrint) {
    let appliedAttributeSearch = null;
    const control = L.control({ position: "topleft" });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "custom-control-button";
    button.textContent = "詳しい検索と色分け";
    button.setAttribute("aria-pressed", "false");
    const modal = createAdvancedMapSearchModal({
      transport: attributeTransport,
      getApplied: () => appliedAttributeSearch,
      getLayerIds: () => null,
      getContext: () => `${bootstrap.tileVisibilityAccountId || ""}:${analysisRevision}`,
      analysis: {
        getSpecification: () => colorSpecification,
        getColoring: () => coloringController?.getState() || null,
        apply: async (specification, coloring) => {
          coloringController.apply(coloring);
          colorSpecification = specification;
          button.setAttribute("aria-pressed", String(!!specification || !!appliedAttributeSearch));
          button.textContent = specification
            ? "詳しい検索と色分け（色分け適用中）"
            : appliedAttributeSearch
              ? "詳しい検索と色分け（適用中）"
              : "詳しい検索と色分け";
          ++analysisRevision;
        },
      },
      onApply: async (request, result, signal) => {
        if (!result && colorSpecification) {
          const current = analysisRevision;
          const colors = await evaluateMapAnalysis(
            attributeTransport,
            null,
            colorSpecification,
            null,
            signal || new AbortController().signal,
          );
          if (signal?.aborted || current !== analysisRevision) return;
          coloringController.apply(colors.coloring);
        }
        if (result?.coloring !== undefined) coloringController.apply(result.coloring);
        appliedAttributeSearch = request;
        ++analysisRevision;
        attributeTargetMask = result
          ? new Set([
              ...result.marker_ids.map((id) => `marker:${id}`),
              ...result.shape_ids.map((id) => `shape:${id}`),
            ])
          : null;
        button.textContent = result
          ? `詳しい検索と色分け（適用中・全レイヤー${result.target_count}件）`
          : colorSpecification
            ? "詳しい検索と色分け（色分け適用中）"
            : "詳しい検索と色分け";
        button.setAttribute("aria-pressed", String(!!result || !!colorSpecification));
        layeredMarkerDisplay.rebuildVisibleMarkers();
        layeredShapeDisplay.rebuildVisibleShapes();
        groups.syncAllShapeGroupsVisibility();
        shapeNameLabelManager?.scheduleRefresh();
        shapeMeasurementManager?.scheduleRefresh();
        refreshColorLegend?.();
      },
    });
    advancedSearch = modal;
    button.addEventListener("click", () => void modal.open(button));
    control.onAdd = () => {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      container.append(button);
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
    control.addTo(map);
    map.on("unload", () => modal.dispose());
  }
  if (isMobile && !isMobileAnswerMap) {
    const uiToggle = new MapUiVisibilityToggleControl!();
    map.addControl(uiToggle);
  }
  const { visibilityControl } = addReadOnlyMapVisibilityControls({
    includeShapeOverlays: isAnother || hasSharedShapes,
    initialUserLocationVisible: isAnother ? storage.getInitialUserLocationVisibility() : undefined,
    initializeUserLocation: isPrint || isAnswerPreview ? () => null : initializeUserLocation,
    leaflet: L,
    map,
    onUserLocationVisibilityChange: persistSettings
      ? storage.saveUserLocationVisibility
      : undefined,
    onVisibilityControlAdded: isMobile ? registerHideableMapControl : undefined,
    shapeNameVisibilityLayer,
    shapeVisibilityLayer,
    userLocationOptions: isMobile
      ? { controlClassName: "temporary-user-location-control", position: "bottomleft" }
      : isAnother
        ? { centerOnInitialPosition: !lastMapView }
        : undefined,
    visibleMarkerGroup,
  });

  const markerClustering =
    isAnother || hasCapturedView
      ? installMarkerClustering({
          leaflet: L,
          map,
          markerGroup: visibleMarkerGroup,
          control: visibilityControl,
          allowed: clusteringAllowed,
          initialEnabled: initialState?.clusteringEnabled ?? true,
          minZoom: printState?.clusteringMinZoom ?? bootstrap.clusteringMinZoom,
        })
      : undefined;

  const tileOverlayManager = createTileOverlayManager(
    L,
    map,
    visibilityControl,
    persistSettings ? bootstrap.tileVisibilityAccountId : undefined,
    temporaryBootstrap?.isOverlayTile ?? true,
    isMobile ? { onControlAdded: registerHideableMapControl } : undefined,
  );
  const tileOverlays = bootstrap.tileOverlays || [];
  const initialTileVisibility =
    initialState?.overlays ??
    (isAnswerPreview && !isPrint && bootstrap.tileVisibilityAccountId
      ? createTileVisibilityStorage(bootstrap.tileVisibilityAccountId).load(
          tileOverlays.map((tile) => tile.id),
        )
      : undefined);
  tileOverlayManager.sync(tileOverlays, initialTileVisibility);
  if (initialState) tileOverlayManager.setVisibility(initialState.overlays);

  let objectLoader: ReturnType<typeof createLazyLayerObjects> | undefined;
  if (isAnother && !isAnswerPreview && !isSnapshotPrint) {
    const getSelectedLayerIds = () =>
      Object.keys(layerVisibilityGroups).filter((id) => map.hasLayer(layerVisibilityGroups[id]));
    const updateLoadStatus = () => {
      markerLayerControl.layersControl
        .getContainer()
        ?.querySelectorAll<HTMLElement>("[data-layer-load-id]")
        .forEach((label) => {
          const state = objectLoader!.state(label.dataset.layerLoadId!);
          const status = label.querySelector<HTMLElement>(".layer-object-load-state");
          label.setAttribute("aria-busy", String(state === "loading"));
          if (status) {
            status.dataset.state = state;
            status.textContent =
              state === "error" ? "取得できませんでした。再チェックで再試行" : "";
          }
        });
      map.fire("objectloadingchange");
    };
    objectLoader = createLazyLayerObjects({
      layerIds: Object.keys(layers),
      getSelectedLayerIds,
      onChange: updateLoadStatus,
      apply: (_id, data) => {
        // 再チェック時は、取得済みデータと作成済みの Leaflet レイヤを再利用する。
        hydrateMarkers(
          Object.fromEntries(
            Object.entries(data.markers).filter(([, record]) => !markers[`marker-${record.id}`]),
          ),
        );
        Object.assign(markerRecords, data.markers);
        const knownShapes = new Set(getShapeRecords(shapeRecords).map((record) => record.id));
        data.shapes.forEach((record) => {
          if (!knownShapes.has(record.id)) {
            shapeRecords.push(record);
            shapeRenderer.upsert(record);
          }
        });
        layeredMarkerDisplay.rebuildVisibleMarkers();
        layeredShapeDisplay.rebuildVisibleShapes();
        groups.syncAllShapeGroupsVisibility();
        shapeNameLabelManager?.scheduleRefresh();
        shapeMeasurementManager?.scheduleRefresh();
        refreshColorLegend?.();
      },
    });
    map.on("overlayadd", ({ layer }) => {
      const id = groups.findLayerIdByMarkerGroup(layer);
      if (id) void objectLoader!.load(id);
    });
    map.on("overlayremove", updateLoadStatus);
    map.on("unload", () => objectLoader!.dispose());
    getSelectedLayerIds().forEach((id) => {
      void objectLoader!.load(id);
    });
  }

  if (!isPrint) {
    const ShapeRenderStatusControl = L.Control.extend({
      options: { position: "bottomright" },
      onAdd() {
        const element = L.DomUtil.create("div", "shape-render-status");
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.style.cssText =
          "background:rgba(255,255,255,.92);padding:6px 10px;border-radius:4px;font-size:12px;max-width:240px";
        element.hidden = true;
        L.DomEvent.disableClickPropagation(element);
        L.DomEvent.disableScrollPropagation(element);
        shapeRenderStatus = element;
        return element;
      },
    });
    const control = new ShapeRenderStatusControl();
    map.addControl(control);
    if (isMobile) registerHideableMapControl!(control);
  }

  // 設定・グループ・イベントの初期化後に一度だけ生成を開始する。
  shapeRenderer.refresh();

  const requireCaptureReady = (action: "共有" | "印刷") => {
    const load = objectLoader?.getStatus();
    if (load?.loading || load?.failed || advancedSearch?.isBusy())
      throw Error(
        `地図データの取得と絞り込み・色分けの完了後に${action}してください。取得に失敗したグループは再チェックしてください。`,
      );
  };
  const runtime = {
    setColoringController: (controller) => {
      coloringController = controller;
    },
    shapeRenderer,
    getShapeRecord: (id: string) => shapeRenderer.getRecord(id),
    getShapeGeometryInfo: (id: string) => shapeRenderer.getGeometryInfo(id),
    isShapeLogicallyVisible,
    getRenderableShapeIds: () =>
      shapeRenderer
        .getRecords()
        .filter((record) => shapeRenderer.isRenderable(record.id))
        .map((record) => String(record.id)),
    getVisibleShapeIds: () =>
      shapeRenderer
        .getRecords()
        .filter((record) => isShapeLogicallyVisible(record.id))
        .map((record) => String(record.id)),
    onShapeLayerCreated(listener: (layer: any, record: any) => void, first = false) {
      if (first) {
        const existing = [...shapeCreatedListeners];
        shapeCreatedListeners.clear();
        shapeCreatedListeners.add(listener);
        existing.forEach((previous) => shapeCreatedListeners.add(previous));
      } else shapeCreatedListeners.add(listener);
      return () => shapeCreatedListeners.delete(listener);
    },
    onShapeLayerEvicted(listener: (layer: any, record: any) => void) {
      shapeEvictedListeners.add(listener);
      return () => shapeEvictedListeners.delete(listener);
    },
    hasInheritedMapView: Boolean(answerMapView),
    popupContent,
    getPrintState: (): PrintMapState => {
      const center = map.getCenter();
      return {
        view: { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() },
        tileServerId: document.querySelector<HTMLInputElement>(".tile-radio:checked")?.value || "1",
        overlays: tileOverlayManager.getVisibility(),
        coloring: coloringController?.getState() || undefined,
        objectQuery: shapeSearchQuery,
        markerIds: attributeTargetMask
          ? [...attributeTargetMask].filter((k) => k.startsWith("marker:")).map((k) => k.slice(7))
          : null,
        shapeIds: attributeTargetMask
          ? [...attributeTargetMask].filter((k) => k.startsWith("shape:")).map((k) => k.slice(6))
          : null,
        clusteringEnabled: markerClustering?.getEnabled() ?? true,
        clusteringAllowed,
        clusteringMinZoom: markerClustering?.minZoom,
        markersVisible: map.hasLayer(visibleMarkerGroup),
        shapesVisible: map.hasLayer(shapeVisibilityLayer),
        shapeNamesVisible: map.hasLayer(shapeNameVisibilityLayer),
        layerIds: Object.keys(layerVisibilityGroups).filter((id) =>
          map.hasLayer(layerVisibilityGroups[id]),
        ),
      };
    },
    getShareSnapshot: () => {
      requireCaptureReady("共有");
      return createShareMapSnapshot(
        {
          layers,
          markers: markerRecords,
          shapes: getShapeRecords(shapeRecords),
          tileServers,
          tileOverlays,
        },
        runtime.getPrintState(),
        getVisibleObjectKeys(),
      );
    },
    setAnswerTargets: answerVisibility.setAnswerTargets,
    setLegendHiddenTargets: answerVisibility.setLegendHiddenTargets,
    applyShapeArrowStyle: shapeArrow.applyShapeArrowStyle,
    visibleMarkerGroup,
    getObjectLoadStatus: () => {
      const objects = objectLoader?.getStatus() ?? { loading: false, failed: false };
      return { ...objects, loading: objects.loading || shapeRenderer.getStats().pendingCount > 0 };
    },
    retryObjectLoads: () => objectLoader?.retrySelected(),
    map,
    markers,
    shapeLayers,
    shapeNameLabelManager,
    tileControl: mapRuntime.tileControl,
    layerControl: markerLayerControl.layersControl,
    visibilityControl,
    printVisibilityLayers: [
      visibleMarkerGroup,
      shapeVisibilityLayer,
      shapeNameVisibilityLayer,
      ...tileOverlayManager.getLayers(),
    ],
  };
  if (!isPrint && ((isAnother && !isAnswerPreview) || sharedSnapshot)) {
    let legend: ReturnType<typeof createColorLegend> | undefined;
    let coloring: AnswerColoring | null = null;
    refreshColorLegend = () => {
      let entries: AnswerColoring["rules"] = [];
      if (coloring) {
        const used = new Set(
          [...getVisibleObjectKeys(coloring.targets)].map((key) => coloring.targets[key]),
        );
        entries = coloring.rules.filter((rule) => used.has(rule.id));
      }
      if (!legend && !entries.length) return;
      legend ??= createColorLegend({ mapElement: map.getContainer() });
      legend.setEntries(entries);
    };
    coloringController = installAnswerColoring(runtime, L, (state) => {
      coloring = state;
      refreshColorLegend?.();
    });
    if (sharedSnapshot) coloringController.apply(initialState.coloring || null);
    const onVisibilityChange = ({ layer }) => {
      if (
        layer === visibleMarkerGroup ||
        layer === shapeVisibilityLayer ||
        groups.findLayerIdByMarkerGroup(layer)
      )
        refreshColorLegend?.();
    };
    map.on("overlayadd overlayremove", onVisibilityChange);
    map.on("unload", () => {
      map.off("overlayadd overlayremove", onVisibilityChange);
      refreshColorLegend = undefined;
      legend?.dispose();
    });
  }
  if (!isPrint && sharedSnapshot && initialState.objectQuery) {
    searchCoordinator.setMapObjectSearchQuery(initialState.objectQuery);
    const input = document.querySelector<HTMLInputElement>(".marker-search-input");
    if (input) input.value = initialState.objectQuery;
  }
  if (expectedPage === "map-anather" && !isAnswerPreview && !isPrint) {
    const disposeClose = installReadOnlyFullscreenClose(bootstrap.shareParentOrigins || []);
    if (disposeClose) map.once("unload", disposeClose);
    const messages = createMapMessageDialog();
    const control = L.control({ position: "topleft" });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "custom-control-button";
    button.textContent = "現在の地図を共有する";
    button.addEventListener("click", () => {
      try {
        const targetOrigin = resolveShareParentOrigin(
          document.referrer,
          location.origin,
          bootstrap.shareParentOrigins || [],
        );
        if (!targetOrigin) throw Error("許可されたアプリの全画面地図から共有してください。");
        const snapshot = runtime.getShareSnapshot();
        window.parent.postMessage({ type: "shareMapSnapshot", snapshot }, targetOrigin);
      } catch (error) {
        messages.show(
          error instanceof Error ? error.message : "地図を取得できませんでした。",
          "共有エラー",
        );
      }
    });
    control.onAdd = () => {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      container.append(button);
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
    control.addTo(map);
    map.on("unload", () => messages.dispose());
  }
  if (
    !isPrint &&
    !isAnswerPreview &&
    (expectedPage === "map-anather" || expectedPage === "temporary-map")
  ) {
    let printHost: ReturnType<typeof openMapPrintPreview> | undefined;
    let printMessages: ReturnType<typeof createMapMessageDialog> | undefined;
    const openPrint = () => {
      if (printHost || document.querySelector("dialog[open]")) return;
      try {
        requireCaptureReady("印刷");
        const snapshot = createReadOnlyPrintSnapshot(
          {
            sourcePage: expectedPage,
            snapshotShare: Boolean(sharedSnapshot),
            layers,
            markers: markerRecords,
            shapes: getShapeRecords(shapeRecords),
            tileServers,
            tileOverlays,
          },
          runtime.getPrintState(),
          getVisibleObjectKeys(),
        );
        printHost = openMapPrintPreview({
          url: READ_ONLY_MAP_PRINT_PATH,
          snapshot: true,
          getState: async () => snapshot,
          close: () => {
            printHost = undefined;
          },
        });
      } catch (error) {
        printMessages ??= createMapMessageDialog();
        printMessages.show(
          error instanceof Error ? error.message : "印刷用の地図を作成できませんでした。",
          "印刷エラー",
        );
      }
    };
    const control = L.control({ position: "topleft" });
    control.onAdd = () => {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "custom-control-button";
      button.textContent = "地図を印刷";
      button.addEventListener("click", openPrint);
      container.append(button);
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
    control.addTo(map);
    const onPrintShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key.toLowerCase() !== "p"
      )
        return;
      event.preventDefault();
      if (!event.repeat) openPrint();
    };
    const onParentPrint = (event: MessageEvent) => {
      if (
        event.data?.type !== "readOnlyPrintOpen" ||
        event.source !== window.parent ||
        window.parent === window
      )
        return;
      const origin = resolveShareParentOrigin(
        document.referrer,
        location.origin,
        bootstrap.shareParentOrigins || [],
      );
      if (origin && event.origin === origin) openPrint();
    };
    const disposePrint = () => {
      window.removeEventListener("keydown", onPrintShortcut);
      window.removeEventListener("message", onParentPrint);
      window.removeEventListener("pagehide", disposePrint);
      map.off("unload", disposePrint);
      printHost?.dispose();
      printMessages?.dispose();
    };
    window.addEventListener("keydown", onPrintShortcut);
    if (expectedPage === "map-anather") window.addEventListener("message", onParentPrint);
    window.addEventListener("pagehide", disposePrint, { once: true });
    map.once("unload", disposePrint);
  }
  return runtime;
}
