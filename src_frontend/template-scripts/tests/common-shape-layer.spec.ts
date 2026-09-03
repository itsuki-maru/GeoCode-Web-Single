import { describe, expect, it, vi } from "vitest";

import { createShapeLayerRuntime } from "../src/map/common/shape-layer";

describe("map common shape layer", () => {
  it("creates a circle from GeoJSON coordinates and radius", () => {
    const { runtime, leaflet } = createRuntime();
    const style = { color: "#3388ff", weight: 3 };

    const circle = runtime.createLeafletShapeLayer(
      "circle",
      {
        geometry: { coordinates: [139, 35], type: "Point" },
        properties: { radius: 20 },
      },
      style,
    );
    expect(circle).toBe(leaflet.circleLayer);
    expect(leaflet.latLng).toHaveBeenCalledWith(35, 139);
    expect(leaflet.circle).toHaveBeenCalledWith(
      { lat: 35, lng: 139 },
      { ...style, radius: 20 },
    );
  });

  it("returns null for an invalid circle", () => {
    const { runtime, leaflet } = createRuntime();

    expect(
      runtime.createLeafletShapeLayer(
        "circle",
        { geometry: { coordinates: [139, 35] }, properties: { radius: 0 } },
        {},
      ),
    ).toBeNull();
    expect(leaflet.circle).not.toHaveBeenCalled();
  });

  it("creates a GeoJSON layer and binds its arrow style", () => {
    const { runtime, dependencies, leaflet } = createRuntime();
    const style = { color: "#ff0000" };

    const layer = runtime.createLeafletShapeLayer(
      "polyline",
      { geometry: { coordinates: [] } },
      style,
    );
    expect(layer).toBe(leaflet.geoJsonLayer);
    expect(leaflet.geoJsonLayer.shapeType).toBe("polyline");
    expect(leaflet.geoJsonLayer.shapeStyle).toBe(style);
    expect(dependencies.bindShapeArrowStyle).toHaveBeenCalledWith(
      leaflet.geoJsonLayer,
    );
  });

  it("opens marker tooltips while ignoring shape-name layers", () => {
    const markerLayer = {
      getTooltip: () => ({}),
      openTooltip: vi.fn(),
    };
    const shapeNameLayer = {
      getTooltip: () => ({}),
      isShapeNameLayer: true,
      openTooltip: vi.fn(),
    };
    const { runtime, dependencies } = createRuntime({
      layers: [markerLayer, shapeNameLayer],
    });

    runtime.toggleTooltips();
    expect(markerLayer.openTooltip).toHaveBeenCalledOnce();
    expect(shapeNameLayer.openTooltip).not.toHaveBeenCalled();
    expect(dependencies.setTooltipVisible).toHaveBeenCalledWith(true);
  });

  it("closes marker tooltips while ignoring shape-name layers", () => {
    const markerTooltip = {};
    const markerLayer = { getTooltip: () => markerTooltip };
    const shapeNameLayer = {
      getTooltip: () => ({}),
      isShapeNameLayer: true,
    };
    const { runtime, dependencies } = createRuntime({
      layers: [markerLayer, shapeNameLayer],
      tooltipVisible: true,
    });

    runtime.toggleTooltips();
    expect(dependencies.closeTooltip).toHaveBeenCalledExactlyOnceWith(
      markerTooltip,
    );
    expect(dependencies.setTooltipVisible).toHaveBeenCalledWith(false);
  });
});

function createRuntime({
  layers = [],
  tooltipVisible = false,
}: {
  layers?: object[];
  tooltipVisible?: boolean;
} = {}) {
  const circleLayer = {};
  const geoJsonLayer: {
    shapeStyle?: Record<string, unknown>;
    shapeType?: string;
  } = {};
  const leaflet = {
    circle: vi.fn(() => circleLayer),
    circleLayer,
    geoJSON: vi.fn(() => ({ getLayers: () => [geoJsonLayer] })),
    geoJsonLayer,
    latLng: vi.fn((lat, lng) => ({ lat, lng })),
  };
  const closeTooltip = vi.fn();
  const setTooltipVisible = vi.fn();
  const bindShapeArrowStyle = vi.fn();
  const dependencies = {
    bindShapeArrowStyle,
    closeTooltip,
    setTooltipVisible,
  };
  const runtime = createShapeLayerRuntime({
    bindShapeArrowStyle,
    getCircleRadiusFromGeoJson: (geojson) => {
      const radius = Number(
        (geojson as { properties?: { radius?: unknown } })?.properties?.radius,
      );
      return Number.isFinite(radius) && radius > 0 ? radius : null;
    },
    getLeaflet: () => leaflet,
    getMap: () => ({
      closeTooltip,
      eachLayer: (callback) => layers.forEach(callback),
    }),
    getTooltipVisible: () => tooltipVisible,
    setTooltipVisible,
  });

  return { dependencies, leaflet, runtime };
}
