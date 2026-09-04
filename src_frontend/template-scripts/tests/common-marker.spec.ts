import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMarkerPopupRuntime,
  enableMarkerIconFallback,
  escapeHtml,
  initializeUserLocation,
  markerOptionsForLayer,
} from "../src/map/common/marker";

describe("map common marker", () => {
  const leaflet = createLeafletMock();

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    Object.assign(window, { L: leaflet });
  });

  it("escapes marker and layer labels", () => {
    expect(escapeHtml('<a title="x">Tom & Jerry\'s</a>')).toBe(
      "&lt;a title=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("opens a marker popup with the standard focused icon", () => {
    const marker = { openPopup: vi.fn(), setIcon: vi.fn() };
    const runtime = createMarkerPopupRuntime({
      getLeafletNamespace: () => leaflet,
      getMarkers: () => ({ "marker-7": marker }),
    });

    runtime.openMarkerPopup(7);

    expect(marker.setIcon).toHaveBeenCalledWith(expect.anything());
    expect(marker.openPopup).toHaveBeenCalledOnce();
  });

  it("creates an encoded custom marker icon while preserving options", () => {
    const options = markerOptionsForLayer(
      "layer-1",
      { "layer-1": { marker_icon_filename: "避難所 icon.png" } },
      { draggable: true },
    );

    expect(options.draggable).toBe(true);
    expect(leaflet.icon).toHaveBeenCalledWith(
      expect.objectContaining({
        iconUrl: "/static/marker-icons/%E9%81%BF%E9%9B%A3%E6%89%80%20icon.png",
      }),
    );
    expect(
      markerOptionsForLayer("layer-2", {
        "layer-2": { marker_icon_filename: null },
      }),
    ).toEqual({});
  });

  it("uses the default icon once when a custom icon fails to load", () => {
    const iconElement = document.createElement("img");
    const setIcon = vi.fn();
    const addListeners: Array<() => void> = [];
    const marker = {
      getElement: () => iconElement,
      on: (_eventName: string, listener: () => void) => {
        addListeners.push(listener);
      },
      setIcon,
    };

    expect(
      enableMarkerIconFallback(marker, "layer-1", {
        "layer-1": { marker_icon_filename: "custom.png" },
      }),
    ).toBe(marker);
    iconElement.dispatchEvent(new Event("error"));
    iconElement.dispatchEvent(new Event("error"));

    expect(setIcon).toHaveBeenCalledOnce();
    expect(iconElement.dataset.markerIconFallbackBound).toBe("true");
    expect(addListeners).toHaveLength(1);
  });

  it("starts one location watch and renders location updates", () => {
    let success: ((position: GeolocationPosition) => void) | undefined;
    const clearWatch = vi.fn();
    const watchPosition = vi.fn(
      (onSuccess: (position: GeolocationPosition) => void) => {
        success = onSuccess;
        return 42;
      },
    );
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { clearWatch, watchPosition },
    });
    const controls: object[] = [];
    const setView = vi.fn();
    const map = {
      addControl: (control: object) => void controls.push(control),
      getZoom: () => 10,
      off: vi.fn(),
      on: vi.fn(),
      setView,
    };

    const layer = initializeUserLocation(map, {
      controlClassName: "hideable",
    });
    expect(layer).not.toBeNull();
    expect(watchPosition).toHaveBeenCalledOnce();
    expect(controls).toHaveLength(1);
    expect(initializeUserLocation(map)).toBeNull();

    success?.({
      coords: {
        accuracy: 12,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: 35.6812,
        longitude: 139.7671,
        speed: null,
        toJSON: () => ({}),
      },
      timestamp: 1,
      toJSON: () => ({}),
    });
    expect(leaflet.circleMarker).toHaveBeenCalledOnce();
    expect(leaflet.circle).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("beforeunload"));
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(setView).not.toHaveBeenCalled();
  });

  it("centers the initial view on the first location update when requested", () => {
    let success: ((position: GeolocationPosition) => void) | undefined;
    const watchPosition = vi.fn(
      (onSuccess: (position: GeolocationPosition) => void) => {
        success = onSuccess;
        return 7;
      },
    );
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { clearWatch: vi.fn(), watchPosition },
    });
    const setView = vi.fn();
    const off = vi.fn();
    const on = vi.fn();
    const map = {
      addControl: vi.fn(),
      getZoom: () => 8,
      off,
      on,
      setView,
    };

    initializeUserLocation(map, { centerOnInitialPosition: true });
    success?.(createPosition(35.6812, 139.7671));

    expect(on).toHaveBeenCalledWith("movestart", expect.any(Function));
    expect(off).toHaveBeenCalledWith("movestart", expect.any(Function));
    expect(setView).toHaveBeenCalledWith(expect.anything(), 16);
  });

  it("does not override map movement made before the initial location update", () => {
    let success: ((position: GeolocationPosition) => void) | undefined;
    let moveStart: (() => void) | undefined;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        clearWatch: vi.fn(),
        watchPosition: vi.fn(
          (onSuccess: (position: GeolocationPosition) => void) => {
            success = onSuccess;
            return 8;
          },
        ),
      },
    });
    const setView = vi.fn();
    const map = {
      addControl: vi.fn(),
      getZoom: () => 8,
      off: vi.fn(),
      on: vi.fn((_eventName: string, listener: () => void) => {
        moveStart = listener;
      }),
      setView,
    };

    initializeUserLocation(map, { centerOnInitialPosition: true });
    moveStart?.();
    success?.(createPosition(35.6812, 139.7671));

    expect(setView).not.toHaveBeenCalled();
  });

  it("keeps the backend view when the initial location lookup fails", () => {
    let failure: ((error: GeolocationPositionError) => void) | undefined;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        clearWatch: vi.fn(),
        watchPosition: vi.fn(
          (
            _onSuccess: (position: GeolocationPosition) => void,
            onError: (error: GeolocationPositionError) => void,
          ) => {
            failure = onError;
            return 9;
          },
        ),
      },
    });
    const setView = vi.fn();
    const map = {
      addControl: vi.fn(),
      getZoom: () => 6,
      off: vi.fn(),
      on: vi.fn(),
      setView,
    };

    initializeUserLocation(map, { centerOnInitialPosition: true });
    failure?.({
      code: 1,
      message: "denied",
      PERMISSION_DENIED: 1,
    } as GeolocationPositionError);

    expect(setView).not.toHaveBeenCalled();
    expect(map.off).toHaveBeenCalledWith("movestart", expect.any(Function));
  });
});

function createPosition(
  latitude: number,
  longitude: number,
): GeolocationPosition {
  return {
    coords: {
      accuracy: 12,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude,
      longitude,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: 1,
    toJSON: () => ({}),
  };
}

function createLeafletMock() {
  const createLocationMarker = (withRadius: boolean) => {
    const marker = {
      addTo: vi.fn(function () {
        return marker;
      }),
      setLatLng: vi.fn(),
      ...(withRadius ? { setRadius: vi.fn() } : {}),
    };
    return marker;
  };

  return {
    Control: {
      extend: (definition: { onAdd(): HTMLElement }) =>
        class {
          onAdd() {
            return definition.onAdd();
          }
        },
    },
    DomEvent: {
      disableClickPropagation: vi.fn(),
      on: (
        element: HTMLElement,
        eventName: string,
        listener: (event: Event) => void,
      ) => element.addEventListener(eventName, listener),
      stop: vi.fn(),
    },
    DomUtil: {
      create: (tagName: string, className: string, container?: HTMLElement) => {
        const element = document.createElement(tagName);
        element.className = className;
        container?.append(element);
        return element;
      },
    },
    Icon: { Default: class {} },
    LatLng: class {
      constructor(
        public latitude: number,
        public longitude: number,
      ) {}
    },
    circle: vi.fn(() => createLocationMarker(true)),
    circleMarker: vi.fn(() => createLocationMarker(false)),
    icon: vi.fn(() => ({})),
    layerGroup: vi.fn(() => {
      const layer = {
        addTo: vi.fn(function () {
          return layer;
        }),
      };
      return layer;
    }),
  };
}
