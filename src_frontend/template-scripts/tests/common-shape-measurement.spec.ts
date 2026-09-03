import { describe, expect, it, vi } from "vitest";

import { createShapeMeasurementRuntime } from "../src/map/common/shape-measurement";

describe("map common shape measurement", () => {
  it("formats distances and areas at the existing display thresholds", () => {
    const { runtime } = createRuntime();

    expect(runtime.formatDistance(Number.NaN)).toBe("-");
    expect(runtime.formatDistance(12.34)).toBe("12.3 m");
    expect(runtime.formatDistance(123.4)).toBe("123 m");
    expect(runtime.formatDistance(1234)).toBe("1.23 km");
    expect(runtime.formatArea(1234.4)).toBe("1234 m²");
    expect(runtime.formatArea(1_234_567)).toBe("1.23 km²");
  });

  it("measures a polyline and finds its distance midpoint", () => {
    const { runtime } = createRuntime();
    const points = [
      { lat: 0, lng: 0 },
      { lat: 3, lng: 4 },
      { lat: 3, lng: 14 },
    ];
    const layer = { getLatLngs: () => points };

    expect(runtime.measurePolyline(layer)).toEqual({
      segments: [
        { distance: 5, label: "1" },
        { distance: 10, label: "2" },
      ],
      totalDistance: 15,
    });
    expect(runtime.getPolylineCenterLatLng(layer)).toEqual({
      lat: 3,
      lng: 6.5,
    });
  });

  it("trims closed rings and calculates projected polygon area", () => {
    const { runtime } = createRuntime();
    const ring = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 4 },
      { lat: 3, lng: 4 },
      { lat: 0, lng: 0 },
    ];

    expect(runtime.trimClosedLatLngs(ring)).toHaveLength(3);
    expect(runtime.calculateProjectedPolygonArea(ring)).toBe(6);
  });

  it("reads circle dimensions and rejects invalid GeoJSON radii", () => {
    const { runtime } = createRuntime();

    expect(
      runtime.getCircleRadiusFromGeoJson({ properties: { radius: "20" } }),
    ).toBe(20);
    expect(
      runtime.getCircleRadiusFromGeoJson({ properties: { radius: 0 } }),
    ).toBeNull();
    expect(runtime.measureCircle({ getRadius: () => 10 })).toEqual({
      radius: 10,
      area: Math.PI * 100,
    });
  });

  it("creates escaped summary labels and measurement markers", () => {
    const { runtime, leaflet } = createRuntime();
    const latLng = { lat: 1, lng: 2 };

    expect(
      runtime.buildMeasurementLabelHtml(
        ["<総延長>", "10 m"],
        "summary-polyline",
      ),
    ).toContain("&lt;総延長&gt;");
    const marker = runtime.createMeasurementLabelMarker(
      latLng,
      ["10 m"],
      "summary",
    );
    expect(marker?.isMeasurementLabel).toBe(true);
    expect(leaflet.marker).toHaveBeenCalledWith(
      latLng,
      expect.objectContaining({ interactive: false, zIndexOffset: 900 }),
    );
  });

  it("groups segment labels and de-duplicates group endpoints", () => {
    const { runtime, leaflet } = createRuntime();
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 0, lng: 4 },
      { lat: 0, lng: 6 },
      { lat: 0, lng: 8 },
    ];
    const segments = points.slice(1).map((end, index) => ({
      distance: 2,
      end,
      start: points[index],
    }));

    expect(runtime.createGroupedSegmentMeasurementMarkers(segments)).toHaveLength(2);
    expect(
      runtime.createGroupedSegmentEndpointMarkers(segments, {
        shapeStyle: { color: "#ff0000" },
      }),
    ).toHaveLength(3);
    expect(leaflet.circleMarker).toHaveBeenCalledTimes(3);
  });

  it("updates marker opacity, vector style, and DOM visibility", () => {
    const { runtime } = createRuntime();
    const element = document.createElement("div");
    const marker = {
      getElement: () => element,
      isMeasurementLabel: true,
      isMeasurementVertex: true,
      setOpacity: vi.fn(),
      setStyle: vi.fn(),
    };

    runtime.setMeasurementMarkerVisibility(marker, false);
    expect(marker.setOpacity).toHaveBeenCalledWith(0);
    expect(marker.setStyle).toHaveBeenCalledWith({
      fillOpacity: 0,
      opacity: 0,
    });
    expect(element.style.display).toBe("none");
  });
});

function createRuntime() {
  const marker = vi.fn(() => ({}));
  const circleMarker = vi.fn(() => ({}));
  const leaflet = {
    circleMarker,
    divIcon: vi.fn((options) => options),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    marker,
  };
  const runtime = createShapeMeasurementRuntime({
    escapeHtml: (value) =>
      value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    flattenShapeLatLngs: (value) =>
      Array.isArray(value) ? value.flat(Infinity) : [],
    getDefaultShapeColor: () => "#3388ff",
    getLeaflet: () => leaflet,
    getMap: () => ({
      distance: (start, end) =>
        Math.hypot(end.lat - start.lat, end.lng - start.lng),
      options: {
        crs: {
          project: ({ lat, lng }) => ({ x: lng, y: lat }),
        },
      },
    }),
    getSegmentLabelGroupSize: () => 2,
    normalizeShapeColor: (value, fallback = "#3388ff") =>
      typeof value === "string" ? value : fallback,
  });
  return { leaflet, runtime };
}
