interface MarkerLayerRecord {
  marker_icon_filename?: string | null;
}

interface LocationLayer {
  addTo(map: LocationMap): LocationLayer;
}

interface LocationMarker {
  addTo(layer: LocationLayer): LocationMarker;
  setLatLng(latLng: object): void;
}

interface AccuracyCircle extends LocationMarker {
  setRadius(radius: number): void;
}

interface LocationMap {
  _userLocationInitialized?: boolean;
  addControl(control: object): void;
  getZoom(): number;
  off(eventName: string, listener: () => void): void;
  on(eventName: string, listener: () => void): void;
  setView(latLng: object, zoom: number): void;
}

interface FallbackMarker {
  getElement(): HTMLElement | null;
  on(eventName: string, listener: () => void): void;
  setIcon(icon: object): void;
}

interface PopupMarker {
  openPopup(): void;
  setIcon(icon: object): void;
}

interface LeafletNamespace {
  Control: {
    extend(definition: {
      options: { position: string };
      onAdd(): HTMLElement;
    }): new () => object;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    on(
      element: HTMLElement,
      eventName: string,
      listener: (event: Event) => void,
    ): void;
    stop(event: Event): void;
  };
  DomUtil: {
    create(
      tagName: string,
      className: string,
      container?: HTMLElement,
    ): HTMLElement;
  };
  Icon: {
    Default: new () => object;
  };
  LatLng: new (latitude: number, longitude: number) => object;
  circle(
    latLng: object,
    options: Record<string, unknown>,
  ): AccuracyCircle;
  circleMarker(
    latLng: object,
    options: Record<string, unknown>,
  ): LocationMarker;
  icon(options: Record<string, unknown>): object;
  layerGroup(): LocationLayer;
}

function getLeaflet(): LeafletNamespace {
  const leaflet = (window as Window & { L?: LeafletNamespace }).L;
  if (!leaflet) throw new Error("Leaflet is not loaded");
  return leaflet;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createMarkerPopupRuntime({
  getMarkers,
  getLeafletNamespace = getLeaflet,
}: {
  getMarkers(): Record<string, PopupMarker>;
  getLeafletNamespace?: () => Pick<LeafletNamespace, "icon">;
}) {
  const openMarkerPopup = (markerId: string | number): void => {
    const marker = getMarkers()[`marker-${markerId}`];
    if (!marker) return;
    marker.setIcon(
      getLeafletNamespace().icon({
        iconUrl: "/assets/marker.png",
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowUrl: null,
      }),
    );
    marker.openPopup();
  };

  return { openMarkerPopup };
}

export function initializeUserLocation(
  map: LocationMap,
  options: {
    centerOnInitialPosition?: boolean;
    controlClassName?: string;
    position?: string;
  } = {},
): LocationLayer | null {
  const geolocation = (
    navigator as Navigator & { geolocation?: Geolocation }
  ).geolocation;
  if (!geolocation || map._userLocationInitialized) return null;

  map._userLocationInitialized = true;
  const leaflet = getLeaflet();
  const userLocationLayer = leaflet.layerGroup().addTo(map);
  let userLocationMarker: LocationMarker | null = null;
  let userLocationAccuracyCircle: AccuracyCircle | null = null;
  let userLocationWatchId: number | null = null;
  let latestUserLatLng: object | null = null;
  let shouldCenterOnNextUpdate = options.centerOnInitialPosition === true;
  let hasShownError = false;
  let shouldNotifyError = false;

  const cancelInitialCenter = (): void => {
    shouldCenterOnNextUpdate = false;
    map.off("movestart", cancelInitialCenter);
  };
  if (shouldCenterOnNextUpdate) map.on("movestart", cancelInitialCenter);

  const finishInitialCenter = (): void => {
    map.off("movestart", cancelInitialCenter);
  };

  const renderUserLocation = (position: GeolocationPosition): void => {
    const { latitude, longitude, accuracy = 0 } = position.coords;
    const latLng = new leaflet.LatLng(latitude, longitude);
    latestUserLatLng = latLng;
    hasShownError = false;
    shouldNotifyError = false;

    if (window.parent !== window) {
      window.parent.postMessage(
        {
          type: "userLocationUpdate",
          position: {
            latitude,
            longitude,
            accuracy,
            heading: position.coords.heading,
            speed: position.coords.speed,
            timestamp: position.timestamp,
          },
        },
        window.location.origin,
      );
    }

    if (!userLocationMarker) {
      userLocationMarker = leaflet
        .circleMarker(latLng, {
          radius: 8,
          fillColor: "#1a73e8",
          fillOpacity: 1,
          color: "#ffffff",
          weight: 3,
        })
        .addTo(userLocationLayer);
    } else {
      userLocationMarker.setLatLng(latLng);
    }

    if (!userLocationAccuracyCircle) {
      userLocationAccuracyCircle = leaflet
        .circle(latLng, {
          radius: accuracy,
          fillColor: "#1a73e8",
          fillOpacity: 0.15,
          color: "#1a73e8",
          weight: 1,
          opacity: 0.25,
          interactive: false,
        })
        .addTo(userLocationLayer) as AccuracyCircle;
    } else {
      userLocationAccuracyCircle.setLatLng(latLng);
      userLocationAccuracyCircle.setRadius(accuracy);
    }

    if (shouldCenterOnNextUpdate) {
      finishInitialCenter();
      map.setView(latLng, Math.max(map.getZoom(), 16));
      shouldCenterOnNextUpdate = false;
    }
  };

  const handleUserLocationError = (error: GeolocationPositionError): void => {
    if (shouldNotifyError && hasShownError) return;
    finishInitialCenter();
    shouldCenterOnNextUpdate = false;
    if (shouldNotifyError) {
      hasShownError = true;
      window.alert("位置情報の取得に失敗しました");
    }
    console.error("Get location error", error);
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: "userLocationError", code: error.code },
        window.location.origin,
      );
    }
  };

  const startUserLocationWatch = (): void => {
    if (userLocationWatchId !== null) return;
    userLocationWatchId = geolocation.watchPosition(
      renderUserLocation,
      handleUserLocationError,
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      },
    );
  };

  const geoFindMe = (): void => {
    shouldNotifyError = true;
    shouldCenterOnNextUpdate = true;
    if (latestUserLatLng) {
      map.setView(latestUserLatLng, Math.max(map.getZoom(), 16));
      shouldCenterOnNextUpdate = false;
      shouldNotifyError = false;
      return;
    }
    startUserLocationWatch();
  };

  const UserLocationControl = leaflet.Control.extend({
    options: { position: options.position ?? "topright" },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control",
      );
      if (options.controlClassName) {
        container.classList.add(options.controlClassName);
      }
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.textContent = "現在位置";
      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        geoFindMe();
      });
      leaflet.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  map.addControl(new UserLocationControl());
  startUserLocationWatch();
  window.addEventListener("beforeunload", () => {
    if (userLocationWatchId !== null) {
      geolocation.clearWatch(userLocationWatchId);
      userLocationWatchId = null;
    }
  });
  return userLocationLayer;
}

export function markerOptionsForLayer(
  layerId: string | null | undefined,
  layerRecords: Record<string, MarkerLayerRecord> | null | undefined,
  extraOptions: Record<string, unknown> = {},
): Record<string, unknown> {
  const filename =
    layerRecords && layerId
      ? layerRecords[layerId]?.marker_icon_filename
      : null;
  if (!filename) return { ...extraOptions };

  return {
    ...extraOptions,
    icon: getLeaflet().icon({
      iconUrl: "/static/marker-icons/" + encodeURIComponent(filename),
      iconSize: [30, 30],
      iconAnchor: [20, 40],
      popupAnchor: [0, -40],
      tooltipAnchor: [0, -20],
    }),
  };
}

export function enableMarkerIconFallback<TMarker extends FallbackMarker>(
  marker: TMarker,
  layerId: string | null | undefined,
  layerRecords: Record<string, MarkerLayerRecord> | null | undefined,
): TMarker {
  const layerRecord =
    layerRecords && layerId ? layerRecords[layerId] : undefined;
  if (!layerRecord?.marker_icon_filename) return marker;

  let fallbackApplied = false;
  const bindFallback = (): void => {
    if (fallbackApplied) return;
    const iconElement = marker.getElement();
    if (
      !iconElement ||
      iconElement.dataset.markerIconFallbackBound === "true"
    ) {
      return;
    }

    iconElement.dataset.markerIconFallbackBound = "true";
    iconElement.addEventListener(
      "error",
      () => {
        if (fallbackApplied) return;
        fallbackApplied = true;
        marker.setIcon(new (getLeaflet().Icon.Default)());
      },
      { once: true },
    );
  };

  marker.on("add", bindFallback);
  bindFallback();
  return marker;
}
