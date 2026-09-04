import { describe, expect, it, vi } from "vitest";

import {
  addReadOnlyMapVisibilityControls,
  addReadOnlySearchControls,
} from "../src/map/common/page-controls";

function createMapMock() {
  const handlers = new Map<string, (event: { layer: object }) => void>();
  return {
    handlers,
    map: {
      addControl: vi.fn(),
      on: vi.fn((eventName: string, handler: (event: { layer: object }) => void) => {
        handlers.set(eventName, handler);
      }),
      removeLayer: vi.fn(),
    },
  };
}

describe("read-only page controls", () => {
  it("adds search controls and forwards their shared search callbacks", () => {
    const { map } = createMapMock();
    const codeSearchControl = { kind: "code" };
    const markerSearchControl = { kind: "marker" };
    const createMarkerSearchControl = vi.fn(() => markerSearchControl);
    const onCodeSearchControlAdded = vi.fn();
    const onMarkerSearchControlAdded = vi.fn();
    const onSearch = vi.fn();
    const onClear = vi.fn();
    const clusterGroups = {};
    const markerRecords = {};
    const markers = {};

    const result = addReadOnlySearchControls({
      clusterGroups,
      createCodeSearchControl: () => codeSearchControl,
      createMarkerSearchControl,
      map,
      markerRecords,
      markers,
      onClear,
      onCodeSearchControlAdded,
      onMarkerSearchControlAdded,
      onSearch,
    });

    expect(map.addControl.mock.calls).toEqual([
      [codeSearchControl],
      [markerSearchControl],
    ]);
    expect(createMarkerSearchControl).toHaveBeenCalledWith({
      clusterGroups,
      markerRecords,
      markers,
      onClear,
      onSearch,
    });
    expect(onCodeSearchControlAdded).toHaveBeenCalledWith(codeSearchControl);
    expect(onMarkerSearchControlAdded).toHaveBeenCalledWith(markerSearchControl);
    expect(result).toEqual({ codeSearchControl, markerSearchControl });
  });

  it("adds all visibility overlays and persists user-location changes", () => {
    const { handlers, map } = createMapMock();
    const visibleMarkerGroup = {};
    const shapeVisibilityLayer = {};
    const shapeNameVisibilityLayer = {};
    const userLocationLayer = {};
    const addedVisibilityControl = {};
    const visibilityControl = {
      addTo: vi.fn(() => addedVisibilityControl),
    };
    const layers = vi.fn(
      (
        _baseLayers: null,
        _overlays: Record<string, object>,
        _options: { collapsed: boolean; position: string },
      ) => visibilityControl,
    );
    const onUserLocationVisibilityChange = vi.fn();

    addReadOnlyMapVisibilityControls({
      includeShapeOverlays: true,
      initialUserLocationVisible: false,
      initializeUserLocation: vi.fn(() => userLocationLayer),
      leaflet: { control: { layers } },
      map,
      onUserLocationVisibilityChange,
      shapeNameVisibilityLayer,
      shapeVisibilityLayer,
      visibleMarkerGroup,
    });

    expect(map.removeLayer).toHaveBeenCalledWith(userLocationLayer);
    expect(layers).toHaveBeenCalledWith(
      null,
      {
        マーカー: visibleMarkerGroup,
        図形: shapeVisibilityLayer,
        図形名: shapeNameVisibilityLayer,
        現在位置: userLocationLayer,
      },
      { collapsed: false, position: "topleft" },
    );
    expect(visibilityControl.addTo).toHaveBeenCalledWith(map);

    handlers.get("overlayadd")?.({ layer: userLocationLayer });
    handlers.get("overlayremove")?.({ layer: userLocationLayer });
    expect(onUserLocationVisibilityChange.mock.calls).toEqual([
      [true],
      [false],
    ]);
    handlers.get("overlayadd")?.({ layer: {} });
    expect(onUserLocationVisibilityChange).toHaveBeenCalledTimes(2);
  });

  it("supports marker-only mobile visibility controls and registration", () => {
    const { map } = createMapMock();
    const visibleMarkerGroup = {};
    const shapeVisibilityLayer = {};
    const shapeNameVisibilityLayer = {};
    const visibilityControl = { addTo: vi.fn(() => visibilityControl) };
    const layers = vi.fn(
      (
        _baseLayers: null,
        _overlays: Record<string, object>,
        _options: { collapsed: boolean; position: string },
      ) => visibilityControl,
    );
    const initializeUserLocation = vi.fn(() => null);
    const onVisibilityControlAdded = vi.fn();
    const userLocationOptions = {
      centerOnInitialPosition: true,
      controlClassName: "temporary-user-location-control",
      position: "bottomleft",
    };

    addReadOnlyMapVisibilityControls({
      includeShapeOverlays: false,
      initializeUserLocation,
      leaflet: { control: { layers } },
      map,
      onVisibilityControlAdded,
      shapeNameVisibilityLayer,
      shapeVisibilityLayer,
      userLocationOptions,
      visibleMarkerGroup,
    });

    expect(initializeUserLocation).toHaveBeenCalledWith(map, userLocationOptions);
    expect(layers.mock.calls[0]?.[1]).toEqual({ マーカー: visibleMarkerGroup });
    expect(onVisibilityControlAdded).toHaveBeenCalledWith(visibilityControl);
  });
});
