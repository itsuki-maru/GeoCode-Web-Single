const YOUTUBE_ID_PATTERN = /^[\w-]{11}$/;

export interface LayerMap {
  addLayer(layer: object): void;
  hasLayer(layer: object): boolean;
  on(
    events: string,
    listener: (event: { layer: object }) => void,
  ): void;
  removeLayer(layer: object): void;
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
    disableScrollPropagation?: (element: HTMLElement) => void;
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
}

function getLeaflet(): LeafletNamespace {
  const leaflet = (window as Window & { L?: LeafletNamespace }).L;
  if (!leaflet) throw new Error("Leaflet is not loaded");
  return leaflet;
}

export function createLayerBulkToggleControl({
  map,
  overlayLayers,
  position = "topright",
}: {
  map: LayerMap;
  overlayLayers: Array<object | null | undefined>;
  position?: string;
}): object {
  const leaflet = getLeaflet();
  const targetLayers = Array.isArray(overlayLayers)
    ? overlayLayers.filter((layer): layer is object => Boolean(layer))
    : [];

  const LayerBulkToggleControl = leaflet.Control.extend({
    options: { position },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control layer-bulk-toggle-control",
      );
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      ) as HTMLButtonElement;
      button.type = "button";

      const hasVisibleLayer = () =>
        targetLayers.some((layer) => map.hasLayer(layer));

      const updateButtonState = () => {
        const shouldClear = hasVisibleLayer();
        button.textContent = shouldClear ? "全解除" : "全選択";
        button.setAttribute("aria-label", button.textContent);
      };

      const toggleAllLayers = () => {
        const shouldClear = hasVisibleLayer();
        targetLayers.forEach((layer) => {
          if (shouldClear) {
            if (map.hasLayer(layer)) map.removeLayer(layer);
            return;
          }

          if (!map.hasLayer(layer)) map.addLayer(layer);
        });
        updateButtonState();
      };

      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        toggleAllLayers();
      });

      map.on("overlayadd overlayremove", (event) => {
        if (targetLayers.includes(event.layer)) updateButtonState();
      });

      leaflet.DomEvent.disableClickPropagation(container);
      leaflet.DomEvent.disableScrollPropagation?.(container);
      updateButtonState();
      return container;
    },
  });

  return new LayerBulkToggleControl();
}

export function extractYouTubeId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const allowedHosts = [
      "www.youtube.com",
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com",
    ];
    if (!allowedHosts.includes(host)) return null;

    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v") ?? "";
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/embed/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}
