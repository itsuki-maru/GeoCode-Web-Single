interface ManagedLayer {
  isMeasurementLabel?: boolean;
  openTooltip?(): void;
}

interface LayerGroup extends ManagedLayer {
  addLayer(layer: ManagedLayer): unknown;
  addTo(map: LayerGroupMap): unknown;
  eachLayer(callback: (layer: ManagedLayer) => void): void;
}

interface MutableLayerGroup extends LayerGroup {
  removeLayer(layer: ManagedLayer): unknown;
}

interface LayerGroupMap {
  hasLayer(layer: ManagedLayer): boolean;
  removeLayer(layer: ManagedLayer): unknown;
}

interface LayeredMarkerDisplay {
  findLayerIdByVisibilityGroup(group: ManagedLayer): string | null;
  isLayerVisible(layerId: string): boolean;
}

interface ShapeMeasurementManager {
  scheduleRefresh(): void;
}

interface LeafletNamespace {
  featureGroup(): MutableLayerGroup;
  layerGroup(): LayerGroup;
}

interface LayerGroupRuntimeOptions {
  clusterGroups: Record<string, MutableLayerGroup>;
  drawnShapesGroup?: MutableLayerGroup;
  getLayeredMarkerDisplay: () => LayeredMarkerDisplay;
  getMeasurementVisible: () => boolean;
  getShapeMeasurementManager: () => ShapeMeasurementManager | null;
  layerVisibilityGroups: Record<string, LayerGroup>;
  leaflet: LeafletNamespace;
  map: LayerGroupMap;
  setMeasurementMarkerVisibility: (
    marker: ManagedLayer,
    visible: boolean,
  ) => void;
  shapeGroups: Record<string, MutableLayerGroup>;
  shapeVisibilityLayer: ManagedLayer;
}

export function createReadOnlyLayerGroupRuntime({
  clusterGroups,
  drawnShapesGroup,
  getLayeredMarkerDisplay,
  getMeasurementVisible,
  getShapeMeasurementManager,
  layerVisibilityGroups,
  leaflet,
  map,
  setMeasurementMarkerVisibility,
  shapeGroups,
  shapeVisibilityLayer,
}: LayerGroupRuntimeOptions) {
  const createMarkerGroupForLayer = (
    layerId: string | null | undefined,
  ): MutableLayerGroup | null => {
    if (!layerId) return null;

    clusterGroups[layerId] ??= leaflet.featureGroup();
    layerVisibilityGroups[layerId] ??= leaflet.layerGroup();
    return clusterGroups[layerId];
  };

  const ensureShapeGroup = (
    layerId: string | null | undefined,
  ): MutableLayerGroup | null => {
    if (!layerId) return null;

    shapeGroups[layerId] ??= leaflet.featureGroup();
    return shapeGroups[layerId];
  };

  const addShapeLayerToManagedGroups = (
    layer: ManagedLayer | null | undefined,
    layerId: string | null | undefined,
  ): void => {
    if (!layer) return;

    drawnShapesGroup?.addLayer(layer);
    ensureShapeGroup(layerId)?.addLayer(layer);
  };

  const findLayerIdByMarkerGroup = (group: ManagedLayer): string | null =>
    getLayeredMarkerDisplay().findLayerIdByVisibilityGroup(group);

  const syncShapeGroupVisibility = (
    layerId: string | null | undefined,
  ): void => {
    if (!layerId) return;
    const shapeGroup = shapeGroups[layerId];
    if (!shapeGroup) return;

    if (
      map.hasLayer(shapeVisibilityLayer) &&
      getLayeredMarkerDisplay().isLayerVisible(layerId)
    ) {
      if (!map.hasLayer(shapeGroup)) shapeGroup.addTo(map);
      shapeGroup.eachLayer((layer) => {
        if (layer.isMeasurementLabel === true) {
          setMeasurementMarkerVisibility(layer, getMeasurementVisible());
        }
        layer.openTooltip?.();
      });
      return;
    }

    if (map.hasLayer(shapeGroup)) map.removeLayer(shapeGroup);
  };

  const syncAllShapeGroupsVisibility = (): void => {
    Object.keys(shapeGroups).forEach(syncShapeGroupVisibility);
    getShapeMeasurementManager()?.scheduleRefresh();
  };

  return {
    addShapeLayerToManagedGroups,
    createMarkerGroupForLayer,
    ensureShapeGroup,
    findLayerIdByMarkerGroup,
    syncAllShapeGroupsVisibility,
    syncShapeGroupVisibility,
  };
}
