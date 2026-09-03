interface FocusLayer {
  addTo(map: FocusMap): unknown;
  isDeletedShape?: boolean;
  shapeId?: unknown;
  shapeName?: unknown;
}

interface FocusMap {
  closePopup?(): void;
  hasLayer(layer: object): boolean;
  on(eventName: string, listener: (event: { layer?: object }) => void): void;
  removeLayer(layer: object): void;
  setView(latLng: object, zoom: number): void;
}

interface FocusLayerGroup<TLayer extends object> {
  addLayer(layer: TLayer): void;
  hasLayer(layer: TLayer): boolean;
  zoomToShowLayer?(layer: TLayer, callback: () => void): void;
}

interface ShapeLabelManager {
  setFocusedLayer(layer: FocusLayer | null): void;
}

interface MapObjectFocusDependencies<TMarker extends object> {
  createLatLng(latitude: unknown, longitude: unknown): object;
  drawnShapesGroup: FocusLayerGroup<FocusLayer>;
  isValidCoordinate(latitude: unknown, longitude: unknown): boolean;
  map: FocusMap;
  markers: Record<string, TMarker>;
  markersClusterGroup: FocusLayerGroup<TMarker>;
  normalizeShapeName(name: unknown): string;
  openMarkerPopup(markerId: string | number): void;
  openShapeMemoPopup(layer: FocusLayer, latLng: object): boolean;
  searchableShapeLayers: Iterable<FocusLayer>;
  shapeNameLabelManager?: ShapeLabelManager | null;
}

export function createMapObjectFocusController<TMarker extends object>({
  createLatLng,
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
}: MapObjectFocusDependencies<TMarker>) {
  let focusedShapeLayer: FocusLayer | null = null;
  let focusedShapeLayerIsTemporary = false;

  const clearFocusedShapeFocus = (targetLayer: FocusLayer | null = null): void => {
    if (!focusedShapeLayer || (targetLayer && focusedShapeLayer !== targetLayer)) {
      return;
    }
    shapeNameLabelManager?.setFocusedLayer(null);
    if (focusedShapeLayerIsTemporary && map.hasLayer(focusedShapeLayer)) {
      map.removeLayer(focusedShapeLayer);
    }
    map.closePopup?.();
    focusedShapeLayer = null;
    focusedShapeLayerIsTemporary = false;
  };

  const releaseFocusedShapeToVisibleGroup = (): void => {
    if (!focusedShapeLayer) return;
    shapeNameLabelManager?.setFocusedLayer(null);
    if (!drawnShapesGroup.hasLayer(focusedShapeLayer)) {
      map.removeLayer(focusedShapeLayer);
    }
    focusedShapeLayer = null;
    focusedShapeLayerIsTemporary = false;
  };

  const focusMarker = (
    markerId: string | number,
    latitude: unknown,
    longitude: unknown,
  ): void => {
    clearFocusedShapeFocus();
    if (latitude === "" || longitude === "" || !isValidCoordinate(latitude, longitude)) {
      console.log("Not value.");
      return;
    }
    map.setView(createLatLng(latitude, longitude), 16);
    if (!markerId) return;
    const marker = markers[`marker-${markerId}`];
    if (!marker) return;
    if (!markersClusterGroup.hasLayer(marker)) markersClusterGroup.addLayer(marker);
    if (markersClusterGroup.zoomToShowLayer) {
      markersClusterGroup.zoomToShowLayer(marker, () => openMarkerPopup(markerId));
    } else {
      openMarkerPopup(markerId);
    }
  };

  const focusShape = (
    shapeIdValue: string | number,
    latitude: unknown,
    longitude: unknown,
  ): void => {
    clearFocusedShapeFocus();
    map.closePopup?.();
    if (latitude === "" || longitude === "" || !isValidCoordinate(latitude, longitude)) {
      console.log("Not value.");
      return;
    }
    const latLng = createLatLng(latitude, longitude);
    map.setView(latLng, 16);
    const shapeId = String(shapeIdValue || "");
    if (!shapeId) return;
    const targetLayer = Array.from(searchableShapeLayers).find(
      (layer) => String(layer.shapeId || "") === shapeId,
    );
    if (!targetLayer || targetLayer.isDeletedShape) return;

    focusedShapeLayer = targetLayer;
    focusedShapeLayerIsTemporary = !map.hasLayer(targetLayer);
    if (focusedShapeLayerIsTemporary) targetLayer.addTo(map);
    shapeNameLabelManager?.setFocusedLayer(
      normalizeShapeName(targetLayer.shapeName) ? targetLayer : null,
    );
    openShapeMemoPopup(targetLayer, latLng);
  };

  const focusMapObject = (
    objectType: string,
    id: string | number,
    latitude: unknown,
    longitude: unknown,
  ): void => {
    if (objectType === "shape") focusShape(id, latitude, longitude);
    else focusMarker(id, latitude, longitude);
  };

  map.on("overlayadd", (event) => {
    if (event.layer === drawnShapesGroup) releaseFocusedShapeToVisibleGroup();
  });
  map.on("overlayremove", (event) => {
    if (event.layer === drawnShapesGroup) clearFocusedShapeFocus();
  });

  return { clearFocusedShapeFocus, focusMapObject };
}
