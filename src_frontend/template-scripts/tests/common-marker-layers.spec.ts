import { describe, expect, it, vi } from "vitest";

import {
  createReadOnlyMarkerLayerControl,
  hydrateReadOnlyMarkers,
} from "../src/map/common/marker-layers";

function createMarker(element: HTMLElement | null = document.createElement("div")) {
  const popupHandlers: Array<() => void> = [];
  const marker = {
    bindPopup: vi.fn(() => marker),
    bindTooltip: vi.fn(() => marker),
    getElement: vi.fn(() => element),
    on: vi.fn((eventName: string, handler: () => void) => {
      if (eventName === "popupopen") popupHandlers.push(handler);
      return marker;
    }),
    popupHandlers,
  };
  return marker;
}

describe("read-only marker layers", () => {
  it("hydrates marker content, groups, layer names, and initial visibility", () => {
    const marker = createMarker();
    const markerGroup = { addLayer: vi.fn(), addTo: vi.fn() };
    const visibilityGroup = { addLayer: vi.fn(), addTo: vi.fn() };
    const createMarkerGroupForLayer = vi.fn(() => markerGroup);
    const enableMarkerIconFallback = vi.fn();
    const setupDetailsLazyImages = vi.fn();
    const layerNames: Record<string, string> = {};
    const markers: Record<string, ReturnType<typeof createMarker>> = {};
    const layerRecords = {
      "layer-1": { id: "layer-1", layer_name: "Stations" },
    };
    const map = {};

    hydrateReadOnlyMarkers({
      clusterGroups: { "layer-1": markerGroup },
      createMarkerGroupForLayer,
      enableMarkerIconFallback,
      escapeHtml: (value) => `escaped:${String(value)}`,
      initialLayersVisible: true,
      layerNames,
      layerRecords,
      layerVisibilityGroups: { "layer-1": visibilityGroup },
      leaflet: {
        control: { layers: vi.fn() },
        marker: vi.fn(() => marker),
      },
      map,
      markerOptionsForLayer: () => ({ title: "marker" }),
      markerRecords: {
        first: {
          detail: "Details",
          id: "marker-1",
          latitude: 35,
          layer_id: "layer-1",
          longitude: 139,
          marker_name: "Tokyo",
        },
      },
      markers,
      parseMarkdown: (markdown) => `parsed:${markdown}`,
      renderIframe: (html) => `iframe:${html}`,
      sanitizeHtml: (html) => `safe:${html}`,
      setupDetailsLazyImages,
      shapeRecords: [{ layer_id: "layer-2" }],
    });

    expect(layerNames).toEqual({ "layer-1": "Stations" });
    expect(createMarkerGroupForLayer.mock.calls).toEqual([
      ["layer-1"],
      ["layer-2"],
    ]);
    expect(markerGroup.addLayer).toHaveBeenCalledWith(marker);
    expect(enableMarkerIconFallback).toHaveBeenCalledWith(
      marker,
      "layer-1",
      layerRecords,
    );
    expect(marker.bindTooltip).toHaveBeenCalledWith(
      '<div class="custom-tooltip">escaped:Tokyo</div>',
      { permanent: false },
    );
    expect(marker.bindPopup).toHaveBeenLastCalledWith(
      '<div class="md-detail-contents">iframe:safe:parsed:# Tokyo\n\nDetails</div>',
    );
    expect(marker.getElement()?.id).toBe("marker-marker-1");
    expect(markers["marker-marker-1"]).toBe(marker);
    expect(visibilityGroup.addTo).toHaveBeenCalledWith(map);

    marker.popupHandlers[0]?.();
    expect(setupDetailsLazyImages).toHaveBeenCalledWith(document);
  });

  it("creates the layer selector and skips unnamed layers when requested", () => {
    const group1 = { addLayer: vi.fn(), addTo: vi.fn() };
    const group2 = { addLayer: vi.fn(), addTo: vi.fn() };
    const layersControl = { addOverlay: vi.fn(), addTo: vi.fn() };
    const layeredMarkerDisplay = {
      findLayerIdByVisibilityGroup: vi.fn(() => null),
      isLayerVisible: vi.fn(() => false),
      rebuildVisibleMarkers: vi.fn(),
    };
    const createLayeredMarkerDisplayManager = vi.fn(
      () => layeredMarkerDisplay,
    );
    const map = {};

    const result = createReadOnlyMarkerLayerControl({
      clusterGroups: { "layer-1": group1, "layer-2": group2 },
      createLayeredMarkerDisplayManager,
      escapeHtml: (value) => String(value ?? ""),
      layerNames: { "layer-1": "Stations" },
      layerVisibilityGroups: { "layer-1": group1, "layer-2": group2 },
      leaflet: {
        control: { layers: () => layersControl },
        marker: vi.fn(),
      },
      map,
      markerRecords: {},
      markers: {},
      skipUnnamedLayers: true,
      visibleMarkerGroup: group1,
    });

    expect(layersControl.addOverlay).toHaveBeenCalledOnce();
    expect(layersControl.addOverlay).toHaveBeenCalledWith(group1, "Stations");
    expect(layersControl.addTo).toHaveBeenCalledWith(map);
    expect(layeredMarkerDisplay.rebuildVisibleMarkers).toHaveBeenCalledOnce();
    expect(result).toEqual({
      layeredMarkerDisplay,
      layerControlOverlayLayers: [group1],
      layersControl,
    });
  });
});
