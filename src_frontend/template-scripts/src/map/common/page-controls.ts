type MapLayer = object;
type MapControl = object;

interface OverlayEvent {
  layer: MapLayer;
}

interface ControlMap {
  addControl(control: MapControl): void;
  on(
    eventName: "overlayadd" | "overlayremove",
    handler: (event: OverlayEvent) => void,
  ): void;
  removeLayer(layer: MapLayer): void;
}

interface LeafletNamespace {
  control: {
    layers(
      baseLayers: null,
      overlays: Record<string, MapLayer>,
      options: { collapsed: boolean; position: string },
    ): { addTo(map: ControlMap): MapControl };
  };
}

interface MarkerSearchControlOptions {
  clusterGroups: Record<string, MapLayer>;
  markerRecords: Record<string, unknown>;
  markers: Record<string, MapLayer>;
  onClear: (options?: { clearInput?: boolean }) => void;
  onSearch: (query: unknown) => void;
}

interface AddSearchControlsOptions extends MarkerSearchControlOptions {
  createCodeSearchControl: () => MapControl;
  createMarkerSearchControl: (
    options: MarkerSearchControlOptions,
  ) => MapControl;
  map: ControlMap;
  onCodeSearchControlAdded?: (control: MapControl) => void;
  onMarkerSearchControlAdded?: (control: MapControl) => void;
}

interface UserLocationOptions {
  controlClassName?: string;
  position?: string;
}

interface AddMapVisibilityControlsOptions {
  includeShapeOverlays: boolean;
  initialUserLocationVisible?: boolean;
  initializeUserLocation: (
    map: ControlMap,
    options?: UserLocationOptions,
  ) => MapLayer | null;
  leaflet: LeafletNamespace;
  map: ControlMap;
  onUserLocationVisibilityChange?: (visible: boolean) => void;
  onVisibilityControlAdded?: (control: MapControl) => void;
  shapeNameVisibilityLayer: MapLayer;
  shapeVisibilityLayer: MapLayer;
  userLocationOptions?: UserLocationOptions;
  visibleMarkerGroup: MapLayer;
}

export function addReadOnlySearchControls({
  clusterGroups,
  createCodeSearchControl,
  createMarkerSearchControl,
  map,
  markerRecords,
  markers,
  onClear,
  onCodeSearchControlAdded,
  onMarkerSearchControlAdded,
  onSearch,
}: AddSearchControlsOptions) {
  const codeSearchControl = createCodeSearchControl();
  map.addControl(codeSearchControl);
  onCodeSearchControlAdded?.(codeSearchControl);

  const markerSearchControl = createMarkerSearchControl({
    markerRecords,
    markers,
    clusterGroups,
    onSearch,
    onClear,
  });
  map.addControl(markerSearchControl);
  onMarkerSearchControlAdded?.(markerSearchControl);

  return { codeSearchControl, markerSearchControl };
}

export function addReadOnlyMapVisibilityControls({
  includeShapeOverlays,
  initialUserLocationVisible,
  initializeUserLocation,
  leaflet,
  map,
  onUserLocationVisibilityChange,
  onVisibilityControlAdded,
  shapeNameVisibilityLayer,
  shapeVisibilityLayer,
  userLocationOptions,
  visibleMarkerGroup,
}: AddMapVisibilityControlsOptions) {
  const userLocationLayer = initializeUserLocation(map, userLocationOptions);
  if (userLocationLayer && initialUserLocationVisible === false) {
    map.removeLayer(userLocationLayer);
  }

  const overlays: Record<string, MapLayer> = {
    マーカー: visibleMarkerGroup,
  };
  if (includeShapeOverlays) {
    overlays["図形"] = shapeVisibilityLayer;
    overlays["図形名"] = shapeNameVisibilityLayer;
  }
  if (userLocationLayer) {
    overlays["現在位置"] = userLocationLayer;
  }

  const visibilityControl = leaflet.control.layers(null, overlays, {
    collapsed: false,
    position: "topleft",
  });
  const addedVisibilityControl = visibilityControl.addTo(map);
  onVisibilityControlAdded?.(addedVisibilityControl);

  if (userLocationLayer && onUserLocationVisibilityChange) {
    map.on("overlayadd", (event) => {
      if (event.layer === userLocationLayer) {
        onUserLocationVisibilityChange(true);
      }
    });
    map.on("overlayremove", (event) => {
      if (event.layer === userLocationLayer) {
        onUserLocationVisibilityChange(false);
      }
    });
  }

  return { userLocationLayer, visibilityControl: addedVisibilityControl };
}
