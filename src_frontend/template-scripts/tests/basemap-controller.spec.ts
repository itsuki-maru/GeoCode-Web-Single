import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TileServerRecord } from "../src/map/common/basemap-definition";

const { factory } = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../src/map/common/basemap-layer", () => ({ createBasemapLayer: factory }));

import {
  createBasemapController,
  getBasemapController,
} from "../src/map/common/basemap-controller";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const records: Record<string, TileServerRecord> = Object.fromEntries(
  [1, 2, 3, 4].map((id) => [
    String(id),
    {
      id,
      url: `https://tiles.example.test/${id}/{z}/{x}/{y}.png`,
      attribution: `attribution-${id}`,
      label: `map-${id}`,
      layer_name: `map-${id}`,
      min_zoom: null,
      max_zoom: null,
      include_foreign_tiles: id !== 1,
      ...(id === 2 || id === 3
        ? { kind: "vector", style_url: `https://tiles.example.test/${id}/style.json` }
        : {}),
    } as TileServerRecord,
  ]),
);

function setup(
  initialId = "1",
  {
    tileServers = records,
    zoom = 10,
    center = { lat: 35, lng: 139 },
  }: {
    tileServers?: Record<string, TileServerRecord>;
    zoom?: number;
    center?: { lat: number; lng: number };
  } = {},
) {
  const visible = new Set<unknown>();
  const mapHandlers = new Map<string, Set<(...args: any[]) => void>>();
  const map = {
    getZoom: vi.fn(() => zoom),
    getCenter: vi.fn(() => center),
    on: vi.fn((name: string, callback: (...args: any[]) => void) => {
      const handlers = mapHandlers.get(name) ?? new Set();
      handlers.add(callback);
      mapHandlers.set(name, handlers);
    }),
    off: vi.fn((name: string, callback: (...args: any[]) => void) => {
      mapHandlers.get(name)?.delete(callback);
    }),
    fire: vi.fn((name: string, event?: unknown) => {
      for (const callback of [...(mapHandlers.get(name) ?? [])]) callback(event);
    }),
    setMaxBounds: vi.fn((constraint) => {
      if (constraint) map.getCenter.mockReturnValue({ lat: 35, lng: 139 });
    }),
    removeLayer: vi.fn((layer: unknown) => visible.delete(layer)),
  };
  const bounds = { japan: true };
  const save = vi.fn();
  const onCommit = vi.fn();
  const onError = vi.fn();
  const handles: ReturnType<typeof makeHandle>[] = [];
  function makeHandle(record: TileServerRecord, signal?: AbortSignal) {
    const handlers = new Map<string, Set<(event: any) => void>>();
    const loading = deferred();
    const layer = {
      on: vi.fn((name: string, callback: (event: any) => void) => {
        const callbacks = handlers.get(name) ?? new Set();
        callbacks.add(callback);
        handlers.set(name, callbacks);
        return layer;
      }),
      off: vi.fn((name: string, callback: (event: any) => void) => {
        handlers.get(name)?.delete(callback);
        return layer;
      }),
      fire: (name: string, event: unknown) => {
        for (const callback of [...(handlers.get(name) ?? [])]) callback(event);
      },
      addTo: vi.fn(() => {
        visible.add(layer);
        const currentZoom = map.getZoom();
        map.getZoom.mockReturnValue(
          Math.max(record.min_zoom ?? 5, Math.min(record.max_zoom ?? 18, currentZoom)),
        );
        return layer;
      }),
    };
    return {
      id: String(record.id),
      record,
      signal,
      layer,
      loading,
      ready: record.kind === "vector" ? loading.promise : undefined,
      setVisible: vi.fn(),
      dispose: vi.fn(),
    };
  }
  factory.mockImplementation(
    (
      _leaflet: unknown,
      _map: unknown,
      record: TileServerRecord,
      options?: { signal?: AbortSignal },
    ) => {
      const handle = makeHandle(record, options?.signal);
      handles.push(handle);
      return handle;
    },
  );
  const controller = createBasemapController({
    leaflet: {},
    map,
    tileServers,
    bounds,
    initialId,
    saveSelectedTileServerId: save,
    onCommit,
    onError,
  });
  return { controller, map, bounds, save, onCommit, onError, handles, visible };
}

beforeEach(() => {
  factory.mockReset();
});

describe("basemap controller", () => {
  it("commits the existing raster synchronously without changing the saved preference", () => {
    const page = setup();
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.controller.getLayer()).toBe(page.handles[0].layer);
    expect(page.controller.isPending()).toBe(false);
    expect(page.visible.has(page.handles[0].layer)).toBe(true);
    expect(page.map.setMaxBounds).toHaveBeenLastCalledWith(page.bounds);
    expect(page.save).not.toHaveBeenCalled();
    expect(getBasemapController(page.map)).toBe(page.controller);

    void page.controller.select("4");
    expect(page.controller.getSelectedId()).toBe("4");
    expect(page.controller.isPending()).toBe(false);
    expect(page.save).toHaveBeenLastCalledWith("4");
  });

  it("keeps raster 1 while the initial vector is loading, then commits without saving", async () => {
    const page = setup("2");
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.controller.isPending()).toBe(true);
    expect(page.handles[1].setVisible).toHaveBeenLastCalledWith(false);
    expect(page.handles[0].dispose).not.toHaveBeenCalled();
    page.handles[1].loading.resolve();
    await page.controller.whenReady();
    expect(page.controller.getSelectedId()).toBe("2");
    expect(page.handles[1].setVisible).toHaveBeenLastCalledWith(true);
    expect(page.handles[0].dispose).toHaveBeenCalledOnce();
    expect(page.save).not.toHaveBeenCalled();
  });

  it("saves an explicit raster selection that cancels the initial vector preference", async () => {
    const page = setup("2");
    expect(await page.controller.select("1")).toBe(true);
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.controller.isPending()).toBe(false);
    expect(page.handles[1].signal?.aborted).toBe(true);
    expect(page.save).toHaveBeenCalledExactlyOnceWith("1");
    page.handles[1].loading.resolve();
    await page.controller.whenReady();
    expect(page.controller.getSelectedId()).toBe("1");
  });

  it("preserves an initial vector's low zoom and overseas center without changing metadata", async () => {
    const tileServers = {
      ...records,
      "2": { ...records["2"], min_zoom: 0, max_zoom: 30 },
    };
    const before = JSON.stringify(tileServers);
    const center = { lat: 0, lng: -80 };
    const page = setup("2", { tileServers, zoom: 0, center });
    expect(page.handles[0].record).toMatchObject({ id: 1, min_zoom: 0, max_zoom: 30 });
    expect(page.handles[0].record.url).toBe(records["1"].url);
    expect(page.map.getZoom()).toBe(0);
    expect(page.map.getCenter()).toEqual(center);
    expect(page.map.setMaxBounds).toHaveBeenLastCalledWith(null);
    page.handles[1].loading.resolve();
    await page.controller.whenReady();
    expect(page.controller.getSelectedId()).toBe("2");
    expect(page.map.getZoom()).toBe(0);
    expect(page.map.getCenter()).toEqual(center);
    expect(JSON.stringify(tileServers)).toBe(before);
    expect(page.save).not.toHaveBeenCalled();
  });

  it("rebuilds the normal raster and restores its limits after an initial vector failure", async () => {
    const tileServers = {
      ...records,
      "2": { ...records["2"], min_zoom: 0, max_zoom: 30 },
    };
    const before = JSON.stringify(tileServers);
    const page = setup("2", { tileServers, zoom: 0, center: { lat: 0, lng: -80 } });
    expect(page.map.getZoom()).toBe(0);
    page.handles[1].loading.reject(new Error("style failed"));
    await page.controller.whenReady();
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.handles).toHaveLength(3);
    expect(page.handles[2].record).toBe(records["1"]);
    expect(page.controller.getLayer()).toBe(page.handles[2].layer);
    expect(page.handles[0].dispose).toHaveBeenCalledOnce();
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
    expect(page.map.setMaxBounds).toHaveBeenLastCalledWith(page.bounds);
    expect(page.map.getZoom()).toBe(5);
    expect(page.map.getCenter()).toEqual({ lat: 35, lng: 139 });
    expect(page.onCommit).toHaveBeenLastCalledWith("1", page.handles[2].layer);
    expect(JSON.stringify(tileServers)).toBe(before);
    expect(page.save).not.toHaveBeenCalled();
  });

  it("restores the normal raster when the initial vector load is cancelled", async () => {
    const page = setup("2");
    expect(await page.controller.select("1")).toBe(true);
    await page.controller.whenReady();
    expect(page.handles).toHaveLength(3);
    expect(page.handles[2].record).toBe(records["1"]);
    expect(page.controller.getLayer()).toBe(page.handles[2].layer);
    expect(page.handles[0].dispose).toHaveBeenCalledOnce();
    expect(page.handles[1].signal?.aborted).toBe(true);
    expect(page.map.setMaxBounds).toHaveBeenLastCalledWith(page.bounds);
    expect(page.save).toHaveBeenCalledExactlyOnceWith("1");
  });

  it("changes the selected ID, bounds and persistence only after vector rendering succeeds", async () => {
    const page = setup();
    const selection = page.controller.select("2");
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.map.setMaxBounds).toHaveBeenCalledTimes(1);
    expect(page.save).not.toHaveBeenCalled();
    expect(page.onCommit).toHaveBeenCalledTimes(1);
    page.handles[1].loading.resolve();
    expect(await selection).toBe(true);
    expect(page.controller.getSelectedId()).toBe("2");
    expect(page.map.setMaxBounds).toHaveBeenLastCalledWith(null);
    expect(page.save).toHaveBeenCalledExactlyOnceWith("2");
    expect(page.map.fire).toHaveBeenCalledWith("basemaploadingchange", { pending: true });
    expect(page.map.fire).toHaveBeenCalledWith("basemaploadingchange", { pending: false });
    expect(page.visible.has(page.handles[0].layer)).toBe(false);
  });

  it("retains the committed raster and restores the selection callback after failure", async () => {
    const page = setup();
    const selection = page.controller.select("2");
    const error = new Error("style failed");
    page.handles[1].loading.reject(error);
    expect(await selection).toBe(false);
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.controller.isPending()).toBe(false);
    expect(page.handles[0].dispose).not.toHaveBeenCalled();
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
    expect(page.onCommit).toHaveBeenLastCalledWith("1", page.handles[0].layer);
    expect(page.onError).toHaveBeenCalledExactlyOnceWith(error, "2");
    expect(page.save).not.toHaveBeenCalled();
  });

  it("aborts superseded candidates and whenReady follows the latest selection", async () => {
    const page = setup();
    const first = page.controller.select("2");
    const waiting = page.controller.whenReady();
    let completed = false;
    void waiting.then(() => (completed = true));
    const second = page.controller.select("3");
    expect(page.handles[1].signal?.aborted).toBe(true);
    expect(await first).toBe(false);
    page.handles[1].loading.resolve();
    await Promise.resolve();
    expect(page.controller.getSelectedId()).toBe("1");
    expect(completed).toBe(false);
    page.handles[2].loading.resolve();
    expect(await second).toBe(true);
    await waiting;
    expect(completed).toBe(true);
    expect(page.controller.getSelectedId()).toBe("3");
    expect(page.save).toHaveBeenCalledExactlyOnceWith("3");
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
  });

  it("cancels a pending candidate when the committed background is selected again", async () => {
    const page = setup();
    const pending = page.controller.select("2");
    expect(await page.controller.select("1")).toBe(true);
    expect(await pending).toBe(false);
    expect(page.controller.isPending()).toBe(false);
    page.handles[1].loading.resolve();
    await page.controller.whenReady();
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.save).toHaveBeenCalledExactlyOnceWith("1");
  });

  it("handles layer error events while loading even if ready never settles", async () => {
    const page = setup();
    const pending = page.controller.select("2");
    const error = new Error("worker failed");
    page.handles[1].layer.fire("basemaperror", { error });
    expect(await pending).toBe(false);
    expect(page.onError).toHaveBeenLastCalledWith(error, "2");
    expect(page.controller.getSelectedId()).toBe("1");
  });

  it("falls back after an active vector error without overwriting the saved vector preference", async () => {
    const page = setup();
    const selected = page.controller.select("2");
    page.handles[1].loading.resolve();
    await selected;
    const error = new Error("context lost");
    page.handles[1].layer.fire("basemaperror", { error });
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.save).toHaveBeenCalledExactlyOnceWith("2");
    expect(page.onError).toHaveBeenLastCalledWith(error, "2");
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
    expect(page.onCommit).toHaveBeenLastCalledWith("1", page.handles[2].layer);
  });

  it("lets the latest candidate succeed when the previous active vector fails", async () => {
    const page = setup();
    const first = page.controller.select("2");
    page.handles[1].loading.resolve();
    await first;
    const latest = page.controller.select("3");
    const waiting = page.controller.whenReady();
    page.handles[1].layer.fire("basemaperror", { error: new Error("old source failed") });
    expect(page.controller.isPending()).toBe(true);
    expect(page.handles[2].signal?.aborted).toBe(false);
    expect(page.handles).toHaveLength(3);
    page.handles[2].loading.resolve();
    expect(await latest).toBe(true);
    await waiting;
    expect(page.controller.getSelectedId()).toBe("3");
    expect(page.save.mock.calls).toEqual([["2"], ["3"]]);
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
  });

  it.each(["failed", "out-of-range"])(
    "falls back without saving when the latest candidate fails and the old vector is %s",
    async (oldState) => {
      const page = setup();
      const first = page.controller.select("2");
      page.handles[1].loading.resolve();
      await first;
      const latest = page.controller.select("3");
      if (oldState === "failed")
        page.handles[1].layer.fire("basemaperror", { error: new Error("old source failed") });
      else {
        page.map.getZoom.mockReturnValue(19);
        page.map.fire("zoomend");
      }
      expect(page.handles[2].signal?.aborted).toBe(false);
      page.handles[2].loading.reject(new Error("new source failed"));
      expect(await latest).toBe(false);
      await page.controller.whenReady();
      expect(page.controller.getSelectedId()).toBe("1");
      expect(page.controller.isPending()).toBe(false);
      expect(page.save).toHaveBeenCalledExactlyOnceWith("2");
      expect(page.handles[1].dispose).toHaveBeenCalledOnce();
      expect(page.handles[2].dispose).toHaveBeenCalledOnce();
      expect(page.onCommit).toHaveBeenLastCalledWith("1", page.handles[3].layer);
    },
  );

  it("keeps loading a wider-range candidate when the old vector leaves its zoom range", async () => {
    const page = setup("1", {
      tileServers: {
        ...records,
        "2": { ...records["2"], max_zoom: 12 },
        "3": { ...records["3"], min_zoom: 0, max_zoom: 22 },
      },
    });
    const first = page.controller.select("2");
    page.handles[1].loading.resolve();
    await first;
    const latest = page.controller.select("3");
    page.map.getZoom.mockReturnValue(20);
    page.map.fire("zoomend");
    expect(page.handles[2].signal?.aborted).toBe(false);
    expect(page.controller.isPending()).toBe(true);
    page.handles[2].loading.resolve();
    expect(await latest).toBe(true);
    expect(page.controller.getSelectedId()).toBe("3");
    expect(page.map.getZoom()).toBe(20);
    expect(page.handles).toHaveLength(3);
  });

  it("retries rather than reusing a failed active vector when it is selected to cancel a newer candidate", async () => {
    const page = setup();
    const first = page.controller.select("2");
    page.handles[1].loading.resolve();
    await first;
    const superseded = page.controller.select("3");
    page.handles[1].layer.fire("basemaperror", { error: new Error("old source failed") });
    const retried = page.controller.select("2");
    expect(await superseded).toBe(false);
    expect(page.handles[2].signal?.aborted).toBe(true);
    expect(page.handles[3].id).toBe("2");
    page.handles[3].loading.resolve();
    expect(await retried).toBe(true);
    expect(page.controller.getLayer()).toBe(page.handles[3].layer);
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
  });

  it("rejects a vector outside its zoom range without changing the existing view or background", async () => {
    const page = setup();
    page.map.getZoom.mockReturnValue(4);
    expect(await page.controller.select("2")).toBe(false);
    expect(page.handles).toHaveLength(1);
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.handles[0].dispose).not.toHaveBeenCalled();
    expect(page.save).not.toHaveBeenCalled();
    expect(page.onError).toHaveBeenLastCalledWith(expect.any(Error), "2");
  });

  it("rechecks the view before committing a vector that finished loading", async () => {
    const page = setup();
    const selected = page.controller.select("2");
    page.map.getZoom.mockReturnValue(19);
    page.handles[1].loading.resolve();
    expect(await selected).toBe(false);
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.handles[1].dispose).toHaveBeenCalledOnce();
    expect(page.save).not.toHaveBeenCalled();
  });

  it("falls back without saving when an active vector moves outside its zoom range", async () => {
    const page = setup();
    const selected = page.controller.select("2");
    page.handles[1].loading.resolve();
    await selected;
    page.map.getZoom.mockReturnValue(19);
    page.map.fire("zoomend");
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.save).toHaveBeenCalledExactlyOnceWith("2");
    expect(page.onError).toHaveBeenLastCalledWith(expect.any(Error), "2");
  });

  it("preserves the background if construction throws and ignores unknown IDs", async () => {
    const page = setup();
    factory.mockImplementationOnce(() => {
      throw new Error("unsupported WebGL");
    });
    expect(await page.controller.select("2")).toBe(false);
    expect(await page.controller.select("unknown")).toBe(false);
    expect(page.controller.getSelectedId()).toBe("1");
    expect(page.controller.isPending()).toBe(false);
    expect(page.handles[0].dispose).not.toHaveBeenCalled();
  });

  it("does not let an unknown ID interrupt readiness for the pending selection", async () => {
    const page = setup();
    const selected = page.controller.select("2");
    expect(await page.controller.select("unknown")).toBe(false);
    let completed = false;
    const waiting = page.controller.whenReady().then(() => (completed = true));
    await Promise.resolve();
    expect(completed).toBe(false);
    page.handles[1].loading.resolve();
    await selected;
    await waiting;
    expect(page.controller.getSelectedId()).toBe("2");
  });

  it("disposes active and pending layers on unload and ignores late completion", async () => {
    const page = setup();
    const selected = page.controller.select("2");
    const committedBeforeUnload = page.onCommit.mock.calls.length;
    page.map.fire("unload");
    expect(await selected).toBe(false);
    await page.controller.whenReady();
    page.handles[1].loading.resolve();
    await Promise.resolve();
    expect(page.controller.isPending()).toBe(false);
    expect(page.visible.size).toBe(0);
    expect(page.handles.every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true);
    expect(page.onCommit).toHaveBeenCalledTimes(committedBeforeUnload);
    expect(getBasemapController(page.map)).toBeUndefined();
    expect(await page.controller.select("4")).toBe(false);
    page.controller.dispose();
    expect(page.handles.every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true);
  });
});
