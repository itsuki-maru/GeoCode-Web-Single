interface ReadOnlyLayerRecord {
  id: string;
  layer_name: string;
}

interface ReadOnlyMarkerRecord {
  detail?: string;
  id: string | number;
  latitude: number;
  layer_id: string | null;
  longitude: number;
  marker_name: string;
}

interface ReadOnlyShapeRecord {
  layer_id: string | null;
}

interface MarkerLayer {
  bindPopup(content: string): MarkerLayer;
  bindTooltip(content: string, options: { permanent: boolean }): MarkerLayer;
  getElement(): HTMLElement | null;
  on(eventName: string, handler: () => void): MarkerLayer;
}

interface LayerGroup {
  addLayer(layer: MarkerLayer): unknown;
  addTo(map: MarkerLayerMap): unknown;
}

interface MarkerLayerMap {}

interface LayerControl {
  addOverlay(layer: LayerGroup, name: string): void;
  addTo(map: MarkerLayerMap): unknown;
}

interface LayeredMarkerDisplay {
  findLayerIdByVisibilityGroup(group: object): string | null;
  isLayerVisible(layerId: string): boolean;
  rebuildVisibleMarkers(): void;
}

interface LeafletNamespace {
  control: {
    layers(
      baseLayers: null,
      overlays: null,
      options: { collapsed: boolean },
    ): LayerControl;
  };
  marker(
    latLng: [number, number],
    options: Record<string, unknown>,
  ): MarkerLayer;
}

interface HydrateMarkerOptions {
  clusterGroups: Record<string, LayerGroup>;
  createMarkerGroupForLayer: (
    layerId: string | null | undefined,
  ) => LayerGroup | null;
  documentRoot?: Document;
  enableMarkerIconFallback?: (
    marker: MarkerLayer,
    layerId: string | null,
    layerRecords: Record<string, ReadOnlyLayerRecord>,
  ) => unknown;
  escapeHtml: (value: unknown) => string;
  initialLayersVisible?: boolean;
  layerNames: Record<string, string>;
  layerRecords: Record<string, ReadOnlyLayerRecord>;
  layerVisibilityGroups: Record<string, LayerGroup>;
  leaflet: LeafletNamespace;
  map: MarkerLayerMap;
  markerOptionsForLayer: (
    layerId: string | null,
    layerRecords: Record<string, ReadOnlyLayerRecord>,
  ) => Record<string, unknown>;
  markerRecords: Record<string, ReadOnlyMarkerRecord>;
  markers: Record<string, MarkerLayer>;
  parseMarkdown: (markdown: string) => string;
  renderIframe: (html: string) => string;
  sanitizeHtml: (html: string) => string;
  setupDetailsLazyImages: (documentRoot: Document) => void;
  shapeRecords:
    | ReadOnlyShapeRecord[]
    | Record<string, ReadOnlyShapeRecord>;
}

interface CreateMarkerLayerControlOptions {
  clusterGroups: Record<string, LayerGroup>;
  createLayeredMarkerDisplayManager: (options: {
    layerVisibilityGroups: Record<string, LayerGroup>;
    map: MarkerLayerMap;
    markerRecords: Record<string, ReadOnlyMarkerRecord>;
    markers: Record<string, MarkerLayer>;
    visibleMarkerGroup: LayerGroup;
  }) => LayeredMarkerDisplay;
  escapeHtml: (value: unknown) => string;
  layerNames: Record<string, string>;
  layerVisibilityGroups: Record<string, LayerGroup>;
  leaflet: LeafletNamespace;
  map: MarkerLayerMap;
  markerRecords: Record<string, ReadOnlyMarkerRecord>;
  markers: Record<string, MarkerLayer>;
  skipUnnamedLayers?: boolean;
  visibleMarkerGroup: LayerGroup;
}

export function hydrateReadOnlyMarkers({
  clusterGroups,
  createMarkerGroupForLayer,
  documentRoot = document,
  enableMarkerIconFallback,
  escapeHtml,
  initialLayersVisible = false,
  layerNames,
  layerRecords,
  layerVisibilityGroups,
  leaflet,
  map,
  markerOptionsForLayer,
  markerRecords,
  markers,
  parseMarkdown,
  renderIframe,
  sanitizeHtml,
  setupDetailsLazyImages,
  shapeRecords,
}: HydrateMarkerOptions): void {
  Object.values(layerRecords).forEach((layerRecord) => {
    layerNames[layerRecord.id] ??= layerRecord.layer_name;
  });

  Object.values(markerRecords).forEach((markerData) => {
    const markerGroup = createMarkerGroupForLayer(markerData.layer_id);
    if (!markerGroup) return;

    const marker = leaflet
      .marker(
        [markerData.latitude, markerData.longitude],
        markerOptionsForLayer(markerData.layer_id, layerRecords),
      )
      .bindPopup(escapeHtml(markerData.marker_name));
    enableMarkerIconFallback?.(
      marker,
      markerData.layer_id,
      layerRecords,
    );
    marker.on("popupopen", () => setupDetailsLazyImages(documentRoot));
    markerGroup.addLayer(marker);

    const tooltipName = markerData.marker_name
      ? escapeHtml(markerData.marker_name)
      : "No Name";
    marker.bindTooltip(`<div class="custom-tooltip">${tooltipName}</div>`, {
      permanent: false,
    });

    if (markerData.detail) {
      const markdown = `# ${markerData.marker_name}\n\n${markerData.detail}`;
      const renderedHtml = renderIframe(sanitizeHtml(parseMarkdown(markdown)));
      marker.bindPopup(`<div class="md-detail-contents">${renderedHtml}</div>`);
    }

    const markerElement = marker.getElement();
    if (markerElement) markerElement.id = `marker-${markerData.id}`;
    markers[`marker-${markerData.id}`] = marker;
  });

  const normalizedShapeRecords = Array.isArray(shapeRecords)
    ? shapeRecords
    : Object.values(shapeRecords);
  normalizedShapeRecords.forEach((shape) => {
    createMarkerGroupForLayer(shape.layer_id);
  });

  if (initialLayersVisible) {
    Object.values(layerVisibilityGroups).forEach((group) => group.addTo(map));
  }
}

export function createReadOnlyMarkerLayerControl({
  clusterGroups,
  createLayeredMarkerDisplayManager,
  escapeHtml,
  layerNames,
  layerVisibilityGroups,
  leaflet,
  map,
  markerRecords,
  markers,
  skipUnnamedLayers = false,
  visibleMarkerGroup,
}: CreateMarkerLayerControlOptions) {
  const layersControl = leaflet.control.layers(null, null, {
    collapsed: false,
  });
  const layerControlOverlayLayers: LayerGroup[] = [];

  Object.keys(clusterGroups).forEach((layerId) => {
    const layerName = escapeHtml(layerNames[layerId]);
    if (skipUnnamedLayers && !layerName) return;

    const visibilityGroup = layerVisibilityGroups[layerId];
    if (!visibilityGroup) return;
    layersControl.addOverlay(visibilityGroup, layerName);
    layerControlOverlayLayers.push(visibilityGroup);
  });
  layersControl.addTo(map);

  const layeredMarkerDisplay = createLayeredMarkerDisplayManager({
    map,
    markerRecords,
    markers,
    visibleMarkerGroup,
    layerVisibilityGroups,
  });
  layeredMarkerDisplay.rebuildVisibleMarkers();

  return { layeredMarkerDisplay, layerControlOverlayLayers, layersControl };
}
