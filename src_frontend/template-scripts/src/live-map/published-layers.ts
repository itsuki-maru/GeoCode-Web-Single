import { escapeHtml, markerOptionsForLayer, enableMarkerIconFallback } from "../map/common/marker";
import { createShapeStyleCore } from "../map/common/shape-style";
import { createShapeArrowRuntime } from "../map/common/shape-arrow";
import { createShapeLayerRuntime } from "../map/common/shape-layer";
import { createShapeNameLabelBinder } from "../map/common/shape-restoration";
import { createShapeViewportRuntime } from "../map/common/shape-viewport";
import { createShapeMeasurementRuntime } from "../map/common/shape-measurement";
import { flattenShapeLatLngs } from "../map/common/shape-measurement-display";
import { normalizeShapeName, getShapeMemoFromGeoJson } from "../map/common/shape-memo";
import {
  createNestedTokenizer,
  isLocalhost,
  isPDF,
  renderIframe,
  setupDetailsLazyImages,
} from "../map/common/content";
import { extractYouTubeId } from "../map/common/base";
import { installMapMarkdownExtensions } from "../map/common/markdown-extensions";
import { installMapMarkdownRenderer } from "../map/common/markdown-renderer";
import { createCollapsibleLayerControl } from "./controls";

export interface PublishedLayers {
  layers: Array<{ id: string; layer_name: string; marker_icon_filename?: string | null }>;
  markers: Array<{
    id: string;
    layer_id: string;
    marker_name: string;
    latitude: number;
    longitude: number;
    detail: string;
  }>;
  shapes: Array<{
    id: string;
    layer_id: string;
    shape_type: string;
    name?: string | null;
    geojson: any;
  }>;
}

// These libraries are supplied by the template, as on the other read-only maps.
export function addPublishedLayerControl(
  leaflet: any,
  map: any,
  data: PublishedLayers | undefined,
  isMobile: boolean,
) {
  if (!data?.layers.length) return null;
  const { marked, filterXSS } = window as any;
  installMapMarkdownExtensions({
    createNestedTokenizer: createNestedTokenizer as any,
    extractYouTubeId,
    marked,
  });
  const xssOptions = installMapMarkdownRenderer({
    enablePwaDownloads: false,
    imageMode: "html-preview",
    isLocalhost,
    isPdf: isPDF,
    marked,
  });
  const popupContent = (name: string, memo: string) =>
    `<div class="md-detail-contents"><h1>${escapeHtml(name)}</h1>${renderIframe(filterXSS(marked.parse(memo), xssOptions))}</div>`;
  const bindContent = (layer: any, name: string, memo: string, showHoverName = true) => {
    if (showHoverName && name) layer.bindTooltip(escapeHtml(name));
    layer.bindPopup(popupContent(name, memo), { className: "live-published-popup" });
    layer.on("popupopen", (event: any) => {
      const element = event.popup.getElement();
      if (element) setupDetailsLazyImages(element);
    });
  };
  const defaults = { color: "#3388ff", weight: 3, fillOpacity: 0.2 };
  const style = createShapeStyleCore(() => defaults);
  const arrows = createShapeArrowRuntime({ getDefaultStyle: () => defaults, ...style });
  const shapes = createShapeLayerRuntime({
    bindShapeArrowStyle: (layer: any) => arrows.bindShapeArrowStyle(layer),
    getCircleRadiusFromGeoJson: (geojson: any) => {
      const radius = Number(geojson?.properties?.radius);
      return Number.isFinite(radius) && radius > 0 ? radius : null;
    },
    getLeaflet: () => leaflet,
    getMap: () => map,
    getTooltipVisible: () => false,
    setTooltipVisible: () => {},
  });
  const control = leaflet.control
    .layers(null, null, { collapsed: false, position: "topright" })
    .addTo(map);
  const container = control.getContainer();
  container.classList.add("live-published-layer-control");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "レイヤ（マーカー・図形）");
  const groups = new Map<string, { group: any; record: PublishedLayers["layers"][number] }>();
  for (const record of data.layers) {
    const group = leaflet.layerGroup().addTo(map);
    groups.set(record.id, { group, record });
    control.addOverlay(group, escapeHtml(record.layer_name));
  }
  // Only published markers enter this shared cluster; shapes stay in their visibility groups.
  const markerCluster = leaflet.markerClusterGroup().addTo(map);
  const publishedMarkers: Array<{ group: any; marker: any }> = [];
  const layerRecords = Object.fromEntries(data.layers.map((record) => [record.id, record]));
  for (const record of data.markers) {
    const target = groups.get(record.layer_id);
    if (!target || !Number.isFinite(record.latitude) || !Number.isFinite(record.longitude))
      continue;
    const marker = leaflet.marker(
      [record.latitude, record.longitude],
      markerOptionsForLayer(record.layer_id, layerRecords),
    );
    enableMarkerIconFallback(marker, record.layer_id, layerRecords);
    bindContent(marker, record.marker_name, record.detail);
    publishedMarkers.push({ group: target.group, marker });
  }
  const publishedShapes: any[] = [];
  for (const record of data.shapes) {
    const target = groups.get(record.layer_id);
    if (!target) continue;
    try {
      const layer: any = shapes.createLeafletShapeLayer(record.shape_type, record.geojson, {
        ...style.getShapeStyleFromGeoJson(record.shape_type, record.geojson),
      });
      if (!layer) continue;
      bindContent(layer, record.name ?? "", getShapeMemoFromGeoJson(record.geojson), false);
      layer.shapeName = normalizeShapeName(record.name);
      layer.shapeType = record.shape_type;
      layer.shapeStyle = style.getShapeStyleFromGeoJson(record.shape_type, record.geojson);
      publishedShapes.push(layer);
      layer.addTo(target.group);
    } catch (error) {
      console.warn("公開レイヤの図形を読み込めませんでした。", record.id, error);
    }
  }
  const measurement = createShapeMeasurementRuntime({
    escapeHtml, flattenShapeLatLngs,
    getDefaultShapeColor: () => defaults.color,
    getLeaflet: () => leaflet, getMap: () => map,
    getSegmentLabelGroupSize: () => 1,
    normalizeShapeColor: style.normalizeShapeColor,
  });
  const bindLabel = createShapeNameLabelBinder({
    escapeHtml, normalizeShapeName,
    normalizeShapeColor: style.normalizeShapeColor,
    getDefaultShapeColor: () => defaults.color,
    attachShapeMemoTooltipOpen: (layer: any, latLng) => {
      const element = layer.getTooltip()?.getElement();
      if (!element || element.dataset.liveShapePopupBound) return;
      element.dataset.liveShapePopupBound = "true";
      leaflet.DomEvent.on(element, "click", (event: Event) => {
        leaflet.DomEvent.stop(event);
        layer.openPopup(latLng);
      });
    },
  });
  const shapeLabels = createShapeViewportRuntime({ getShapeRecords: () => data.shapes })
    .createViewportShapeLabelManager({
      map, getLayers: () => publishedShapes, bindLabel,
      shouldBind: (layer) => Boolean(normalizeShapeName(layer.shapeName)),
      getLabelLatLng: (layer: any) => layer.shapeType === "polyline"
        ? measurement.getPolylineCenterLatLng(layer)
        : layer.shapeType === "circle" ? layer.getLatLng() : layer.getBounds().getCenter(),
    });
  shapeLabels.refresh();
  map.on("unload", () => shapeLabels.destroy());
  const syncMarkers = () => {
    markerCluster.clearLayers();
    markerCluster.addLayers(
      publishedMarkers.filter(({ group }) => map.hasLayer(group)).map(({ marker }) => marker),
    );
  };
  const visibilityGroups = new Set([...groups.values()].map(({ group }) => group));
  map.on("layeradd layerremove", (event: { layer: any }) => {
    if (visibilityGroups.has(event.layer)) {
      syncMarkers();
      shapeLabels.scheduleRefresh();
    }
  });
  syncMarkers();
  const collapsible = isMobile ? createCollapsibleLayerControl({ container, leaflet, map }) : null;
  return { control, collapsible };
}
