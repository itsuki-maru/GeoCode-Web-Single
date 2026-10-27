import { describe, expect, it, vi } from "vitest";
import {
  createShapeRenderManager,
  getShapeGeometryInfo,
  type ShapeBounds,
  type ShapeRenderRecord,
} from "../src/map/common/shape-renderer";

interface Record extends ShapeRenderRecord {
  id: string;
  shown?: boolean;
  geojson: any;
}
interface Layer {
  id: string;
  revision: number;
}
const line = (id: string, longitude = 139.74, size = 0.01): Record => ({
  id,
  shape_type: "polyline",
  geojson: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [longitude, 35.68],
        [longitude + size, 35.68],
      ],
    },
  },
});

function fixture(
  options: {
    maxCachedLayers?: number;
    maxCachedVertices?: number;
    maxBatchSize?: number;
    maxBatchVertices?: number;
    batchBudgetMs?: number;
    minPixelSize?: number;
    now?: () => number;
    create?: (record: Record) => Layer | null;
  } = {},
) {
  let bounds: ShapeBounds = { south: 35.6, west: 139.7, north: 35.75, east: 139.8 };
  let zoom = 14;
  let frameSequence = 0;
  let layerSequence = 0;
  const listeners = new Map<string, Set<() => void>>();
  const frames = new Map<number, () => void>();
  const history: Array<() => void> = [];
  const pinned = new Set<string>();
  const attached = new Set<Layer>();
  const create = vi.fn(
    options.create ?? ((record: Record) => ({ id: record.id, revision: ++layerSequence })),
  );
  const add = vi.fn((layer: Layer) => attached.add(layer));
  const remove = vi.fn((layer: Layer) => attached.delete(layer));
  const dispose = vi.fn();
  const created = vi.fn();
  const evicted = vi.fn();
  const refreshed = vi.fn();
  const visible = vi.fn((record: Record) => record.shown !== false);
  const map = {
    getBounds: () => ({
      getSouth: () => bounds.south,
      getWest: () => bounds.west,
      getNorth: () => bounds.north,
      getEast: () => bounds.east,
    }),
    getZoom: () => zoom,
    on: vi.fn((events: string, callback: () => void) => {
      for (const event of events.split(" ")) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      }
    }),
    off: vi.fn((events: string, callback: () => void) => {
      for (const event of events.split(" ")) listeners.get(event)?.delete(callback);
    }),
  };
  const manager = createShapeRenderManager<Record, Layer>({
    // Keep count-based assertions independent of CI speed; time-budget tests override this clock.
    now: () => 0,
    ...options,
    map,
    createLayer: create,
    addLayer: add,
    removeLayer: remove,
    disposeLayer: dispose,
    isRecordVisible: visible,
    isPinned: (id) => pinned.has(id),
    onLayerCreated: created,
    onLayerEvicted: evicted,
    onRefresh: refreshed,
    scheduleFrame: (callback) => {
      const id = ++frameSequence;
      frames.set(id, callback);
      history.push(callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  const flush = () => {
    let limit = 1000;
    while (frames.size) {
      if (--limit < 0) throw Error("frame loop");
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback();
    }
  };
  return {
    manager,
    map,
    create,
    add,
    remove,
    dispose,
    created,
    evicted,
    refreshed,
    visible,
    attached,
    frames,
    history,
    pinned,
    flush,
    emit: (event: string) => [...(listeners.get(event) ?? [])].forEach((callback) => callback()),
    setBounds: (value: ShapeBounds) => {
      bounds = value;
    },
    setZoom: (value: number) => {
      zoom = value;
    },
  };
}

describe("shape geometry metadata", () => {
  it("calculates line and polygon extents without changing the source coordinates", () => {
    const shape = line("line");
    const original = JSON.stringify(shape);
    expect(getShapeGeometryInfo(shape)).toEqual({
      bounds: { south: 35.68, west: 139.74, north: 35.68, east: 139.75 },
      vertexCount: 2,
    });
    expect(JSON.stringify(shape)).toBe(original);
    expect(
      getShapeGeometryInfo({
        shape_type: "polygon",
        geojson: {
          type: "Polygon",
          coordinates: [
            [
              [139, 35],
              [140, 35],
              [140, 36],
              [139, 35],
            ],
          ],
        },
      }),
    ).toEqual({ bounds: { south: 35, west: 139, north: 36, east: 140 }, vertexCount: 4 });
  });

  it("includes a circle radius and safely covers date-line and polar circles", () => {
    const circle = (longitude: number, latitude: number, radius: number) => ({
      shape_type: "circle",
      geojson: {
        type: "Feature",
        properties: { radius },
        geometry: { type: "Point", coordinates: [longitude, latitude] },
      },
    });
    const info = getShapeGeometryInfo(circle(139.69, 35.68, 2000))!;
    expect(info.bounds.east).toBeGreaterThan(139.7);
    expect(info.bounds.west).toBeLessThan(139.69);
    expect(info.bounds.south).toBeLessThan(35.68);
    expect(info.vertexCount).toBe(1);
    expect(getShapeGeometryInfo(circle(179.99, 0, 10000))!.bounds).toMatchObject({
      west: -180,
      east: 180,
    });
    expect(getShapeGeometryInfo(circle(0, 89.99, 10000))!.bounds).toMatchObject({
      north: 90,
      west: -180,
      east: 180,
    });
  });

  it.each([
    { shape_type: "polyline", geojson: { type: "LineString", coordinates: [[139, 35]] } },
    {
      shape_type: "polyline",
      geojson: {
        type: "LineString",
        coordinates: [
          [139, 35],
          [NaN, 36],
        ],
      },
    },
    { shape_type: "polygon", geojson: { type: "Polygon", coordinates: [[[139, 35]]] } },
    {
      shape_type: "circle",
      geojson: {
        type: "Feature",
        properties: { radius: 0 },
        geometry: { type: "Point", coordinates: [139, 35] },
      },
    },
    { shape_type: "circle", geojson: { type: "Point", coordinates: [181, 35] } },
    {
      shape_type: "unknown",
      geojson: {
        type: "LineString",
        coordinates: [
          [139, 35],
          [140, 35],
        ],
      },
    },
  ])("rejects unusable geometry: %j", (shape) => expect(getShapeGeometryInfo(shape)).toBeNull());
});

describe("lazy shape rendering", () => {
  it("registers all searchable records but creates only visible, sufficiently large shapes", () => {
    const f = fixture();
    f.manager.replaceRecords([
      ...Array.from({ length: 2000 }, (_, i) => line(`outside-${i}`, 135)),
      line("inside"),
    ]);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.manager.isVisible("outside-0")).toBe(true);
    f.manager.refresh();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.manager.getStats()).toMatchObject({
      recordCount: 2001,
      renderableCount: 2001,
      eligibleCount: 2001,
      renderedCount: 1,
      cachedCount: 1,
    });
    f.setZoom(5);
    f.manager.refresh();
    expect(f.attached.size).toBe(0);
    expect(f.manager.isVisible("inside")).toBe(true);
    expect(f.manager.getStats().eligibleCount).toBe(2001);
  });

  it("keeps thin crossing lines, circles whose centers are outside, and the viewport buffer", () => {
    const f = fixture();
    const circle: Record = {
      id: "circle",
      shape_type: "circle",
      geojson: {
        type: "Feature",
        properties: { radius: 2000 },
        geometry: { type: "Point", coordinates: [139.69, 35.68] },
      },
    };
    f.manager.replaceRecords([line("crossing", 139.5, 0.5), line("buffer", 139.805), circle]);
    f.manager.refresh();
    expect([...f.attached].map((layer) => layer.id)).toEqual(["crossing", "circle", "buffer"]);
  });

  it("generates pinned and on-screen shapes before earlier buffer records without changing candidates", () => {
    const f = fixture({ now: () => 0 });
    f.pinned.add("pinned-a");
    f.pinned.add("pinned-b");
    f.pinned.add("hidden-pin");
    f.manager.replaceRecords([
      line("buffer-a", 139.805, 0.005),
      line("pinned-a", 135),
      line("visible-a"),
      line("pinned-b", 136),
      line("visible-b", 139.76),
      line("buffer-b", 139.68, 0.005),
      { ...line("hidden-pin", 134), shown: false },
      line("outside", 133),
      line("tiny", 139.74, 0.000001),
    ]);
    f.manager.refresh();
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual([
      "pinned-a",
      "pinned-b",
      "visible-a",
      "visible-b",
      "buffer-a",
      "buffer-b",
    ]);
    expect(f.manager.getStats().renderedCount).toBe(6);
    expect(f.manager.getLayer("hidden-pin")).toBeNull();
    expect(f.manager.getLayer("outside")).toBeNull();
    expect(f.manager.getLayer("tiny")).toBeNull();
  });

  it("removes stale shapes before generating the next view and its buffer", () => {
    const f = fixture({ maxBatchSize: 1, now: () => 0 });
    f.manager.replaceRecords([
      line("old"),
      line("new-buffer", 135.115, 0.005),
      line("new-visible", 135),
    ]);
    f.manager.refresh();
    expect([...f.attached].map((layer) => layer.id)).toEqual(["old"]);
    f.setBounds({ south: 35.6, west: 134.9, north: 35.75, east: 135.1 });
    f.manager.refresh();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.attached.size).toBe(0);
    expect(f.create).toHaveBeenCalledOnce();
    f.flush();
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual([
      "old",
      "new-visible",
      "new-buffer",
    ]);
    expect([...f.attached].map((layer) => layer.id)).toEqual(["new-visible", "new-buffer"]);
  });

  it("waits for pending buffer work even when all viewport shapes have been attached", async () => {
    const f = fixture({ maxBatchSize: 1, now: () => 0 });
    f.manager.replaceRecords([
      line("buffer-a", 139.805, 0.005),
      line("buffer-b", 139.68, 0.005),
      line("visible"),
    ]);
    f.manager.refresh();
    expect([...f.attached].map((layer) => layer.id)).toEqual(["visible"]);
    expect(f.manager.getStats().pendingCount).toBe(2);
    const resolved = vi.fn();
    void f.manager.whenIdle().then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    const [id, callback] = f.frames.entries().next().value!;
    f.frames.delete(id);
    callback();
    await Promise.resolve();
    expect(f.manager.getStats().pendingCount).toBe(1);
    expect(resolved).not.toHaveBeenCalled();
    f.flush();
    await f.manager.whenIdle();
    expect(resolved).toHaveBeenCalledOnce();
    expect(f.manager.getStats().pendingCount).toBe(0);
  });

  it("keeps world-wrapped viewport candidates", () => {
    const f = fixture();
    f.setBounds({ south: 35, west: 180, north: 36, east: 190 });
    f.manager.replaceRecords([line("wrapped-buffer", -169, 0.1), line("wrapped", -175, 0.1)]);
    f.manager.refresh();
    expect(f.manager.getStats().renderedCount).toBe(2);
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual(["wrapped", "wrapped-buffer"]);
  });

  it("updates only changed attachments and reuses cached objects when panning back", () => {
    const f = fixture();
    f.manager.replaceRecords([line("a"), line("b", 135)]);
    f.manager.refresh();
    const a = f.manager.getLayer("a");
    f.manager.refresh();
    expect(f.add).toHaveBeenCalledOnce();
    f.setBounds({ south: 35.6, west: 134.9, north: 35.75, east: 135.1 });
    f.manager.refresh();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledTimes(2);
    f.setBounds({ south: 35.6, west: 139.7, north: 35.75, east: 139.8 });
    f.manager.refresh();
    expect(f.manager.getLayer("a")).toBe(a);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect([...f.attached].map((layer) => layer.id)).toEqual(["a"]);
  });

  it("respects logical filters while pinning selected geometry across view changes", () => {
    const f = fixture({ maxCachedLayers: 0 });
    const a = line("a");
    f.manager.replaceRecords([a, { ...line("hidden"), shown: false }]);
    f.pinned.add("a");
    f.setZoom(5);
    f.manager.refresh();
    expect(f.manager.getStats()).toMatchObject({ eligibleCount: 1, renderedCount: 1 });
    a.shown = false;
    f.manager.refresh();
    expect(f.manager.getStats()).toMatchObject({
      eligibleCount: 0,
      renderedCount: 0,
      cachedCount: 1,
      inactiveCachedCount: 0,
    });
    f.pinned.clear();
    f.manager.refresh();
    expect(f.manager.getStats().cachedCount).toBe(0);
  });

  it("bounds inactive cache by layer count and vertex count without evicting visible objects", () => {
    const f = fixture({ maxCachedLayers: 1, maxCachedVertices: 2 });
    f.manager.replaceRecords([line("a"), line("b"), line("c")]);
    f.manager.refresh();
    expect(f.manager.getStats().cachedCount).toBe(3);
    f.setBounds({ south: 0, west: 0, north: 1, east: 1 });
    f.manager.refresh();
    expect(f.manager.getStats()).toMatchObject({
      renderedCount: 0,
      cachedCount: 1,
      inactiveCachedCount: 1,
      inactiveCachedVertices: 2,
      disposedCount: 2,
    });
    expect(f.manager.getLayer("c")).not.toBeNull();
    expect(f.evicted).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });

  it("splits creation and drops stale work when the view changes", async () => {
    const f = fixture({ maxBatchSize: 2 });
    f.manager.replaceRecords([
      ...Array.from({ length: 5 }, (_, i) => line(`old-${i}`)),
      line("new", 135),
    ]);
    f.manager.refresh();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.manager.getStats().pendingCount).toBe(3);
    const stale = f.history[0];
    f.setBounds({ south: 35.6, west: 134.9, north: 35.75, east: 135.1 });
    f.emit("moveend");
    stale();
    f.flush();
    await f.manager.whenIdle();
    expect([...f.attached].map((layer) => layer.id)).toEqual(["new"]);
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual(["old-0", "old-1", "new"]);
    expect(f.manager.getStats().pendingCount).toBe(0);
  });

  it("observes the time budget independently of the batch size", () => {
    let time = 0;
    const f = fixture({
      now: () => time,
      batchBudgetMs: 8,
      maxBatchSize: 100,
      create: (record) => {
        time += 9;
        return { id: record.id, revision: 1 };
      },
    });
    f.manager.replaceRecords([line("a"), line("b"), line("c")]);
    f.manager.refresh();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.manager.getStats().pendingCount).toBe(2);
    f.flush();
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(f.refreshed).toHaveBeenCalledTimes(3);
  });

  it("pauses generation during zoom and resolves idle only after the latest zoom finishes", async () => {
    const f = fixture({ maxBatchSize: 1 });
    f.manager.replaceRecords([line("a"), line("b")]);
    f.manager.refresh();
    f.emit("zoomstart");
    const resolved = vi.fn();
    void f.manager.whenIdle().then(resolved);
    f.setZoom(5);
    f.emit("moveend");
    f.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce();
    f.emit("zoomend");
    f.flush();
    await f.manager.whenIdle();
    expect(f.attached.size).toBe(0);
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("accepts an existing editor instance and invalidates only the requested record", () => {
    const f = fixture();
    const a = line("a");
    const b = line("b");
    f.manager.replaceRecords([a, b]);
    f.manager.refresh();
    const instance = f.manager.getLayer("a")!;
    const edited = { ...line("a", 139.76), name: "edited" };
    f.manager.upsert(edited, instance);
    f.manager.refresh();
    expect(f.manager.getLayer("a")).toBe(instance);
    expect(f.manager.getRecord("a")).toBe(edited);
    expect(f.manager.getGeometryInfo("a")!.bounds.west).toBe(139.76);
    expect(f.evicted).not.toHaveBeenCalled();
    f.manager.upsert(line("a"));
    f.manager.refresh();
    expect(f.manager.getLayer("a")).not.toBe(instance);
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(f.evicted).toHaveBeenCalledOnce();
    f.manager.replaceRecords([b]);
    f.manager.refresh();
    expect(f.manager.getLayer("b")).not.toBeNull();
    expect(f.manager.getRecord("a")).toBeNull();
    expect(f.manager.getStats()).toMatchObject({ recordCount: 1, renderedCount: 1 });
  });

  it("allows focus to ensure an offscreen object without attaching all other objects", () => {
    const f = fixture();
    f.manager.replaceRecords([line("a", 135), line("b", 135)]);
    const layer = f.manager.ensureLayer("a");
    expect(layer?.id).toBe("a");
    expect(f.manager.getLayer("b")).toBeNull();
    expect(f.attached.size).toBe(0);
    f.pinned.add("a");
    f.manager.refresh();
    expect(f.attached.has(layer!)).toBe(true);
  });

  it("removes deleted and invalid records without retrying failed factories on every pan", () => {
    const f = fixture({
      maxBatchSize: 1,
      create: (record) => (record.id === "bad" ? null : { id: record.id, revision: 1 }),
    });
    f.manager.replaceRecords([
      line("a"),
      line("deleted"),
      line("bad"),
      { ...line("broken"), geojson: {} },
    ]);
    f.manager.refresh();
    f.manager.remove("deleted");
    f.manager.refresh();
    f.flush();
    f.manager.refresh();
    expect(f.manager.isRenderable("bad")).toBe(false);
    expect(f.manager.isRenderable("broken")).toBe(false);
    expect(f.manager.getStats()).toMatchObject({
      recordCount: 3,
      renderableCount: 1,
      renderedCount: 1,
    });
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual(["a", "bad"]);
    f.manager.remove("a");
    expect(f.attached.size).toBe(0);
  });

  it("reuses logical counts instead of rerunning searches for every stats request", () => {
    const f = fixture({ maxBatchSize: 1 });
    const a = line("a");
    f.manager.replaceRecords([
      a,
      line("b"),
      ...Array.from({ length: 2000 }, (_, i) => line("outside-" + i, 135)),
    ]);
    f.manager.refresh();
    const searches = f.visible.mock.calls.length;
    for (let i = 0; i < 10; i++) expect(f.manager.getStats().eligibleCount).toBe(2002);
    expect(f.visible).toHaveBeenCalledTimes(searches);
    f.flush();
    const afterBatch = f.visible.mock.calls.length;
    f.manager.getStats();
    expect(f.visible).toHaveBeenCalledTimes(afterBatch);
    f.manager.remove("b");
    expect(f.manager.getStats()).toMatchObject({ recordCount: 2001, eligibleCount: 2001 });
    f.manager.upsert({ ...line("c"), shown: false });
    expect(f.manager.getStats()).toMatchObject({
      recordCount: 2002,
      renderableCount: 2002,
      eligibleCount: 2001,
    });
    f.manager.replaceRecords([a]);
    expect(f.manager.getStats()).toMatchObject({
      recordCount: 1,
      eligibleCount: 1,
      cachedCount: 1,
    });
  });

  it("limits cumulative generated vertices and still progresses for a single oversized shape", () => {
    const f = fixture({ now: () => 0, maxBatchSize: 500, maxBatchVertices: 10000 });
    const heavy = (id: string, count: number) => {
      const value = line(id);
      value.geojson.geometry.coordinates = Array.from({ length: count }, (_, i) => [
        139.74 + (i / count) * 0.01,
        35.68,
      ]);
      return value;
    };
    f.manager.replaceRecords([
      heavy("a", 6000),
      heavy("b", 6000),
      heavy("oversized", 20000),
      line("last"),
    ]);
    f.manager.refresh();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.manager.getStats().pendingCount).toBe(3);
    f.flush();
    expect(f.create.mock.calls.map(([record]) => record.id)).toEqual([
      "a",
      "b",
      "oversized",
      "last",
    ]);
    expect(f.refreshed).toHaveBeenCalledTimes(4);
    expect(f.manager.getStats().pendingCount).toBe(0);
  });

  it.each([
    ["zoomend", "moveend"],
    ["moveend", "zoomend"],
  ])(
    "cancels old generation at movement start and waits for both end events (%s then %s)",
    async (first, second) => {
      const f = fixture({ maxBatchSize: 1 });
      f.manager.replaceRecords([line("old-a"), line("old-b"), line("new", 135)]);
      f.manager.refresh();
      const stale = f.history[0];
      f.emit("movestart");
      f.emit("zoomstart");
      f.setBounds({ south: 35.6, west: 134.9, north: 35.75, east: 135.1 });
      f.manager.refresh();
      const completed = vi.fn();
      void f.manager.whenIdle().then(completed);
      stale();
      f.emit(first);
      f.flush();
      await Promise.resolve();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.manager.getStats().pendingCount).toBeGreaterThan(0);
      expect(completed).not.toHaveBeenCalled();
      f.emit(second);
      f.flush();
      await f.manager.whenIdle();
      expect(f.create.mock.calls.map(([record]) => record.id)).toEqual(["old-a", "new"]);
      expect([...f.attached].map((layer) => layer.id)).toEqual(["new"]);
      expect(completed).toHaveBeenCalledOnce();
    },
  );

  it("reports scheduled refresh as pending before its first batch exists", async () => {
    const f = fixture();
    f.manager.replaceRecords([line("a")]);
    f.manager.scheduleRefresh();
    expect(f.manager.getStats().pendingCount).toBeGreaterThan(0);
    const completed = vi.fn();
    void f.manager.whenIdle().then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    f.flush();
    await f.manager.whenIdle();
    expect(completed).toHaveBeenCalledOnce();
    expect(f.manager.getStats().pendingCount).toBe(0);
  });

  it("cleans up layers, listeners, pending frames and idle waiters on unload", async () => {
    const f = fixture({ maxBatchSize: 1 });
    f.manager.replaceRecords([line("a"), line("b")]);
    f.manager.refresh();
    const idle = f.manager.whenIdle();
    const stale = f.history[0];
    f.emit("unload");
    await idle;
    stale();
    f.emit("moveend");
    expect(f.frames.size).toBe(0);
    expect(f.attached.size).toBe(0);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.manager.getStats().recordCount).toBe(0);
    expect(f.map.off).toHaveBeenCalledTimes(6);
  });
});
