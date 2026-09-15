import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTileOverlayManager,
  type TileOverlayRecord,
} from "../../../template-scripts/src/map/common/tile-overlays";
import { NOWCAST_URL } from "../../../template-scripts/src/map/common/nowcast-time";
import { createMapUiVisibilityRuntime } from "../../../template-scripts/src/map/common/map-ui-visibility";

let L: any;
let map: any;
let fetcher: ReturnType<typeof vi.fn>;
const tile: TileOverlayRecord = {
  id: "rain",
  name: "雨雲 <test>",
  url: NOWCAST_URL,
  attribution: "気象庁",
  min_zoom: 4,
  max_zoom: 18,
  opacity: 0.6,
  sort_order: 2,
};
const response = (time = "20260915030000") => ({
  ok: true,
  json: async () => [{ basetime: time, validtime: time, elements: ["hrpns"] }],
});
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T03:01:00Z"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  window.eval(readFileSync("node_modules/leaflet/dist/leaflet-src.js", "utf8"));
  L = (window as any).L;
  L.Browser.any3d = true;
  const div = document.createElement("div");
  document.body.append(div);
  Object.defineProperties(div, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  map = L.map(div, { zoomAnimation: false, fadeAnimation: false }).setView([35.68, 139.76], 9);
  fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  map?.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(visible = true) {
  const control = L.control.layers().addTo(map);
  const manager = createTileOverlayManager(L, map, control, undefined, visible);
  expect(manager.sync([tile])).toBe(true);
  const layer = control._layers[0].layer;
  return { manager, layer, control };
}
describe("nowcast overlay with the shipped Leaflet", () => {
  it("follows shared mobile UI visibility including re-enabling while hidden", async () => {
    const ui = createMapUiVisibilityRuntime({ initialHidden: true, leaflet: L });
    const toggle = new ui.MapUiVisibilityToggleControl();
    map.addControl(toggle);
    const control = L.control.layers().addTo(map);
    const manager = createTileOverlayManager(L, map, control, undefined, true, {
      onControlAdded: ui.registerHideableMapControl,
    });
    manager.sync([tile]);
    await flush();
    const layer = control._layers[0].layer;
    const status = document.querySelector(".nowcast-status")!;
    expect(status.classList.contains("is-hidden")).toBe(true);
    expect(status.textContent).not.toContain("透明部分");
    const button = toggle.getContainer!()!.querySelector("button")!;
    button.click();
    expect(status.classList.contains("is-hidden")).toBe(false);
    button.click();
    map.removeLayer(layer);
    layer.addTo(map);
    expect(status.classList.contains("is-hidden")).toBe(true);
    button.click();
    expect(status.classList.contains("is-hidden")).toBe(false);
    expect(map.hasLayer(layer)).toBe(true);
  });
  it("keeps a separate status control below overlay choices across sync and visibility changes", async () => {
    const control = L.control.layers(null, null, { collapsed: false }).addTo(map);
    const anchor = control.getContainer();
    const host = anchor.parentElement;
    const manager = createTileOverlayManager(L, map, control, undefined, true, { afterControl: anchor });
    manager.sync([tile]);
    await flush();
    const layer = control._layers[0].layer;
    expect(anchor.nextElementSibling.classList.contains("nowcast-status")).toBe(true);
    expect(anchor.querySelector(".nowcast-status")).toBeNull();
    manager.sync([tile, { ...tile, id: "other", url: "https://example.com/{z}/{x}/{y}.png" }]);
    expect(host.querySelectorAll(".nowcast-status")).toHaveLength(1);
    expect(anchor.nextElementSibling.classList.contains("nowcast-status")).toBe(true);
    map.removeLayer(layer);
    expect(host.querySelector(".nowcast-status")).toBeNull();
    layer.addTo(map);
    await flush();
    expect(host.querySelectorAll(".nowcast-status")).toHaveLength(1);
    manager.sync([]);
    expect(host.querySelector(".nowcast-status")).toBeNull();
  });
  it("resolves the URL and updates the same layer without changing options or checks", async () => {
    const { layer, manager, control } = setup();
    expect(layer._url).toMatch(/^data:/);
    await flush();
    expect(layer._url).toContain("/20260915030000/none/20260915030000/");
    expect(document.querySelector(".nowcast-status strong")?.textContent).toBe(tile.name);
    expect(document.querySelector(".nowcast-status")?.textContent).toContain("12:00");
    const update = vi.spyOn(layer, "setUrl");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(response("20260915031000"));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(layer.options).toMatchObject({ opacity: 0.6, zIndex: 1, attribution: "気象庁" });
    manager.sync([tile]);
    expect(control._layers).toHaveLength(1);
    expect(map.hasLayer(layer)).toBe(true);
  });
  it("uses the even native tile grid at odd and high zooms, preserving geographic coordinates", async () => {
    const { layer } = setup();
    await flush();
    for (const [zoom, native] of [
      [4, 4],
      [5, 4],
      [7, 6],
      [9, 8],
      [10, 10],
      [11, 10],
      [18, 10],
    ]) {
      map.setZoom(zoom);
      expect(layer._tileZoom).toBe(native);
      const point = map.project(map.getCenter(), native).divideBy(256).floor();
      const key = `${point.x}:${point.y}:${native}`;
      const entry = layer._tiles[key];
      expect(entry).toBeDefined();
      expect(entry.el.src).toContain(`/${native}/${point.x}/${point.y}.png`);
      expect(layer._level.el.style.transform).toContain(`scale(${2 ** (zoom - native)})`);
    }
  });
  it("does not fetch unchecked overlays and stops on removal, configuration replacement and unload", async () => {
    const { layer, manager } = setup(false);
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    layer.addTo(map);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    map.removeLayer(layer);
    expect(document.querySelector(".nowcast-status")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    layer.addTo(map);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    manager.sync([{ ...tile, url: "https://example.com/{z}/{x}/{y}.png" }]);
    expect(document.querySelector(".nowcast-status")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    manager.sync([tile]);
    await flush();
    const count = fetcher.mock.calls.length;
    map.remove();
    map = null;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("shows initial failure, recovery, tile failures, and hides stale data", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    const { layer } = setup();
    await flush();
    expect(document.querySelector(".nowcast-status")?.textContent).toContain("取得できません");
    expect(layer._url).toMatch(/^data:/);
    fetcher.mockResolvedValue(response());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(layer._url).toContain("/20260915030000/");
    layer.fire("tileerror", { coords: { x: 1, y: 1, z: 4 } });
    expect(document.querySelector(".nowcast-status")?.textContent).toContain("画像を取得できない");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(layer._url).toContain("/20260915030000/");
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(layer._url).toMatch(/^data:/);
    expect(document.querySelector(".nowcast-status")?.textContent).toContain(
      "15分以上前のため非表示",
    );
    expect(map.hasLayer(layer)).toBe(true);
  });
});
