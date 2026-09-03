import { describe, expect, it, vi } from "vitest";

import { createMapObjectFocusController } from "../src/map/common/map-object-focus";

describe("map object focus controller", () => {
  it("reveals a clustered marker before opening its popup", () => {
    const marker = {};
    const openMarkerPopup = vi.fn();
    const addLayer = vi.fn();
    const runtime = createRuntime({
      markers: { "marker-3": marker },
      markersClusterGroup: {
        addLayer,
        hasLayer: () => false,
        zoomToShowLayer: (_layer: object, callback: () => void) => callback(),
      },
      openMarkerPopup,
    });

    runtime.controller.focusMapObject("marker", 3, 35, 139);

    expect(addLayer).toHaveBeenCalledWith(marker);
    expect(openMarkerPopup).toHaveBeenCalledWith(3);
    expect(runtime.setView).toHaveBeenCalledWith({ latitude: 35, longitude: 139 }, 16);
  });

  it("temporarily adds a hidden shape and removes it when focus clears", () => {
    const shape = {
      addTo: vi.fn(),
      shapeId: "9",
      shapeName: "Route",
    };
    const removeLayer = vi.fn();
    const setFocusedLayer = vi.fn();
    const hasLayer = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const runtime = createRuntime({
      searchableShapeLayers: [shape],
      shapeNameLabelManager: { setFocusedLayer },
      removeLayer,
      hasLayer,
    });
    shape.addTo.mockImplementation(() => undefined);

    runtime.controller.focusMapObject("shape", 9, 35, 139);
    runtime.controller.clearFocusedShapeFocus();

    expect(shape.addTo).toHaveBeenCalled();
    expect(setFocusedLayer).toHaveBeenCalledWith(shape);
    expect(removeLayer).toHaveBeenCalledWith(shape);
  });
});

function createRuntime(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, (event: { layer?: object }) => void>();
  const setView = vi.fn();
  const removeLayer = vi.fn();
  const hasLayer = vi.fn(() => false);
  const map = {
    closePopup: vi.fn(),
    hasLayer,
    on: (eventName: string, listener: (event: { layer?: object }) => void) => {
      listeners.set(eventName, listener);
    },
    removeLayer,
    setView,
  };
  const dependencies = {
    createLatLng: (latitude: unknown, longitude: unknown) => ({ latitude, longitude }),
    drawnShapesGroup: { addLayer: vi.fn(), hasLayer: () => false },
    isValidCoordinate: () => true,
    map,
    markers: {},
    markersClusterGroup: { addLayer: vi.fn(), hasLayer: () => true },
    normalizeShapeName: (name: unknown) => String(name ?? "").trim(),
    openMarkerPopup: vi.fn(),
    openShapeMemoPopup: vi.fn(() => true),
    searchableShapeLayers: [],
    shapeNameLabelManager: null,
    ...overrides,
  };
  if (overrides.hasLayer) map.hasLayer = overrides.hasLayer as typeof hasLayer;
  if (overrides.removeLayer) map.removeLayer = overrides.removeLayer as typeof removeLayer;
  dependencies.map = map;
  return {
    controller: createMapObjectFocusController(dependencies),
    hasLayer: map.hasLayer as ReturnType<typeof vi.fn>,
    listeners,
    setView,
  };
}
