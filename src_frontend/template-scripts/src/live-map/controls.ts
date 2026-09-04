type ControlPosition = "topleft" | "topright" | "bottomleft" | "bottomright";

type LocationMap = {
  getZoom(): number;
  setView(position: [number, number], zoom: number): void;
};

type TooltipMarker = {
  closeTooltip(): void;
  openTooltip(): void;
};

type TooltipMap = {
  hasLayer(layer: TooltipMarker): boolean;
  on(eventNames: string, handler: () => void): void;
};

type SharedLocationMarker = {
  getLatLng(): [number, number] | { lat: number; lng: number };
  openPopup(): void;
};

type SharedLocationMap = {
  addLayer(layer: unknown): void;
  getZoom(): number;
  hasLayer(layer: unknown): boolean;
  setView(
    position: [number, number] | { lat: number; lng: number },
    zoom: number,
  ): void;
};

type LeafletControl = {
  onAdd(): HTMLElement;
};

type CollapsibleLayerControlMap = {
  on(eventNames: string, handler: () => void): void;
};

type LeafletNamespace = {
  Control: {
    extend(definition: {
      options: { position: ControlPosition };
      onAdd(): HTMLElement;
    }): new () => LeafletControl;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    disableScrollPropagation?(element: HTMLElement): void;
    on(element: HTMLElement, eventName: string, handler: (event: Event) => void): void;
    stop(event: Event): void;
  };
  DomUtil: {
    create(tagName: string, className: string, container?: HTMLElement): HTMLElement;
  };
};

export function focusSharedLocation({
  map,
  marker,
  memberLayer,
  minZoom = 16,
}: {
  map: SharedLocationMap;
  marker: SharedLocationMarker | undefined;
  memberLayer: unknown;
  minZoom?: number;
}): boolean {
  if (!marker) return false;
  if (!map.hasLayer(memberLayer)) map.addLayer(memberLayer);
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), minZoom));
  marker.openPopup();
  return true;
}

export function createCollapsibleLayerControl({
  container,
  leaflet,
  map,
  minimumItemCount = 4,
  visibleItemCount = 2,
}: {
  container: HTMLElement;
  leaflet: LeafletNamespace;
  map: CollapsibleLayerControlMap;
  minimumItemCount?: number;
  visibleItemCount?: number;
}) {
  let collapsed = false;
  container.classList.add("live-layer-control");
  const toggleButton = leaflet.DomUtil.create(
    "button",
    "live-layer-control-toggle",
    container,
  ) as HTMLButtonElement;
  toggleButton.type = "button";

  const sync = (): void => {
    const overlayContainer = container.querySelector(
      ".leaflet-control-layers-overlays",
    );
    const items = overlayContainer
      ? Array.from(overlayContainer.querySelectorAll<HTMLElement>("label"))
      : [];
    items.forEach((item, index) => {
      item.classList.toggle(
        "live-layer-control-collapsible-item",
        index >= visibleItemCount,
      );
    });
    const canCollapse = items.length >= minimumItemCount;
    if (!canCollapse) collapsed = false;
    container.classList.toggle("is-collapsed", canCollapse && collapsed);
    toggleButton.hidden = !canCollapse;
    toggleButton.textContent = collapsed ? "すべて表示" : "折り畳む";
    toggleButton.setAttribute("aria-expanded", String(!collapsed));
  };

  leaflet.DomEvent.on(toggleButton, "click", (event) => {
    leaflet.DomEvent.stop(event);
    collapsed = !collapsed;
    sync();
  });
  map.on("overlayadd overlayremove", () => window.setTimeout(sync, 0));
  leaflet.DomEvent.disableClickPropagation(container);
  leaflet.DomEvent.disableScrollPropagation?.(container);
  sync();
  return { sync };
}

export function createCurrentLocationControl({
  geolocation,
  leaflet,
  map,
  onError,
  position,
}: {
  geolocation: Geolocation | undefined;
  leaflet: LeafletNamespace;
  map: LocationMap;
  onError: () => void;
  position: ControlPosition;
}): LeafletControl {
  const CurrentLocationControl = leaflet.Control.extend({
    options: { position },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control",
      );
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      ) as HTMLButtonElement;
      button.type = "button";
      button.textContent = "現在位置へ移動";
      button.setAttribute("aria-label", "現在位置へ移動");

      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        if (!geolocation) {
          onError();
          return;
        }
        button.disabled = true;
        geolocation.getCurrentPosition(
          ({ coords }) => {
            map.setView(
              [coords.latitude, coords.longitude],
              Math.max(map.getZoom(), 16),
            );
            button.disabled = false;
          },
          () => {
            button.disabled = false;
            onError();
          },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
        );
      });
      leaflet.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  return new CurrentLocationControl();
}

export function createNameVisibilityControl({
  getMarkers,
  leaflet,
  map,
  position,
}: {
  getMarkers: () => Iterable<TooltipMarker>;
  leaflet: LeafletNamespace;
  map: TooltipMap;
  position: ControlPosition;
}) {
  let visible = false;
  let button: HTMLButtonElement | null = null;

  const syncMarker = (marker: TooltipMarker): void => {
    if (visible && map.hasLayer(marker)) marker.openTooltip();
    else marker.closeTooltip();
  };

  const syncAll = (): void => {
    for (const marker of getMarkers()) syncMarker(marker);
  };

  const updateButton = (): void => {
    if (!button) return;
    button.textContent = visible ? "名前を隠す" : "名前を表示";
    button.setAttribute("aria-pressed", String(visible));
    button.classList.toggle("is-active", visible);
  };

  const NameVisibilityControl = leaflet.Control.extend({
    options: { position },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control",
      );
      button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      ) as HTMLButtonElement;
      button.type = "button";
      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        visible = !visible;
        updateButton();
        syncAll();
      });
      leaflet.DomEvent.disableClickPropagation(container);
      updateButton();
      return container;
    },
  });

  map.on("overlayadd overlayremove", syncAll);
  return {
    control: new NameVisibilityControl(),
    isVisible: () => visible,
    syncAll,
    syncMarker,
  };
}
