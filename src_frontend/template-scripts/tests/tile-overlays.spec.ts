import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTileOverlayManager, type TileOverlayRecord } from "../src/map/common/tile-overlays";

const tile = (id: string): TileOverlayRecord => ({
  id,
  name: "<洪水>",
  url: "https://example.com/{z}/{x}/{y}.png?token=secret",
  attribution: "<出典>",
  min_zoom: 0,
  max_zoom: 18,
  opacity: 0.7,
  sort_order: 0,
});
function setup(accountId?: string) {
  const handlers = new Map<string, (event: { layer: unknown }) => void>();
  const visible = new Set();
  const pane = { style: {} };
  const map = {
    getPane: () => null,
    createPane: () => pane,
    hasLayer: (l: unknown) => visible.has(l),
    removeLayer: (l: unknown) => {
      visible.delete(l);
      handlers.get("overlayremove")?.({ layer: l });
    },
    on: (name: string, handler: (event: { layer: unknown }) => void) => handlers.set(name, handler),
  };
  const layers: any[] = [];
  const leaflet = {
    tileLayer: vi.fn((_url, options) => {
      const layer = {
        options,
        on: vi.fn(),
        off: vi.fn(),
        setZIndex: vi.fn(),
        addTo: vi.fn(() => {
          visible.add(layer);
          handlers.get("overlayadd")?.({ layer });
          return layer;
        }),
      };
      layers.push(layer);
      return layer;
    }),
  };
  const control = { addOverlay: vi.fn(), removeLayer: vi.fn() };
  return {
    manager: createTileOverlayManager(leaflet, map, control, accountId),
    handlers,
    leaflet,
    layers,
    map,
    control,
    visible,
    pane,
  };
}
beforeEach(() => localStorage.clear());

describe("tile overlays", () => {
  it("restores per-account checks and removes obsolete selections without overwriting hidden state", () => {
    const first = setup("account-a");
    first.manager.sync([tile("a"), tile("b")]);
    first.map.removeLayer(first.layers[0]);
    const restored = setup("account-a");
    restored.manager.sync([tile("a"), tile("b")]);
    expect(restored.visible.has(restored.layers[0])).toBe(false);
    expect(restored.visible.has(restored.layers[1])).toBe(true);
    const other = setup("account-b");
    other.manager.sync([tile("a")]);
    expect(other.visible.size).toBe(1);
    other.map.removeLayer(other.layers[0]);
    restored.manager.sync([{ ...tile("a"), name: "renamed" }, tile("b")]);
    expect(restored.visible.has(restored.layers[2])).toBe(false);
    restored.manager.sync([tile("b")]);
    expect(localStorage.getItem("geocode-web:tile-overlay-visibility:account-a")).toBeNull();
    expect(localStorage.getItem("geocode-web:tile-overlay-visibility:account-b")).toBe(
      '{"a":false}',
    );
    restored.manager.sync([tile("a"), tile("b")]);
    expect(restored.visible.has(restored.layers[3])).toBe(true);
    restored.map.removeLayer(restored.layers[3]);
    restored.manager.sync([]);
    expect(localStorage.getItem("geocode-web:tile-overlay-visibility:account-a")).toBeNull();
  });

  it("does not access storage for shared pages without an account scope", () => {
    localStorage.setItem("geocode-web:tile-overlay-visibility:account-a", '{"a":false}');
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const shared = setup();
    shared.manager.sync([tile("a")]);
    expect(shared.visible.size).toBe(1);
    shared.map.removeLayer(shared.layers[0]);
    shared.manager.sync([]);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("passes safe attribution links to Leaflet while escaping control labels", () => {
    const s = setup();
    s.manager.sync([
      { ...tile("a"), attribution: '<a href="https://example.com" onclick="alert(1)">出典</a>' },
    ]);
    expect(s.layers[0].options.attribution).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">出典</a>',
    );
    expect(s.control.addOverlay).toHaveBeenCalledWith(s.layers[0], "&lt;洪水&gt;");
  });
  it("adds escaped labels above the base map and preserves a hidden tile during another selection", () => {
    const s = setup();
    expect(s.manager.sync([tile("a")])).toBe(true);
    expect(s.control.addOverlay).toHaveBeenCalledWith(s.layers[0], "&lt;洪水&gt;");
    expect(s.layers[0].options.attribution).toBe("&lt;出典&gt;");
    expect(s.pane.style).toMatchObject({ zIndex: "250" });
    s.map.removeLayer(s.layers[0]);
    s.manager.sync([tile("a"), tile("b")]);
    expect(s.visible.has(s.layers[0])).toBe(false);
    expect(s.visible.has(s.layers[1])).toBe(true);
    expect(s.leaflet.tileLayer).toHaveBeenCalledTimes(2);
    s.manager.sync([tile("b")]);
    expect(s.control.removeLayer).toHaveBeenCalledWith(s.layers[0]);
    expect(s.layers[0].off).toHaveBeenCalled();
    s.manager.sync([]);
    expect(s.visible.size).toBe(0);
  });
  it("throttles failures without logging a provider token or breaking other layers", () => {
    const log = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup();
    s.manager.sync([tile("a")]);
    const fail = s.layers[0].on.mock.calls[0][1];
    fail({ coords: { x: 1, y: 2, z: 3 } });
    fail({ coords: { x: 2, y: 2, z: 3 } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    s.leaflet.tileLayer.mockImplementationOnce(() => {
      throw new Error("invalid URL");
    });
    expect(s.manager.sync([tile("a"), tile("b"), tile("c")])).toBe(false);
    expect(s.visible.size).toBe(2);
    expect(error).toHaveBeenCalledWith("重ね合わせタイルを表示できませんでした。", {
      id: "b",
      name: "<洪水>",
    });
    log.mockRestore();
    error.mockRestore();
  });
});
