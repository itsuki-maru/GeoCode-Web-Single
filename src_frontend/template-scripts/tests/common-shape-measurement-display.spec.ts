import { describe, expect, it, vi } from "vitest";

import { createReadOnlyShapeMeasurementDisplayRuntime } from "../src/map/common/shape-measurement-display";
import { filterMeasurementMarkersForBounds } from "../src/map/common/search";

type Dependencies = Parameters<
  typeof createReadOnlyShapeMeasurementDisplayRuntime
>[0];

function createDependencies(overrides: Partial<Dependencies> = {}) {
  const group = {
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
  };
  const dependencies: Dependencies = {
    calculateProjectedPolygonArea: vi.fn(() => 50),
    createGroupedSegmentEndpointMarkers: vi.fn(() => []),
    createGroupedSegmentMeasurementMarkers: vi.fn(() => []),
    createMeasurementLabelMarker: vi.fn((latLng, lines, variant) =>
      latLng
        ? { getLatLng: () => latLng, kind: "label", lines, variant }
        : null,
    ),
    createMeasurementVertexMarker: vi.fn((latLng) =>
      latLng ? { getLatLng: () => latLng, kind: "vertex" } : null,
    ),
    ensureShapeGroup: vi.fn(() => group),
    filterMeasurementMarkersForBounds,
    formatArea: (area) => `${area} m²`,
    formatDistance: (distance) => `${distance} m`,
    getMeasurementSegmentMerged: () => false,
    getMeasurementVertexLatLngs: vi.fn(() => []),
    getMeasurementVisible: () => true,
    getPolylineCenterLatLng: vi.fn(() => ({ lat: 1, lng: 2 })),
    getSegmentMidpoint: (start, end) => ({
      lat: (start.lat + end.lat) / 2,
      lng: (start.lng + end.lng) / 2,
    }),
    getShapeMeasurementManager: () => null,
    map: {
      distance: (start, end) =>
        Math.abs(end.lat - start.lat) + Math.abs(end.lng - start.lng),
    },
    measureCircle: vi.fn(() => ({ area: 12, radius: 2 })),
    measurePolyline: vi.fn(() => ({
      segments: [{ distance: 3 }, { distance: 4 }],
      totalDistance: 7,
    })),
    setMeasurementMarkerVisibility: vi.fn(),
    trimClosedLatLngs: (latLngs) => {
      if (!Array.isArray(latLngs)) return [];
      const result = [...latLngs] as { lat: number; lng: number }[];
      const first = result[0];
      const last = result[result.length - 1];
      if (first && last && first.lat === last.lat && first.lng === last.lng) {
        result.pop();
      }
      return result;
    },
    ...overrides,
  };
  return { dependencies, group };
}

describe("read-only shape measurement display runtime", () => {
  it("flattens shape coordinates and selects each shape label position", () => {
    const { dependencies } = createDependencies();
    const runtime = createReadOnlyShapeMeasurementDisplayRuntime(dependencies);
    const points = [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ];

    expect(runtime.flattenShapeLatLngs([[points]])).toEqual(points);
    expect(
      runtime.getShapeLabelLatLng({ getLatLngs: () => points, shapeType: "polyline" }),
    ).toEqual({ lat: 1, lng: 2 });
    expect(
      runtime.getShapeLabelLatLng({
        getLatLng: () => ({ lat: 3, lng: 4 }),
        shapeType: "circle",
      }),
    ).toEqual({ lat: 3, lng: 4 });
    expect(
      runtime.getShapeLabelLatLng({
        getBounds: () => ({ getCenter: () => ({ lat: 5, lng: 6 }) }),
        shapeType: "polygon",
      }),
    ).toEqual({ lat: 5, lng: 6 });
  });

  it("creates segment, summary, and vertex markers for a polyline", () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 3 },
      { lat: 4, lng: 3 },
    ];
    const { dependencies, group } = createDependencies({
      getMeasurementVertexLatLngs: () => points,
    });
    const runtime = createReadOnlyShapeMeasurementDisplayRuntime(dependencies);
    const layer = { getLatLngs: () => points, shapeType: "polyline" };

    runtime.attachShapeMeasurementMarkers(layer, "layer-1");

    expect((layer as { measurementMarkers?: object[] }).measurementMarkers).toHaveLength(6);
    expect(dependencies.createMeasurementLabelMarker).toHaveBeenCalledWith(
      { lat: 1, lng: 2 },
      ["総延長 7 m"],
      "summary-polyline",
    );
    expect(group.addLayer).toHaveBeenCalledTimes(6);
    expect(dependencies.setMeasurementMarkerVisibility).toHaveBeenCalledTimes(6);
  });

  it("uses grouped edge markers and an area summary for a rectangle", () => {
    const groupedMarker = { isMeasurementLabel: true, kind: "grouped" };
    const endpointMarker = { isMeasurementLabel: true, kind: "endpoint" };
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 0 },
      { lat: 0, lng: 0 },
    ];
    const { dependencies } = createDependencies({
      createGroupedSegmentEndpointMarkers: vi.fn(() => [endpointMarker]),
      createGroupedSegmentMeasurementMarkers: vi.fn(() => [groupedMarker]),
      getMeasurementSegmentMerged: () => true,
    });
    const runtime = createReadOnlyShapeMeasurementDisplayRuntime(dependencies);
    const layer = {
      getBounds: () => ({ getCenter: () => ({ lat: 0.5, lng: 1 }) }),
      getLatLngs: () => [points],
      shapeType: "rectangle",
    };

    runtime.attachShapeMeasurementMarkers(layer, "layer-1");

    expect(dependencies.createGroupedSegmentMeasurementMarkers).toHaveBeenCalledOnce();
    expect(dependencies.createGroupedSegmentEndpointMarkers).toHaveBeenCalledOnce();
    expect(dependencies.createMeasurementLabelMarker).toHaveBeenCalledWith(
      { lat: 0.5, lng: 1 },
      ["面積 50 m²"],
      "summary-rectangle",
    );
  });

  it("creates a radius and area summary for a circle", () => {
    const { dependencies } = createDependencies();
    const runtime = createReadOnlyShapeMeasurementDisplayRuntime(dependencies);
    const layer = {
      getLatLng: () => ({ lat: 3, lng: 4 }),
      shapeType: "circle",
    };

    runtime.attachShapeMeasurementMarkers(layer, "layer-1");

    expect(dependencies.createMeasurementLabelMarker).toHaveBeenCalledWith(
      { lat: 3, lng: 4 },
      ["半径 2 m", "面積 12 m²"],
      "summary-circle",
    );
  });

  it("filters, removes, and schedules replacement of measurement markers", () => {
    const scheduleRefresh = vi.fn();
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 3 },
      { lat: 4, lng: 3 },
    ];
    const { dependencies, group } = createDependencies({
      getShapeMeasurementManager: () => ({ scheduleRefresh }),
    });
    const runtime = createReadOnlyShapeMeasurementDisplayRuntime(dependencies);
    const layer = { getLatLngs: () => points, shapeType: "polyline" };

    runtime.attachShapeMeasurementMarkers(layer, "layer-1", {
      contains: (latLng) => (latLng as { lng: number }).lng <= 2,
    });
    expect((layer as { measurementMarkers?: object[] }).measurementMarkers).toHaveLength(2);

    runtime.removeShapeMeasurementMarkers(layer);
    expect(group.removeLayer).toHaveBeenCalledTimes(2);
    expect((layer as { measurementMarkers?: object[] }).measurementMarkers).toEqual([]);

    runtime.refreshAllShapeMeasurementMarkers();
    expect(scheduleRefresh).toHaveBeenCalledOnce();
  });
});
