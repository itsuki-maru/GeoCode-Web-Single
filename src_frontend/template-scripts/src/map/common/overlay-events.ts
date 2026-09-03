interface OverlayEvent {
  layer: object;
}

interface OverlayEventMap {
  on(eventName: "overlayadd" | "overlayremove", handler: (event: OverlayEvent) => void): void;
}

interface ShapeNameLabelManager {
  setEnabled(enabled: boolean): void;
}

interface MarkerDisplayManager {
  rebuildVisibleMarkers(): void;
}

interface ShapeDisplayManager {
  rebuildVisibleShapes(): void;
}

interface ReadOnlyOverlayHandlerOptions {
  clearMapObjectSearch: () => void;
  findLayerIdByMarkerGroup: (layer: object) => string | null | undefined;
  map: OverlayEventMap;
  markerDisplay: MarkerDisplayManager;
  onMarkerVisibilityChange?: (visible: boolean) => void;
  onShapeNameVisibilityChange?: (visible: boolean) => void;
  onShapeVisibilityChange?: (visible: boolean) => void;
  schedule?: (callback: () => void) => unknown;
  shapeDisplay: ShapeDisplayManager;
  shapeNameLabelManager: ShapeNameLabelManager;
  shapeNameVisibilityLayer: object;
  shapeVisibilityLayer: object;
  syncAllShapeGroupsVisibility: () => void;
  syncShapeGroupVisibility: (layerId: string) => void;
  visibleMarkerGroup?: object;
}

export function installReadOnlyOverlayHandlers({
  clearMapObjectSearch,
  findLayerIdByMarkerGroup,
  map,
  markerDisplay,
  onMarkerVisibilityChange,
  onShapeNameVisibilityChange,
  onShapeVisibilityChange,
  schedule = (callback) => setTimeout(callback, 0),
  shapeDisplay,
  shapeNameLabelManager,
  shapeNameVisibilityLayer,
  shapeVisibilityLayer,
  syncAllShapeGroupsVisibility,
  syncShapeGroupVisibility,
  visibleMarkerGroup,
}: ReadOnlyOverlayHandlerOptions): void {
  map.on("overlayadd", (event) => {
    if (visibleMarkerGroup && event.layer === visibleMarkerGroup) {
      onMarkerVisibilityChange?.(true);
      return;
    }
    if (event.layer === shapeNameVisibilityLayer) {
      shapeNameLabelManager.setEnabled(true);
      onShapeNameVisibilityChange?.(true);
      return;
    }
    if (event.layer === shapeVisibilityLayer) {
      onShapeVisibilityChange?.(true);
      syncAllShapeGroupsVisibility();
      return;
    }

    const layerId = findLayerIdByMarkerGroup(event.layer);
    if (!layerId) return;

    clearMapObjectSearch();
    schedule(() => syncShapeGroupVisibility(layerId));
  });

  map.on("overlayremove", (event) => {
    if (visibleMarkerGroup && event.layer === visibleMarkerGroup) {
      onMarkerVisibilityChange?.(false);
      return;
    }
    if (event.layer === shapeNameVisibilityLayer) {
      shapeNameLabelManager.setEnabled(false);
      onShapeNameVisibilityChange?.(false);
      return;
    }
    if (event.layer === shapeVisibilityLayer) {
      onShapeVisibilityChange?.(false);
      syncAllShapeGroupsVisibility();
      return;
    }

    const layerId = findLayerIdByMarkerGroup(event.layer);
    if (!layerId) return;

    markerDisplay.rebuildVisibleMarkers();
    shapeDisplay.rebuildVisibleShapes();
    syncShapeGroupVisibility(layerId);
  });
}
