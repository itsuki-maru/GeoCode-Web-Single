import { afterEach, describe, expect, it, vi } from "vitest";
import { installMarkerClustering } from "../src/map/common/marker-clustering";

function fixture(zoom = 9, allowed = true, initialEnabled = true, minZoom: number | null = 10) {
  vi.useFakeTimers();
  const handlers = new Map<string, () => void>();
  const groupHandlers = new Map<string, () => void>();
  const container = document.createElement("div");
  container.innerHTML =
    '<section class="leaflet-control-layers-list"><div class="leaflet-control-layers-overlays"></div></section>';
  document.body.append(container);
  const markers = [{ id: "selected-marker" }];
  const group = {
    options: { disableClusteringAtZoom: null as number | null },
    getLayers: vi.fn(() => markers),
    clearLayers: vi.fn(),
    addLayers: vi.fn(),
    on: (event: string, handler: () => void) => groupHandlers.set(event, handler),
    off: (event: string) => groupHandlers.delete(event),
  };
  const runtime = installMarkerClustering({
    leaflet: { DomEvent: { disableClickPropagation: vi.fn() } },
    map: {
      getZoom: () => zoom,
      on: (event, handler) => handlers.set(event, handler),
      off: (event) => handlers.delete(event),
    },
    markerGroup: group,
    control: { getContainer: () => container },
    allowed,
    initialEnabled,
    minZoom: minZoom ?? undefined,
  });
  const input = container.querySelector<HTMLInputElement>("input")!;
  const zoomTo = (nextZoom: number) => {
    handlers.get("zoomstart")?.();
    zoom = nextZoom;
    handlers.get("zoomend")?.();
  };
  return { container, runtime, input, group, markers, zoomTo, handlers, groupHandlers };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("marker clustering control", () => {
  it.each([
    [15, null],
    [10, 10],
  ] as const)("unlocks at zoom %i", (zoom, configured) => {
    const f = fixture(zoom - 1, true, true, configured);
    expect(f.input.checked).toBe(true);
    expect(f.input.disabled).toBe(true);
    expect(f.input.closest("label")?.title).toBe(`ズーム${zoom}以上で解除できます`);
    f.zoomTo(zoom);
    vi.advanceTimersByTime(350);
    expect(f.input.checked).toBe(true);
    expect(f.input.disabled).toBe(false);
    f.input.click();
    expect(f.runtime.getEnabled()).toBe(false);
    expect(f.group.options.disableClusteringAtZoom).toBe(zoom);
    expect(f.group.addLayers).toHaveBeenLastCalledWith(f.markers);
  });

  it("resets on shrinking and waits for animation cleanup before rebuilding", () => {
    const f = fixture(10);
    f.input.click();
    f.zoomTo(9);
    expect(f.input.checked).toBe(true);
    expect(f.input.disabled).toBe(true);
    expect(f.group.options.disableClusteringAtZoom).toBe(10);
    f.groupHandlers.get("animationend")?.();
    vi.advanceTimersByTime(0);
    expect(f.group.options.disableClusteringAtZoom).toBeNull();
    f.zoomTo(10);
    vi.advanceTimersByTime(350);
    expect(f.runtime.getEnabled()).toBe(true);
  });

  it("keeps an explicit fixed-off setting disabled at every zoom", () => {
    const f = fixture(9, false);
    f.runtime.setEnabled(true);
    f.zoomTo(10);
    vi.advanceTimersByTime(350);
    f.zoomTo(9);
    vi.advanceTimersByTime(350);
    expect(f.runtime.isAllowed()).toBe(false);
    expect(f.input.checked).toBe(false);
    expect(f.input.disabled).toBe(true);
    expect(f.group.clearLayers).not.toHaveBeenCalled();
  });

  it("normalizes a manual release below 10 but restores it at 10", () => {
    const low = fixture(9, true, false);
    expect(low.runtime.getEnabled()).toBe(true);
    const high = fixture(10, true, false);
    expect(high.runtime.getEnabled()).toBe(false);
    expect(high.group.options.disableClusteringAtZoom).toBe(10);
  });

  it("survives overlay list replacement and cancels pending work on unload", () => {
    const f = fixture(10);
    f.container.querySelector(".leaflet-control-layers-overlays")!.replaceChildren();
    expect(f.input.isConnected).toBe(true);
    f.input.click();
    f.zoomTo(9);
    f.handlers.get("unload")?.();
    vi.advanceTimersByTime(350);
    expect(f.group.clearLayers).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector(".marker-clustering-control")).toBeNull();
    expect(f.handlers.size).toBe(0);
    expect(f.groupHandlers.size).toBe(0);
  });
});
