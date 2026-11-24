import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRecentUserLocation,
  createMarkerPopupRuntime,
  enableMarkerIconFallback,
  escapeHtml,
  getRecentUserLocation,
  initializeUserLocation,
  markerOptionsForLayer,
  rememberUserLocation,
} from "../src/map/common/marker";

describe("map common marker", () => {
  const leaflet = createLeafletMock();

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    Object.assign(window, { L: leaflet });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.restoreAllMocks();
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
      on: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === "movestart") moveStart = listener;
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

  it("shares only recent valid positions from the same map", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { watchPosition } = mockLocationWatch();
    const map = locationMap();
    const otherMap = locationMap();
    initializeUserLocation(map);
    initializeUserLocation(otherMap);
    const reportPosition = watchPosition.mock.calls[0]![0];
    const reportOtherPosition = watchPosition.mock.calls[1]![0];

    expect(getRecentUserLocation(map)).toBeUndefined();
    reportPosition(createPosition(35.6812, 139.7671, now));
    expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(getRecentUserLocation(otherMap)).toBeUndefined();
    reportOtherPosition(createPosition(34.7, 135.5, now));
    expect(getRecentUserLocation(otherMap)).toEqual({ lat: 34.7, lng: 135.5 });

    reportPosition(createPosition(45, 140, now - 1));
    reportPosition(createPosition(45, 140, now + 1));
    reportPosition(createPosition(45, 140, Number.NaN));
    reportPosition(createPosition(91, 140, now));
    reportPosition(createPosition(45, -181, now));
    reportPosition(createPosition(Number.NaN, 140, now));
    expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });

    clock.mockReturnValue(now + 60_000);
    expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });
    clock.mockReturnValue(now + 60_001);
    expect(getRecentUserLocation(map)).toBeUndefined();
  });

  it("keeps a recent position on temporary errors and discards it on permission denial", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { watchPosition } = mockLocationWatch();
    const map = locationMap();
    initializeUserLocation(map);
    const [reportPosition, reportError] = watchPosition.mock.calls[0]!;
    reportPosition(createPosition(35.6812, 139.7671, Date.now()));

    for (const code of [2, 3]) {
      reportError?.({ code } as GeolocationPositionError);
      expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });
    }
    reportError?.({ code: 1 } as GeolocationPositionError);
    expect(getRecentUserLocation(map)).toBeUndefined();
  });

  it("allows a one-time position update without letting a later watch overwrite it with an older fix", () => {
    const { watchPosition } = mockLocationWatch();
    const map = locationMap();
    initializeUserLocation(map);
    const now = Date.now();
    rememberUserLocation(map, createPosition(35.6812, 139.7671, now));
    watchPosition.mock.calls[0]![0](createPosition(45, 140, now - 1000));
    expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });

    clearRecentUserLocation(map);
    expect(getRecentUserLocation(map)).toBeUndefined();
  });

  it.each(["unload", "beforeunload"])("stops sharing on %s and ignores queued updates", (event) => {
    const { watchPosition, clearWatch } = mockLocationWatch();
    const map = locationMap();
    initializeUserLocation(map);
    const [reportPosition] = watchPosition.mock.calls[0]!;
    reportPosition(createPosition(35.6812, 139.7671, Date.now()));
    expect(getRecentUserLocation(map)).toEqual({ lat: 35.6812, lng: 139.7671 });

    if (event === "unload") {
      const stop = map.on.mock.calls.find(([name]) => name === event)?.[1];
      stop?.();
    } else {
      window.dispatchEvent(new Event(event));
    }
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(42);
    expect(getRecentUserLocation(map)).toBeUndefined();
    reportPosition(createPosition(35.6812, 139.7671, Date.now()));
    expect(getRecentUserLocation(map)).toBeUndefined();
  });
});

function mockLocationWatch() {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn<Geolocation["watchPosition"]>().mockReturnValue(42);
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { clearWatch, watchPosition },
  });
  return { clearWatch, watchPosition };
}

function locationMap() {
  return {
    addControl: vi.fn(),
    getZoom: () => 8,
    on: vi.fn<(_eventName: string, _listener: () => void) => void>(),
    off: vi.fn(),
    setView: vi.fn(),
  };
}

function createPosition(
  latitude: number,
  longitude: number,
  timestamp = 1,
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
    timestamp,
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
