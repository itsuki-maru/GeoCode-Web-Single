import { describe, expect, it, vi } from "vitest";

import {
  createCollapsibleLayerControl,
  createCurrentLocationControl,
  createNameVisibilityControl,
  focusSharedLocation,
} from "../src/live-map/controls";

function createLeafletMock() {
  return {
    Control: {
      extend: (definition: { options: unknown; onAdd(): HTMLElement }) =>
        class {
          options = definition.options;
          onAdd = definition.onAdd;
        },
    },
    DomEvent: {
      disableClickPropagation: vi.fn(),
      on: (element: HTMLElement, eventName: string, handler: (event: Event) => void) =>
        element.addEventListener(eventName, handler),
      stop: vi.fn(),
    },
    DomUtil: {
      create: (tagName: string, className: string, container?: HTMLElement) => {
        const element = document.createElement(tagName);
        element.className = className;
        container?.appendChild(element);
        return element;
      },
    },
  };
}

describe("live map controls", () => {
  it("collapses dynamic mobile layer choices behind a text button", () => {
    const leaflet = createLeafletMock();
    const container = document.createElement("div");
    const overlays = document.createElement("div");
    overlays.className = "leaflet-control-layers-overlays";
    for (let index = 0; index < 4; index += 1) {
      overlays.appendChild(document.createElement("label"));
    }
    container.appendChild(overlays);
    const map = { on: vi.fn() };
    const control = createCollapsibleLayerControl({ container, leaflet, map });
    const button = container.querySelector<HTMLButtonElement>(
      ".live-layer-control-toggle",
    )!;

    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("折り畳む");
    button.click();
    expect(button.textContent).toBe("すべて表示");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.classList.contains("is-collapsed")).toBe(true);
    expect(overlays.querySelectorAll(".live-layer-control-collapsible-item"))
      .toHaveLength(2);

    overlays.querySelector("label:last-child")?.remove();
    control.sync();
    expect(button.hidden).toBe(true);
    expect(container.classList.contains("is-collapsed")).toBe(false);
  });

  it("shows a hidden member layer and focuses its latest marker", () => {
    const memberLayer = {};
    const marker = {
      getLatLng: vi.fn(() => ({ lat: 35.68, lng: 139.76 })),
      openPopup: vi.fn(),
    };
    const map = {
      addLayer: vi.fn(),
      getZoom: vi.fn(() => 12),
      hasLayer: vi.fn(() => false),
      setView: vi.fn(),
    };

    expect(focusSharedLocation({ map, marker, memberLayer })).toBe(true);
    expect(map.addLayer).toHaveBeenCalledWith(memberLayer);
    expect(map.setView).toHaveBeenCalledWith({ lat: 35.68, lng: 139.76 }, 16);
    expect(marker.openPopup).toHaveBeenCalledOnce();
  });

  it("does not move when a member has no current marker", () => {
    const map = {
      addLayer: vi.fn(),
      getZoom: vi.fn(() => 18),
      hasLayer: vi.fn(() => true),
      setView: vi.fn(),
    };

    expect(focusSharedLocation({ map, marker: undefined, memberLayer: {} })).toBe(false);
    expect(map.setView).not.toHaveBeenCalled();
  });

  it("requests the viewer location only after clicking and centers the map", () => {
    const leaflet = createLeafletMock();
    const map = { getZoom: vi.fn(() => 12), setView: vi.fn() };
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 35.68, longitude: 139.76 },
    } as GeolocationPosition));
    const control = createCurrentLocationControl({
      geolocation: { getCurrentPosition } as unknown as Geolocation,
      leaflet,
      map,
      onError: vi.fn(),
      position: "topright",
    });

    const container = control.onAdd();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    container.querySelector("button")?.click();

    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(map.setView).toHaveBeenCalledWith([35.68, 139.76], 16);
  });

  it("shows names only for markers on visible layers and keeps the mode on overlay changes", () => {
    const leaflet = createLeafletMock();
    const visibleMarker = { closeTooltip: vi.fn(), openTooltip: vi.fn() };
    const hiddenMarker = { closeTooltip: vi.fn(), openTooltip: vi.fn() };
    const visibleLayers = new Set([visibleMarker]);
    let overlayHandler: (() => void) | undefined;
    const map = {
      hasLayer: (layer: typeof visibleMarker) => visibleLayers.has(layer),
      on: vi.fn((_events: string, handler: () => void) => { overlayHandler = handler; }),
    };
    const names = createNameVisibilityControl({
      getMarkers: () => [visibleMarker, hiddenMarker],
      leaflet,
      map,
      position: "topright",
    });
    const container = names.control.onAdd();
    const button = container.querySelector("button")!;

    expect(button.textContent).toBe("名前を表示");
    button.click();
    expect(visibleMarker.openTooltip).toHaveBeenCalledOnce();
    expect(hiddenMarker.openTooltip).not.toHaveBeenCalled();
    expect(hiddenMarker.closeTooltip).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("名前を隠す");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    visibleLayers.add(hiddenMarker);
    overlayHandler?.();
    expect(hiddenMarker.openTooltip).toHaveBeenCalledOnce();
  });
});
