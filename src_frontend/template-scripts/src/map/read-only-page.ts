// @ts-nocheck -- Leaflet plugins expose incompatible structural types at this integration boundary.
import { createTileOverlayManager } from "./common/tile-overlays";
import type { PrintMapState } from "./common/print-state";
import { readMapBootstrap } from "./bootstrap";
import { createLayerBulkToggleControl, extractYouTubeId } from "./common/base";
import {
  createNestedTokenizer,
  isLocalhost,
  isPDF,
  isValidCoordinate,
  renderIframe,
  setupDetailsLazyImages,
} from "./common/content";
import { installMapContentActions } from "./common/content-actions";
import { createReadOnlyLayerGroupRuntime } from "./common/layer-groups";
import { installMapMarkdownExtensions } from "./common/markdown-extensions";
import { downloadMapContentFile, installMapMarkdownRenderer } from "./common/markdown-renderer";
import { createReadOnlyMapRuntime } from "./common/map-runtime";
import { createMapUiVisibilityRuntime } from "./common/map-ui-visibility";
import { loadLastMapView, observeMapView } from "./common/map-view-persistence";
import {
  enableMarkerIconFallback,
  escapeHtml,
  initializeUserLocation,
  markerOptionsForLayer,
} from "./common/marker";
import { createReadOnlyMarkerLayerControl, hydrateReadOnlyMarkers } from "./common/marker-layers";
import { installReadOnlyOverlayHandlers } from "./common/overlay-events";
import {
  addReadOnlyMapVisibilityControls,
  addReadOnlySearchControls,
} from "./common/page-controls";
import {
  createLayeredMarkerDisplayManager,
  createLayeredShapeDisplayManager,
  createMapObjectSearchCoordinator,
  createMapSearchRuntime,
  filterMeasurementMarkersForBounds,
  getShapeRecords,
} from "./common/search";
import { createShapeArrowRuntime } from "./common/shape-arrow";
import { createShapeLayerRuntime } from "./common/shape-layer";
import { createShapeMeasurementRuntime } from "./common/shape-measurement";
import { createReadOnlyShapeMeasurementDisplayRuntime } from "./common/shape-measurement-display";
import {
  createShapeMemoRuntime,
  getShapeMemoFromGeoJson,
  normalizeShapeName,
} from "./common/shape-memo";
import { createReadOnlyShapeRestorationRuntime } from "./common/shape-restoration";
import { createShapeStyleCore } from "./common/shape-style";
import { createShapeViewportRuntime } from "./common/shape-viewport";
import { createMapStorage, createTileChangeHandler } from "./common/storage";
import {
  createMeasurementVisibilityControl,
  createTooltipVisibilityControl,
} from "./common/visibility-controls";

type ReadOnlyPageName = "map-anather" | "temporary-map" | "temporary-map-mobile";

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
) {
  const bootstrap = readMapBootstrap();
  if (bootstrap.page !== expectedPage) {
    throw new Error(`Unexpected map bootstrap page: ${bootstrap.page}`);
  }
  if (bootstrap.page === "map" || bootstrap.page === "map-mobile") {
    throw new Error("Editable map bootstrap is not supported");
  }

  const { L, filterXSS, marked } = getBrowserLibraries();
  const isAnother = expectedPage === "map-anather";
  const isPrint = isAnother && Boolean(printState);
  const persistSettings = isAnother && !isPrint;
  const isMobile = expectedPage === "temporary-map-mobile";
  const isTemporary = !isAnother;
  const temporaryBootstrap = isTemporary
    ? (bootstrap as Extract<typeof bootstrap, { page: "temporary-map" | "temporary-map-mobile" }>)
    : null;
  const tileServers = bootstrap.tileServers;
  const layers = bootstrap.layers;
  const markerRecords = bootstrap.markers;
  const shapeRecords = bootstrap.shapes;

  const storage = createMapStorage(tileServers);
  const shapeStyle = createShapeStyleCore(() => SHAPE_STYLE);
  const shapeArrow = createShapeArrowRuntime({
    getDefaultStyle: () => SHAPE_STYLE,
    normalizeShapeArrowType: shapeStyle.normalizeShapeArrowType,
    normalizeShapeColor: shapeStyle.normalizeShapeColor,
    normalizeShapeWeight: shapeStyle.normalizeShapeWeight,
  });
  const viewport = createShapeViewportRuntime({ getShapeRecords });

  installMapMarkdownExtensions({ createNestedTokenizer, extractYouTubeId, marked });
  const xssOptions = installMapMarkdownRenderer({
    enablePwaDownloads: isAnother,
    imageMode: isMobile ? "html-preview" : "direct-preview",
    isLocalhost,
    isPdf: isPDF,
    marked,
  });

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
      initialHidden: temporaryBootstrap!.isMapUiHidden,
      leaflet: L,
    });
    registerHideableMapControl = mobileUi.registerHideableMapControl;
    MapUiVisibilityToggleControl = mobileUi.MapUiVisibilityToggleControl;
  }

  const lastMapView = isAnother ? loadLastMapView() : null;
  const initialView =
    printState?.view ??
    (isAnother ? (lastMapView ?? bootstrap.initialView) : temporaryBootstrap!.initialView);
  const mapRuntime = createReadOnlyMapRuntime({
    center: [initialView.latitude, initialView.longitude],
    escapeHtml,
    handleTileChange,
    leaflet: L,
    onTileControlAdded: registerHideableMapControl,
    tileServers,
    zoom: initialView.zoom,
  });
  map = mapRuntime.map as DynamicRecord;
  if (persistSettings) observeMapView(map);
  bounds = mapRuntime.bounds;
  tileLayer = mapRuntime.tileLayer as DynamicRecord;
  if (isPrint && tileServers[printState.tileServerId]) {
    const radio = Array.from(document.querySelectorAll<HTMLInputElement>(".tile-radio")).find(
      (input) => input.value === printState.tileServerId,
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
  const markers: DynamicRecord = {};
  const layerNames: Record<string, string> = {};
  const visibleMarkerGroup =
    isAnother && !bootstrap.isCluster ? L.featureGroup() : L.markerClusterGroup();
  if (isTemporary || (printState?.markersVisible ?? storage.getInitialMarkerVisibility()))
    visibleMarkerGroup.addTo(map);
  const drawnShapesGroup = isAnother ? L.featureGroup() : undefined;
  const suppressShapes = isAnother && viewport.shouldSuppressInitialShapeRendering(shapeRecords);
  const shapeVisibilityLayer = L.layerGroup();
  if (
    isTemporary ||
    (printState?.shapesVisible ?? (!suppressShapes && storage.getInitialShapeLayerVisibility()))
  ) {
    shapeVisibilityLayer.addTo(map);
  }
  const shapeNameVisibilityLayer = L.layerGroup();
  if (
    isAnother &&
    (printState?.shapeNamesVisible ?? (!suppressShapes && storage.getInitialShapeNameVisibility()))
  ) {
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
    escapeHtml,
    getLeaflet: () => L,
    getMap: () => map,
    renderIframe,
    renderMarkdown: (markdown) => marked.parse(markdown),
    sanitizeHtml: (html) => filterXSS(html, xssOptions),
    setupDetailsLazyImages,
  });
  installMapContentActions({
    downloadFile: isAnother ? downloadMapContentFile : undefined,
    previewImage: (path) =>
      window.parent.postMessage({ message: path, type: "callParentFunction" }, "*"),
  });

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
  const restoration = createReadOnlyShapeRestorationRuntime({
    attachShapeMemoPopup: memo.attachShapeMemoPopup,
    attachShapeMemoTooltipOpen: memo.attachShapeMemoTooltipOpen,
    bindPolylineHoverHighlight: shapeArrow.bindPolylineHoverHighlight,
    createLeafletShapeLayer: shapeLayer.createLeafletShapeLayer,
    escapeHtml,
    getDefaultShapeColor: () => SHAPE_STYLE.color,
    getShapeMemoFromGeoJson,
    getShapeNameLabelManager: () => shapeNameLabelManager,
    getShapeRecords,
    getShapeStyleFromGeoJson: shapeStyle.getShapeStyleFromGeoJson,
    labelAppearance: isAnother ? "pill" : "plain",
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

  hydrateReadOnlyMarkers({
    clusterGroups,
    createMarkerGroupForLayer: groups.createMarkerGroupForLayer,
    enableMarkerIconFallback: isTemporary ? enableMarkerIconFallback : undefined,
    escapeHtml,
    initialLayersVisible: temporaryBootstrap?.isChecked,
    layerNames,
    layerRecords: layers,
    layerVisibilityGroups,
    leaflet: L,
    map,
    markerOptionsForLayer,
    markerRecords,
    markers,
    parseMarkdown: (markdown) => marked.parse(markdown),
    renderIframe,
    sanitizeHtml: (html) => filterXSS(html, xssOptions),
    setupDetailsLazyImages,
    shapeRecords,
  });

  if (isPrint) {
    for (const [id, group] of Object.entries(layerVisibilityGroups)) {
      if (printState.layerIds === null || printState.layerIds.includes(id)) group.addTo(map);
    }
  }

  const hasSharedShapes = restoration.restoreSavedShapes({
    addLayer: isAnother
      ? (layer, layerId) => groups.addShapeLayerToManagedGroups(layer, layerId)
      : (layer, layerId) => {
          const group = groups.ensureShapeGroup(layerId);
          if (!group) return false;
          group.addLayer(layer);
          return true;
        },
    applyShapeStyle: isAnother,
    bindPolylineHover: !isMobile,
    records: shapeRecords,
    restoreShapeStyleOnHover: isAnother,
    shapeLayers,
  });

  const markerLayerControl = createReadOnlyMarkerLayerControl({
    clusterGroups,
    createLayeredMarkerDisplayManager,
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
  if (isTemporary && hasSharedShapes) shapeNameVisibilityLayer.addTo(map);

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
  const layeredShapeDisplay = createLayeredShapeDisplayManager({
    isLayerVisible: layeredMarkerDisplay.isLayerVisible,
    map,
    onRebuild: () => shapeNameLabelManager!.scheduleRefresh(),
    shapeGroups,
    shapeLayers,
    shapeRecords,
  });
  const searchCoordinator = createMapObjectSearchCoordinator({
    markerDisplay: layeredMarkerDisplay,
    shapeDisplay: layeredShapeDisplay,
    syncShapeVisibility: groups.syncAllShapeGroupsVisibility,
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
  if (isAnother) addBulkControl();
  else {
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
    onShapeVisibilityChange: persistSettings ? storage.saveShapeLayerVisibility : undefined,
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
    shapeMeasurementManager?.setEnabled(isMeasurementVisible);
    searchRuntime.updateMeasurementControlState();
  };
  const tooltipControl = createTooltipVisibilityControl({
    leaflet: L,
    onToggle: shapeLayer.toggleTooltips,
    position: isAnother || isMobile ? "topleft" : "topright",
  });
  map.addControl(tooltipControl);
  const includeMeasurementControl = isAnother || hasSharedShapes;
  if (includeMeasurementControl) {
    const control = createMeasurementVisibilityControl({
      leaflet: L,
      onMergeToggle: searchRuntime.toggleMeasurementSegmentMerge,
      onToggle: toggleMeasurementLabels,
      onUpdateState: searchRuntime.updateMeasurementControlState,
      position: isAnother ? "topleft" : "topright",
    });
    map.addControl(control);
    if (isMobile) registerHideableMapControl!(control);
  }

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
  if (isMobile) map.addControl(new MapUiVisibilityToggleControl!());
  const { visibilityControl } = addReadOnlyMapVisibilityControls({
    includeShapeOverlays: isAnother || hasSharedShapes,
    initialUserLocationVisible: isAnother ? storage.getInitialUserLocationVisibility() : undefined,
    initializeUserLocation: isPrint ? () => null : initializeUserLocation,
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

  const tileOverlayManager = createTileOverlayManager(
    L,
    map,
    visibilityControl,
    persistSettings ? bootstrap.tileVisibilityAccountId : undefined,
    temporaryBootstrap?.isOverlayTile ?? true,
    isMobile ? { onControlAdded: registerHideableMapControl } : undefined,
  );
  tileOverlayManager.sync(bootstrap.tileOverlays || []);
  if (isPrint) tileOverlayManager.setVisibility(printState.overlays);

  return {
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
}
