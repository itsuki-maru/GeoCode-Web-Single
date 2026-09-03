import type { TileServerRecord } from "../types";

type LeafletMap = {
  addControl(control: LeafletControl): void;
  setMaxBounds(bounds: unknown): void;
};

type LeafletControl = {
  getContainer?: () => HTMLElement | null;
};

type LeafletTileLayer = {
  addTo(map: LeafletMap): LeafletTileLayer;
};

interface LeafletNamespace {
  CRS: { EPSG3857: unknown };
  Control: {
    extend(definition: {
      options: { position: string };
      onAdd(): HTMLElement;
    }): new () => LeafletControl;
  };
  DomEvent: { disableClickPropagation(element: HTMLElement): void };
  DomUtil: {
    create(tagName: string, className: string): HTMLElement;
  };
  control: {
    attribution(options: { prefix: boolean }): {
      addAttribution(attribution: string): { addTo(map: LeafletMap): unknown };
    };
  };
  latLng(latitude: number, longitude: number): unknown;
  latLngBounds(southWest: unknown, northEast: unknown): unknown;
  map(
    elementId: string,
    options: {
      attributionControl: boolean;
      center: [number, number];
      crs: unknown;
      preferCanvas: boolean;
      zoom: number;
      zoomControl: boolean;
    },
  ): LeafletMap;
  tileLayer(
    url: string,
    options: {
      attribution: string;
      maxZoom: number;
      minZoom: number;
    },
  ): LeafletTileLayer;
}

interface ReadOnlyMapRuntimeOptions {
  center: [number, number];
  escapeHtml(value: unknown): string;
  handleTileChange: EventListener;
  leaflet: LeafletNamespace;
  onTileControlAdded?: (control: LeafletControl) => void;
  tileServers: Record<string, TileServerRecord>;
  zoom: number;
}

const LEAFLET_ATTRIBUTION =
  '&copy; <a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>';

export function createReadOnlyMapRuntime({
  center,
  escapeHtml,
  handleTileChange,
  leaflet,
  onTileControlAdded,
  tileServers,
  zoom,
}: ReadOnlyMapRuntimeOptions) {
  const defaultTileServer = tileServers["1"];
  if (!defaultTileServer) {
    throw new Error("Default tile server 1 is required");
  }

  const map = leaflet.map("map", {
    center,
    crs: leaflet.CRS.EPSG3857,
    zoom,
    zoomControl: true,
    preferCanvas: false,
    attributionControl: false,
  });

  const southWest = leaflet.latLng(20.25, 122.56);
  const northEast = leaflet.latLng(45.55, 153.59);
  const bounds = leaflet.latLngBounds(southWest, northEast);

  if (!defaultTileServer.include_foreign_tiles) {
    map.setMaxBounds(bounds);
  }

  leaflet.control
    .attribution({ prefix: false })
    .addAttribution(LEAFLET_ATTRIBUTION)
    .addTo(map);

  const TileControl = leaflet.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control",
      );
      let radioHtml = '<div class="radio-zone"><form>';

      for (const [tileServerId, tileServer] of Object.entries(tileServers)) {
        const checkedAttribute = tileServerId === "1" ? "checked" : "";
        const layerName = escapeHtml(tileServer.layer_name);
        radioHtml += `
                <input class="tile-radio" type="radio" id="${layerName}" name="tile" value="${tileServerId}" ${checkedAttribute}>
                <label for="${layerName}" class="tile-radio-label">${escapeHtml(tileServer.label)}</label><br>
                `;
      }
      radioHtml += "</form></div>";
      container.innerHTML = radioHtml;

      container.querySelectorAll(".tile-radio").forEach((radio) => {
        radio.addEventListener("change", handleTileChange);
      });
      leaflet.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  const tileControl = new TileControl();
  map.addControl(tileControl);
  onTileControlAdded?.(tileControl);

  const tileLayer = leaflet
    .tileLayer(defaultTileServer.url, {
      minZoom: defaultTileServer.min_zoom ?? 5,
      maxZoom: defaultTileServer.max_zoom ?? 18,
      attribution: defaultTileServer.attribution,
    })
    .addTo(map);

  return { bounds, map, tileControl, tileLayer };
}
