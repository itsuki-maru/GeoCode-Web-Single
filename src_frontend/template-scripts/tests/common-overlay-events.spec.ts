import { describe, expect, it, vi } from "vitest";

import { installReadOnlyOverlayHandlers } from "../src/map/common/overlay-events";

describe("read-only overlay events", () => {
  it("handles visibility layers and persists optional visibility settings", () => {
    const handlers = new Map<string, (event: { layer: object }) => void>();
    const visibleMarkerGroup = {};
    const shapeNameVisibilityLayer = {};
    const shapeVisibilityLayer = {};
    const shapeNameLabelManager = { setEnabled: vi.fn() };
    const onMarkerVisibilityChange = vi.fn();
    const onShapeNameVisibilityChange = vi.fn();
    const onShapeVisibilityChange = vi.fn();
    const syncAllShapeGroupsVisibility = vi.fn();

    installReadOnlyOverlayHandlers({
      clearMapObjectSearch: vi.fn(),
      findLayerIdByMarkerGroup: vi.fn(),
      map: {
        on: (eventName, handler) => handlers.set(eventName, handler),
      },
      markerDisplay: { rebuildVisibleMarkers: vi.fn() },
      onMarkerVisibilityChange,
      onShapeNameVisibilityChange,
      onShapeVisibilityChange,
      shapeDisplay: { rebuildVisibleShapes: vi.fn() },
      shapeNameLabelManager,
      shapeNameVisibilityLayer,
      shapeVisibilityLayer,
      syncAllShapeGroupsVisibility,
      syncShapeGroupVisibility: vi.fn(),
      visibleMarkerGroup,
    });

    handlers.get("overlayadd")?.({ layer: visibleMarkerGroup });
    handlers.get("overlayremove")?.({ layer: visibleMarkerGroup });
    expect(onMarkerVisibilityChange.mock.calls).toEqual([[true], [false]]);

    handlers.get("overlayadd")?.({ layer: shapeNameVisibilityLayer });
    handlers.get("overlayremove")?.({ layer: shapeNameVisibilityLayer });
    expect(shapeNameLabelManager.setEnabled.mock.calls).toEqual([
      [true],
      [false],
    ]);
    expect(onShapeNameVisibilityChange.mock.calls).toEqual([
      [true],
      [false],
    ]);

    handlers.get("overlayadd")?.({ layer: shapeVisibilityLayer });
    handlers.get("overlayremove")?.({ layer: shapeVisibilityLayer });
    expect(onShapeVisibilityChange.mock.calls).toEqual([[true], [false]]);
    expect(syncAllShapeGroupsVisibility).toHaveBeenCalledTimes(2);
  });

  it("clears search on layer add and rebuilds displays on layer removal", () => {
    const handlers = new Map<string, (event: { layer: object }) => void>();
    const markerLayer = {};
    const clearMapObjectSearch = vi.fn();
    const rebuildVisibleMarkers = vi.fn();
    const rebuildVisibleShapes = vi.fn();
    const syncShapeGroupVisibility = vi.fn();
    let scheduledCallback: (() => void) | undefined;

    installReadOnlyOverlayHandlers({
      clearMapObjectSearch,
      findLayerIdByMarkerGroup: (layer) =>
        layer === markerLayer ? "layer-1" : null,
      map: {
        on: (eventName, handler) => handlers.set(eventName, handler),
      },
      markerDisplay: { rebuildVisibleMarkers },
      schedule: (callback) => {
        scheduledCallback = callback;
      },
      shapeDisplay: { rebuildVisibleShapes },
      shapeNameLabelManager: { setEnabled: vi.fn() },
      shapeNameVisibilityLayer: {},
      shapeVisibilityLayer: {},
      syncAllShapeGroupsVisibility: vi.fn(),
      syncShapeGroupVisibility,
    });

    handlers.get("overlayadd")?.({ layer: markerLayer });
    expect(clearMapObjectSearch).toHaveBeenCalledOnce();
    expect(syncShapeGroupVisibility).not.toHaveBeenCalled();
    scheduledCallback?.();
    expect(syncShapeGroupVisibility).toHaveBeenCalledWith("layer-1");

    handlers.get("overlayremove")?.({ layer: markerLayer });
    expect(rebuildVisibleMarkers).toHaveBeenCalledOnce();
    expect(rebuildVisibleShapes).toHaveBeenCalledOnce();
    expect(syncShapeGroupVisibility).toHaveBeenCalledTimes(2);

    handlers.get("overlayadd")?.({ layer: {} });
    expect(clearMapObjectSearch).toHaveBeenCalledOnce();
  });
});
