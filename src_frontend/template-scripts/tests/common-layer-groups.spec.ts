import { describe, expect, it, vi } from "vitest";

import { createReadOnlyLayerGroupRuntime } from "../src/map/common/layer-groups";

function createGroup() {
  const layers: object[] = [];
  const group = {
    addLayer: vi.fn((layer: object) => {
      layers.push(layer);
      return group;
    }),
    addTo: vi.fn(() => group),
    eachLayer: vi.fn((callback: (layer: object) => void) =>
      layers.forEach(callback),
    ),
    removeLayer: vi.fn(),
  };
  return group;
}

describe("read-only layer group runtime", () => {
  it("creates and reuses marker visibility and shape groups", () => {
    const clusterGroups: Record<string, ReturnType<typeof createGroup>> = {};
    const layerVisibilityGroups: Record<
      string,
      ReturnType<typeof createGroup>
    > = {};
    const shapeGroups: Record<string, ReturnType<typeof createGroup>> = {};
    const featureGroup = vi.fn(createGroup);
    const layerGroup = vi.fn(createGroup);
    const runtime = createReadOnlyLayerGroupRuntime({
      clusterGroups,
      getLayeredMarkerDisplay: () => ({
        findLayerIdByVisibilityGroup: () => null,
        isLayerVisible: () => false,
      }),
      getMeasurementVisible: () => false,
      getShapeMeasurementManager: () => null,
      layerVisibilityGroups,
      leaflet: { featureGroup, layerGroup },
      map: { hasLayer: () => false, removeLayer: vi.fn() },
      setMeasurementMarkerVisibility: vi.fn(),
      shapeGroups,
      shapeVisibilityLayer: {},
    });

    expect(runtime.createMarkerGroupForLayer(null)).toBeNull();
    const markerGroup = runtime.createMarkerGroupForLayer("layer-1");
    expect(runtime.createMarkerGroupForLayer("layer-1")).toBe(markerGroup);
    expect(featureGroup).toHaveBeenCalledOnce();
    expect(layerGroup).toHaveBeenCalledOnce();

    const shapeGroup = runtime.ensureShapeGroup("layer-1");
    expect(runtime.ensureShapeGroup("layer-1")).toBe(shapeGroup);
    expect(featureGroup).toHaveBeenCalledTimes(2);
  });

  it("registers managed shapes and synchronizes visible measurement layers", () => {
    const shapeVisibilityLayer = {};
    const measurementMarker = { isMeasurementLabel: true };
    const regularLayer = { openTooltip: vi.fn() };
    const shapeGroup = createGroup();
    shapeGroup.addLayer(measurementMarker);
    shapeGroup.addLayer(regularLayer);
    const drawnShapesGroup = createGroup();
    const mapLayers = new Set<object>([shapeVisibilityLayer]);
    const removeLayer = vi.fn((layer: object) => mapLayers.delete(layer));
    const setMeasurementMarkerVisibility = vi.fn();
    const scheduleRefresh = vi.fn();
    const findLayerIdByVisibilityGroup = vi.fn(() => "layer-1");
    const runtime = createReadOnlyLayerGroupRuntime({
      clusterGroups: {},
      drawnShapesGroup,
      getLayeredMarkerDisplay: () => ({
        findLayerIdByVisibilityGroup,
        isLayerVisible: () => true,
      }),
      getMeasurementVisible: () => true,
      getShapeMeasurementManager: () => ({ scheduleRefresh }),
      layerVisibilityGroups: {},
      leaflet: { featureGroup: createGroup, layerGroup: createGroup },
      map: { hasLayer: (layer) => mapLayers.has(layer), removeLayer },
      setMeasurementMarkerVisibility,
      shapeGroups: { "layer-1": shapeGroup },
      shapeVisibilityLayer,
    });

    const addedShape = {};
    runtime.addShapeLayerToManagedGroups(addedShape, "layer-1");
    expect(drawnShapesGroup.addLayer).toHaveBeenCalledWith(addedShape);
    expect(shapeGroup.addLayer).toHaveBeenCalledWith(addedShape);
    expect(runtime.findLayerIdByMarkerGroup({})).toBe("layer-1");

    runtime.syncAllShapeGroupsVisibility();
    expect(shapeGroup.addTo).toHaveBeenCalledOnce();
    expect(setMeasurementMarkerVisibility).toHaveBeenCalledWith(
      measurementMarker,
      true,
    );
    expect(regularLayer.openTooltip).toHaveBeenCalledOnce();
    expect(scheduleRefresh).toHaveBeenCalledOnce();

    mapLayers.delete(shapeVisibilityLayer);
    mapLayers.add(shapeGroup);
    runtime.syncShapeGroupVisibility("layer-1");
    expect(removeLayer).toHaveBeenCalledWith(shapeGroup);
  });
});
