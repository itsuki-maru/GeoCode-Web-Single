import { describe, expect, it, vi } from "vitest";

import { createReadOnlyMapRuntime } from "../src/map/common/map-runtime";
import type { TileServerRecord } from "../src/map/types";

const tileServers: Record<string, TileServerRecord> = {
  "1": {
    attribution: "Default attribution",
    id: 1,
    include_foreign_tiles: false,
    label: "Default <map>",
    layer_name: "default-map",
    max_zoom: null,
    min_zoom: null,
    url: "https://tiles.example.test/1/{z}/{x}/{y}.png",
  },
  "2": {
    attribution: "Global attribution",
    id: 2,
    include_foreign_tiles: true,
    label: "Global",
    layer_name: "global-map",
    max_zoom: 20,
    min_zoom: 2,
    url: "https://tiles.example.test/2/{z}/{x}/{y}.png",
  },
};

function createLeafletMock() {
  const bounds = { kind: "bounds" };
  const tileLayer = { addTo: vi.fn(() => tileLayer) };
  const map = {
    addControl: vi.fn((control: { onAdd(): HTMLElement }) => control.onAdd()),
    setMaxBounds: vi.fn(),
  };
  const attributionControl = {
    addAttribution: vi.fn(() => attributionControl),
    addTo: vi.fn(),
  };
  const disableClickPropagation = vi.fn();
  const leaflet = {
    CRS: { EPSG3857: "EPSG3857" },
    Control: {
      extend: vi.fn(
        (definition: { options: unknown; onAdd(): HTMLElement }) =>
          class {
            options = definition.options;
            onAdd = definition.onAdd;
          },
      ),
    },
    DomEvent: { disableClickPropagation },
    DomUtil: {
      create: (tagName: string, className: string) => {
        const element = document.createElement(tagName);
        element.className = className;
        return element;
      },
    },
    control: { attribution: vi.fn(() => attributionControl) },
    latLng: vi.fn((latitude: number, longitude: number) => ({
      latitude,
      longitude,
    })),
    latLngBounds: vi.fn(() => bounds),
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => tileLayer),
  };

  return {
    attributionControl,
    bounds,
    disableClickPropagation,
    leaflet,
    map,
    tileLayer,
  };
}

describe("read-only map runtime", () => {
  it("creates the Japan-bounded map, attribution, tile selector, and initial layer", () => {
    const mock = createLeafletMock();
    const handleTileChange = vi.fn();
    const onTileControlAdded = vi.fn();
    const escapeHtml = (value: unknown) =>
      String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");

    const runtime = createReadOnlyMapRuntime({
      center: [35.68, 139.76],
      escapeHtml,
      handleTileChange,
      leaflet: mock.leaflet as never,
      onTileControlAdded,
      tileServers,
      zoom: 12,
    });

    expect(mock.leaflet.map).toHaveBeenCalledWith("map", {
      attributionControl: false,
      center: [35.68, 139.76],
      crs: "EPSG3857",
      preferCanvas: false,
      zoom: 12,
      zoomControl: true,
    });
    expect(mock.leaflet.latLng).toHaveBeenNthCalledWith(1, 20.25, 122.56);
    expect(mock.leaflet.latLng).toHaveBeenNthCalledWith(2, 45.55, 153.59);
    expect(mock.map.setMaxBounds).toHaveBeenCalledWith(mock.bounds);
    expect(mock.leaflet.control.attribution).toHaveBeenCalledWith({
      prefix: false,
    });
    expect(mock.attributionControl.addAttribution).toHaveBeenCalledWith(
      expect.stringContaining('target="_blank"'),
    );
    expect(mock.map.addControl).toHaveBeenCalledOnce();
    expect(onTileControlAdded).toHaveBeenCalledOnce();
    expect(mock.disableClickPropagation).toHaveBeenCalledOnce();

    const controlElement = mock.disableClickPropagation.mock.calls[0]![0] as HTMLElement;
    const radios = controlElement.querySelectorAll<HTMLInputElement>(
      ".tile-radio",
    );
    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    expect(controlElement.innerHTML).toContain("Default &lt;map&gt;");
    radios[1]?.dispatchEvent(new Event("change"));
    expect(handleTileChange).toHaveBeenCalledOnce();

    expect(mock.leaflet.tileLayer).toHaveBeenCalledWith(
      tileServers["1"]!.url,
      {
        attribution: "Default attribution",
        maxZoom: 18,
        minZoom: 5,
      },
    );
    expect(mock.tileLayer.addTo).toHaveBeenCalledWith(mock.map);
    expect(runtime).toMatchObject({
      bounds: mock.bounds,
      map: mock.map,
      tileLayer: mock.tileLayer,
    });
  });

  it("does not constrain maps whose default tile server includes foreign tiles", () => {
    const mock = createLeafletMock();
    const globalTileServers = {
      "1": { ...tileServers["1"]!, include_foreign_tiles: true },
    };

    createReadOnlyMapRuntime({
      center: [0, 0],
      escapeHtml: String,
      handleTileChange: vi.fn(),
      leaflet: mock.leaflet as never,
      tileServers: globalTileServers,
      zoom: 3,
    });

    expect(mock.map.setMaxBounds).not.toHaveBeenCalled();
  });
});
