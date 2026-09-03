import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMapStorage,
  createTileChangeHandler,
} from "../src/map/common/storage";
import type { TileServerRecord } from "../src/map/types";

const tileServers: Record<string, TileServerRecord> = {
  "1": {
    attribution: "Default",
    id: 1,
    include_foreign_tiles: false,
    label: "Default",
    layer_name: "default",
    max_zoom: null,
    min_zoom: null,
    url: "https://tiles.example.test/1/{z}/{x}/{y}.png",
  },
  "2": {
    attribution: "Global",
    id: 2,
    include_foreign_tiles: true,
    label: "Global",
    layer_name: "global",
    max_zoom: 20,
    min_zoom: 2,
    url: "https://tiles.example.test/2/{z}/{x}/{y}.png",
  },
};

describe("map common storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses tile server 1 by default and restores a valid saved selection", () => {
    const storage = createMapStorage(tileServers);
    localStorage.setItem("geocode-web:selected-tile-server-id", "2");

    expect(storage.getInitialTileServerId()).toBe("1");
    storage.enableTileServerSelectionPersistence();
    expect(storage.getInitialTileServerId()).toBe("2");

    storage.saveSelectedTileServerId("1");
    expect(localStorage.getItem("geocode-web:selected-tile-server-id")).toBe("1");
  });

  it("falls back to the first available tile server", () => {
    const storage = createMapStorage({ "7": tileServers["2"]! });
    expect(storage.getDefaultTileServerId()).toBe("7");
  });

  it("reads and writes map visibility settings", () => {
    const storage = createMapStorage(tileServers);
    expect(storage.getInitialMarkerVisibility()).toBe(true);
    expect(storage.getInitialMapMobileUiHidden()).toBe(false);

    storage.saveMarkerVisibility(false);
    storage.saveShapeLayerVisibility(false);
    storage.saveShapeNameVisibility(false);
    storage.saveUserLocationVisibility(false);
    storage.saveMapMobileUiHidden(true);

    expect(storage.getInitialMarkerVisibility()).toBe(false);
    expect(storage.getInitialShapeLayerVisibility()).toBe(false);
    expect(storage.getInitialShapeNameVisibility()).toBe(false);
    expect(storage.getInitialUserLocationVisibility()).toBe(false);
    expect(storage.getInitialMapMobileUiHidden()).toBe(true);
  });

  it("keeps defaults when browser storage is unavailable", () => {
    const warning = vi.fn();
    const storage = createMapStorage(tileServers, {
      getStorage: () => {
        throw new Error("blocked");
      },
      warn: warning,
    });

    expect(storage.getInitialMarkerVisibility()).toBe(true);
    storage.saveMarkerVisibility(false);
    expect(warning).toHaveBeenCalledTimes(2);
  });
});

describe("tile change handler", () => {
  it("replaces the tile layer and removes bounds for global tiles", () => {
    const bounds = {};
    let currentLayer = "old-layer";
    const removeLayer = vi.fn();
    const setMaxBounds = vi.fn();
    const saveSelection = vi.fn();
    const createTileLayer = vi.fn(() => "new-layer");
    const handler = createTileChangeHandler({
      tileServers,
      getMap: () => ({ removeLayer, setMaxBounds }),
      getTileLayer: () => currentLayer,
      setTileLayer: (layer) => {
        currentLayer = layer;
      },
      getBounds: () => bounds,
      createTileLayer,
      saveSelectedTileServerId: saveSelection,
    });
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: { value: "2" } });

    handler(event);

    expect(removeLayer).toHaveBeenCalledWith("old-layer");
    expect(setMaxBounds).toHaveBeenCalledWith(null);
    expect(createTileLayer).toHaveBeenCalledWith(tileServers["2"]);
    expect(currentLayer).toBe("new-layer");
    expect(saveSelection).toHaveBeenCalledWith("2");
  });

  it("ignores a tile server that is not in the bootstrap data", () => {
    const removeLayer = vi.fn();
    const handler = createTileChangeHandler({
      tileServers,
      getMap: () => ({ removeLayer, setMaxBounds: vi.fn() }),
      getTileLayer: () => "old-layer",
      setTileLayer: vi.fn(),
      getBounds: () => ({}),
      createTileLayer: () => "new-layer",
      saveSelectedTileServerId: vi.fn(),
    });
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: { value: "missing" } });

    handler(event);
    expect(removeLayer).not.toHaveBeenCalled();
  });
});
