import type { TileServerRecord } from "../types";
import { createBasemapController } from "./basemap-controller";

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
  initialTileServerId?: string;
  center: [number, number];
  escapeHtml(value: unknown): string;
  handleTileChange?: EventListener;
  leaflet: LeafletNamespace;
  onTileControlAdded?: (control: LeafletControl) => void;
  saveSelectedTileServerId?: (id: string) => void;
  onBasemapError?: () => void;
  tileServers: Record<string, TileServerRecord>;
  zoom: number;
}

const LEAFLET_ATTRIBUTION =
  '&copy; <a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>';

export function createReadOnlyMapRuntime({
  initialTileServerId = "1",
  center,
  escapeHtml,
  handleTileChange,
  leaflet,
  onTileControlAdded,
  saveSelectedTileServerId,
  onBasemapError,
  tileServers,
  zoom,
}: ReadOnlyMapRuntimeOptions) {
  const defaultTileServer = tileServers[initialTileServerId];
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

  leaflet.control.attribution({ prefix: false }).addAttribution(LEAFLET_ATTRIBUTION).addTo(map);

  let basemapController: ReturnType<typeof createBasemapController> | undefined;
  let controlElement: HTMLElement | undefined;
  const syncTileSelection = (id: string) => {
    controlElement?.querySelectorAll<HTMLInputElement>(".tile-radio").forEach((radio) => {
      radio.checked = radio.value === id;
    });
    controlElement?.setAttribute("aria-busy", String(basemapController?.isPending() ?? false));
  };
  const refreshTileSelection = () => {
    if (basemapController) syncTileSelection(basemapController.getSelectedId());
  };

  const TileControl = leaflet.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = leaflet.DomUtil.create("div", "leaflet-bar leaflet-control");
      controlElement = container;
      let radioHtml = '<div class="radio-zone"><form>';

      for (const [tileServerId, tileServer] of Object.entries(tileServers)) {
        const checkedAttribute = tileServerId === initialTileServerId ? "checked" : "";
        const layerName = escapeHtml(tileServer.layer_name);
        radioHtml += `
                <input class="tile-radio" type="radio" id="${layerName}" name="tile" value="${tileServerId}" ${checkedAttribute}>
                <label for="${layerName}" class="tile-radio-label">${escapeHtml(tileServer.label)}</label><br>
                `;
      }
      radioHtml += "</form></div>";
      container.innerHTML = radioHtml;

      container.querySelectorAll(".tile-radio").forEach((radio) => {
        const selectTile = (event: Event) => {
          const id = (event.target as HTMLInputElement).value;
          if (basemapController) {
            void basemapController.select(id).then(refreshTileSelection, refreshTileSelection);
            refreshTileSelection();
          }
          handleTileChange?.(event);
        };
        radio.addEventListener("change", selectTile);
        radio.addEventListener("click", (event) => {
          // 確定IDのradioは切替中もcheckedのため、再選択ではchangeが発生しない。
          if (
            basemapController?.isPending() &&
            (event.target as HTMLInputElement).value === basemapController.getSelectedId()
          )
            selectTile(event);
        });
      });
      leaflet.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  const tileControl = new TileControl();
  map.addControl(tileControl);
  onTileControlAdded?.(tileControl);

  basemapController = createBasemapController({
    leaflet,
    map,
    tileServers,
    bounds,
    initialId: initialTileServerId,
    saveSelectedTileServerId,
    onCommit: (id) => syncTileSelection(id),
    onError: onBasemapError,
  });
  const eventMap = map as LeafletMap & { on?(name: string, callback: () => void): void };
  eventMap.on?.("basemaploadingchange", refreshTileSelection);
  refreshTileSelection();

  return {
    bounds,
    map,
    tileControl,
    basemapController,
    get tileLayer() {
      return basemapController.getLayer();
    },
  };
}
