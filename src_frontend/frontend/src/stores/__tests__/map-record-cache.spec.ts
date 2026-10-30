import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
import { matchesMapSearch } from "@/stores/map-record-cache";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const marker = (id: string, layer_id = "a", name = id) => ({
  id,
  layer_id,
  marker_name: name,
  latitude: 35,
  longitude: 139,
  detail: "",
  update_at: "2026-01-01T00:00:00",
});
const shape = (id: string, layer_id = "a") => ({
  id,
  layer_id,
  user_id: "account",
  shape_type: "polyline" as const,
  name: id,
  geojson: {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [139, 35],
        [140, 36],
      ],
    },
    properties: {},
  },
  created_at: "",
  updated_at: "2026-01-01T00:00:00",
});
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
describe("canonical map data cache", () => {
  it("reuses full and empty scopes and derives a layer from a full list", async () => {
    const store = useMapObjectStore();
    api.get.mockResolvedValueOnce({ data: { one: marker("one"), two: marker("two", "b") } });
    expect(await store.queryMapObject("master", true)).toBe(true);
    store.clearMapObject();
    expect(await store.queryMapObject("a", false)).toBe(true);
    expect([...store.mapObjectList.keys()]).toEqual(["one"]);
    expect(await store.queryMapObject("empty", false)).toBe(true);
    expect(store.mapObjectList.size).toBe(0);
    expect(await store.queryMapObject("empty", false)).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it("shares an in-flight request while cancelling only an obsolete caller", async () => {
    const pending = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    api.get.mockReturnValueOnce(pending.promise);
    const store = useMapObjectStore(),
      controller = new AbortController();
    const first = store.queryMapObject("a", false, controller.signal);
    const second = store.queryMapObject("a", false);
    controller.abort();
    pending.resolve({ data: { one: marker("one") } });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(store.mapObjectList.has("one")).toBe(true);
  });
  it("replays create, move and delete writes over an older GET", async () => {
    const pending = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    api.get.mockReturnValueOnce(pending.promise);
    const store = useMapObjectStore();
    const load = store.queryMapObject("a", false);
    await Promise.resolve();
    store.upsertRecord(marker("added"));
    store.upsertRecord(marker("moved", "b"));
    store.removeRecord("deleted");
    pending.resolve({ data: { deleted: marker("deleted"), moved: marker("moved") } });
    expect(await load).toBe(true);
    expect([...store.mapObjectList.keys()]).toEqual(["added"]);
    expect(store.recordCache.records.get("moved")?.layer_id).toBe("b");
  });
  it("never publishes an old account response, even after returning to that account", async () => {
    const pending = deferred<{ data: ReturnType<typeof shape>[] }>();
    api.get.mockReturnValueOnce(pending.promise);
    const auth = useAuthStore(),
      store = useShapeStore();
    auth.setAccount("first");
    const load = store.queryShapes("a", false);
    await Promise.resolve();
    auth.logout();
    auth.setAccount("second");
    auth.setAccount("first");
    pending.resolve({ data: [shape("old")] });
    expect(await load).toBe(false);
    expect(store.getScopeRecords()).toEqual([]);
  });
  it("keeps canonical data after failed refresh and retries a failed empty request", async () => {
    const store = useShapeStore();
    api.get.mockResolvedValueOnce({ data: [shape("one")] });
    await store.queryShapes("a", false);
    api.get.mockRejectedValueOnce(Error("offline"));
    expect(await store.queryShapes("a", false, undefined, true)).toBe(false);
    expect(store.shapeList.has("one")).toBe(true);
    api.get.mockResolvedValueOnce({ data: [] });
    expect(await store.queryShapes("a", false, undefined, true)).toBe(true);
    expect(store.shapeList.size).toBe(0);
    await store.queryShapes("a", false);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
  it("updates all loaded memberships when moving an object without marking a new scope loaded", async () => {
    const store = useShapeStore();
    api.get.mockResolvedValueOnce({ data: [shape("one")] });
    await store.queryShapes("a", false);
    store.upsertRecord(shape("one", "b"));
    expect(store.getScopeRecords("a", false)).toEqual([]);
    api.get.mockResolvedValueOnce({ data: [shape("one", "b")] });
    await store.queryShapes("b", false);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(store.shapeList.has("one")).toBe(true);
  });
  it("uses canonical PUT responses and rejects a delayed older upsert", async () => {
    const store = useMapObjectStore();
    store.upsertRecord(marker("one"));
    api.put.mockResolvedValueOnce({
      data: {
        object: { ...marker("one"), detail: "server body", update_at: "2026-01-02T00:00:00" },
      },
    });
    const updated = await store.updateMapObject("one", "name", "client body", "a");
    expect(updated?.detail).toBe("server body");
    store.upsertRecord(marker("one"));
    expect(store.getById("one").detail).toBe("server body");
  });
  it("keeps search as a view and updates only changed records without another GET", async () => {
    const objects = useMapObjectStore(),
      figures = useShapeStore();
    api.get.mockResolvedValueOnce({
      data: { one: marker("one", "a", "match"), two: marker("two") },
    });
    await objects.queryMapObject("a", false);
    api.get.mockResolvedValueOnce({ data: [shape("shape")] });
    await figures.queryShapes("a", false);
    api.get.mockResolvedValueOnce({
      data: { markers: { one: marker("one", "a", "match") }, shape_ids: [] },
    });
    await objects.queryWordMapObject("match", "", "a");
    expect(objects.getScopeRecords().length).toBe(2);
    objects.upsertRecord(marker("three", "a", "match"));
    objects.removeRecord("one");
    figures.upsertRecord({ ...shape("shape"), name: "match" });
    objects.refreshSearchResults();
    expect([...objects.mapObjectList.keys()]).toEqual(["three"]);
    expect(objects.filteredShapeIds).toEqual(["shape"]);
    figures.removeRecord("shape");
    objects.refreshSearchResults();
    expect(objects.filteredShapeIds).toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("bounds inactive scope retention without evicting the active scope", async () => {
    const store = useMapObjectStore();
    for (let i = 0; i < 10; i++) {
      const layer = "layer-" + i;
      api.get.mockResolvedValueOnce({ data: { one: marker("record-" + i, layer) } });
      await store.queryMapObject(layer, false);
    }
    expect(store.getScopeRecords("layer-9", false)).toHaveLength(1);
    expect(store.getScopeRecords("layer-0", false)).toHaveLength(0);
    api.get.mockResolvedValueOnce({ data: {} });
    await store.queryMapObject("layer-0", false);
    expect(api.get).toHaveBeenCalledTimes(11);
  });
  it("ignores an obsolete forced response for the same scope", async () => {
    const old = deferred<{ data: ReturnType<typeof shape>[] }>();
    const store = useShapeStore();
    api.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: [shape("new")] });
    const first = store.queryShapes("a", false);
    const second = store.queryShapes("a", false, undefined, true);
    expect(await second).toBe(true);
    old.resolve({ data: [shape("old")] });
    expect(await first).toBe(false);
    expect([...store.shapeList.keys()]).toEqual(["new"]);
  });

  it("guards PUT and DELETE completion across account changes", async () => {
    const update = deferred<{ data: { object: ReturnType<typeof marker> } }>();
    const remove = deferred<{ data: {} }>();
    const objects = useMapObjectStore(),
      auth = useAuthStore();
    auth.setAccount("old");
    objects.upsertRecord(marker("one"));
    objects.upsertRecord(marker("two"));
    api.put.mockReturnValueOnce(update.promise);
    api.delete.mockReturnValueOnce(remove.promise);
    const changed = objects.updateMapObject("one", "old account", "body", "a");
    const deleted = objects.deleteMapObject("two");
    auth.setAccount("new");
    objects.upsertRecord(marker("two", "new"));
    update.resolve({ data: { object: marker("one") } });
    remove.resolve({ data: {} });
    expect(await changed).toBeNull();
    expect(await deleted).toBe(false);
    expect(objects.getScopeRecords().map((record) => record.id)).toEqual(["two"]);
  });
  it("retains finer-than-millisecond server update ordering", () => {
    const store = useShapeStore();
    store.upsertRecord({ ...shape("one"), name: "new", updated_at: "2026-01-01T00:00:00.123456" });
    store.upsertRecord({ ...shape("one"), name: "old", updated_at: "2026-01-01T00:00:00.123455" });
    expect(store.getById("one")?.name).toBe("new");
  });
  it("preserves a newer overlapping scope snapshot when an older full read finishes", async () => {
    const pending = deferred<{ data: ReturnType<typeof shape>[] }>();
    api.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      data: [{ ...shape("one"), name: "new", updated_at: "2026-01-02T00:00:00" }, shape("added")],
    });
    const store = useShapeStore();
    const all = store.queryShapes("master", true);
    await store.queryShapes("a", false);
    pending.resolve({ data: [shape("one")] });
    await all;
    store.activateScope("master", true);
    expect(store.getById("one")?.name).toBe("new");
    expect(store.shapeList.has("added")).toBe(true);
  });
  it("restores a previous scope from canonical data rather than an obsolete display copy", async () => {
    const objects = useMapObjectStore(),
      figures = useShapeStore();
    api.get.mockResolvedValueOnce({ data: { one: marker("one") } });
    await objects.queryMapObject("a", false);
    api.get.mockResolvedValueOnce({ data: [shape("shape")] });
    await figures.queryShapes("a", false);
    objects.upsertRecord({
      ...marker("one"),
      marker_name: "changed",
      update_at: "2026-01-02T00:00:00",
    });
    figures.upsertRecord({ ...shape("shape"), name: "changed", updated_at: "2026-01-02T00:00:00" });
    figures.activateScope("a", false);
    objects.activateScope("a", false, { query1: "changed", query2: "", layerId: "a" });
    expect(objects.mapObjectList.get("one")?.marker_name).toBe("changed");
    expect(objects.filteredShapeIds).toEqual(["shape"]);
  });

  it("leases a still-displayed scope while other scopes fill the cache", async () => {
    const store = useMapObjectStore();
    api.get.mockResolvedValueOnce({ data: { one: marker("one", "displayed") } });
    await store.queryMapObject("displayed", false);
    const release = store.recordCache.retainScope("displayed", false);
    for (let i = 0; i < 10; i++) {
      api.get.mockResolvedValueOnce({ data: {} });
      await store.queryMapObject("next-" + i, false);
    }
    expect(store.getScopeRecords("displayed", false)).toHaveLength(1);
    store.activateScope("displayed", false);
    release();
    release();
    expect(store.mapObjectList.has("one")).toBe(true);
  });
  it("does not revive a deleted ID from an old upsert notification", () => {
    const store = useShapeStore();
    store.upsertRecord(shape("one"));
    store.removeRecord("one");
    expect(store.upsertRecord(shape("one"))).toBe(false);
    expect(store.getById("one")).toBeUndefined();
  });
  it("still applies a completed write when only the same-account read cache was invalidated", async () => {
    const pending = deferred<{ data: { object: ReturnType<typeof marker> } }>();
    const store = useMapObjectStore();
    store.upsertRecord(marker("one"));
    api.put.mockReturnValueOnce(pending.promise);
    const update = store.updateMapObject("one", "new", "body", "a");
    store.invalidateCache();
    pending.resolve({
      data: { object: { ...marker("one"), marker_name: "new", update_at: "2026-01-02T00:00:00" } },
    });
    expect((await update)?.marker_name).toBe("new");
  });

  it("reports search application only for a successful current response", async () => {
    const store = useMapObjectStore();
    api.get.mockResolvedValueOnce({ data: { markers: {}, shape_ids: [] } });
    expect(await store.queryWordMapObject("first", "", "a")).toBe(true);
    const pending = deferred<{ data: { markers: {}; shape_ids: string[] } }>();
    api.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ data: {} });
    const stale = store.queryWordMapObject("stale", "", "a");
    await store.queryMapObject("b", false);
    pending.resolve({ data: { markers: {}, shape_ids: [] } });
    expect(await stale).toBe(false);
    api.get.mockRejectedValueOnce(Error("offline"));
    expect(await store.queryWordMapObject("failed", "", "b")).toBe(false);
    expect(store.search).toBeNull();
  });

  it("updates a single record in 40,000-record originals without traversing or replacing display maps", async () => {
    const objects = useMapObjectStore(),
      figures = useShapeStore();
    const markers = Object.fromEntries(
      Array.from({ length: 40000 }, (_, index) => {
        const record = marker("marker-" + index);
        return [record.id, record];
      }),
    );
    api.get.mockResolvedValueOnce({ data: markers });
    await objects.queryMapObject("master", true);
    api.get.mockResolvedValueOnce({
      data: Array.from({ length: 40000 }, (_, index) => shape("shape-" + index)),
    });
    await figures.queryShapes("master", true);
    expect(objects.mapObjectList.size).toBe(40000);
    expect(figures.shapeList.size).toBe(40000);
    const markerMap = objects.mapObjectList,
      shapeMap = figures.shapeList;
    const untouchedMarker = markerMap.get("marker-1"),
      untouchedShape = shapeMap.get("shape-1");
    const markerReads = vi.spyOn(objects, "getScopeRecords"),
      shapeReads = vi.spyOn(figures, "getScopeRecords");
    objects.upsertRecord({
      ...marker("marker-20000"),
      marker_name: "changed",
      update_at: "2026-01-02T00:00:00",
    });
    figures.upsertRecord({
      ...shape("shape-20000"),
      name: "changed",
      updated_at: "2026-01-02T00:00:00",
    });
    objects.refreshSearchResults();
    objects.refreshSearchResults();
    expect(markerReads).not.toHaveBeenCalled();
    expect(shapeReads).not.toHaveBeenCalled();
    expect(objects.mapObjectList).toBe(markerMap);
    expect(figures.shapeList).toBe(shapeMap);
    expect(markerMap.get("marker-20000")?.marker_name).toBe("changed");
    expect(shapeMap.get("shape-20000")?.name).toBe("changed");
    expect(markerMap.get("marker-1")).toBe(untouchedMarker);
    expect(shapeMap.get("shape-1")).toBe(untouchedShape);
    objects.removeRecord("marker-20000");
    figures.removeRecord("shape-20000");
    objects.refreshSearchResults();
    expect(markerReads).not.toHaveBeenCalled();
    expect(shapeReads).not.toHaveBeenCalled();
    expect(markerMap.size).toBe(39999);
    expect(shapeMap.size).toBe(39999);
  });
  it("keeps literal spaces, percent, underscore and two-term AND search semantics", () => {
    expect(matchesMapSearch(["東京 Water_% ", "pipe"], ["water_% ", "pipe"])).toBe(true);
    expect(matchesMapSearch(["Water", "pipe"], ["Water ", ""])).toBe(false);
    expect(matchesMapSearch(["東京", "pipe"], ["東京", "missing"])).toBe(false);
  });
});

describe("attribute and text search composition", () => {
  const criteria = {
    common_form_id: "form",
    definition_version: 1,
    layer_ids: null,
    conditions: [],
  };
  const result = (marker_ids: string[], shape_ids: string[]) => ({
    common_form_id: "form",
    definition_version: 1,
    as_of: "2026-10-30T00:00:00Z",
    marker_ids,
    shape_ids,
    target_count: marker_ids.length + shape_ids.length,
  });
  it.each([false, true])(
    "preserves server text matches through attribute apply, recheck, and clear (matched=%s)",
    async (matched) => {
      const markers = useMapObjectStore(),
        shapes = useShapeStore();
      const record = marker("one", "a", "Ａ地点");
      const figure = { ...shape("s1"), name: "Ａ地点" };
      api.get.mockResolvedValueOnce({ data: { one: record } });
      await markers.queryMapObject("a", false);
      api.get.mockResolvedValueOnce({ data: [figure] });
      await shapes.queryShapes("a", false);
      // SQLite LIKE excludes this full-width case variant; other collations may include it.
      api.get.mockResolvedValueOnce({
        data: { markers: matched ? { one: record } : {}, shape_ids: matched ? ["s1"] : [] },
      });
      await markers.queryWordMapObject("ａ", "", "a");
      const expectMatches = () => {
        expect([...markers.mapObjectList.keys()]).toEqual(matched ? ["one"] : []);
        expect(markers.filteredShapeIds).toEqual(matched ? ["s1"] : []);
      };
      expectMatches();
      markers.setAttributeSearch(criteria, result(["one"], ["s1"]));
      expectMatches();
      // Answer changes must not re-evaluate unchanged text with a different collation.
      markers.upsertRecord({ ...record, update_at: "2026-01-02T00:00:00" });
      shapes.upsertRecord({ ...figure, updated_at: "2026-01-02T00:00:00" });
      markers.refreshSearchResults(true);
      expectMatches();
      markers.setAttributeSearch(null, null);
      expectMatches();
      // Restoring a failed reload must retain the same server matches as well.
      const search = markers.search;
      markers.clearSearch();
      markers.activateScope("a", false, search);
      expectMatches();
      // Actual text edits still update the view locally, as before.
      markers.upsertRecord({ ...record, marker_name: "ａ地点", update_at: "2026-01-03T00:00:00" });
      shapes.upsertRecord({ ...figure, name: "ａ地点", updated_at: "2026-01-03T00:00:00" });
      markers.refreshSearchResults();
      expect([...markers.mapObjectList.keys()]).toEqual(["one"]);
      expect(markers.filteredShapeIds).toEqual(["s1"]);
      expect(api.get).toHaveBeenCalledTimes(3);
    },
  );
  it("replays concurrent text edits over a delayed search and preserves them on attribute changes", async () => {
    const markers = useMapObjectStore(),
      shapes = useShapeStore();
    markers.upsertRecord(marker("one"));
    shapes.upsertRecord(shape("s1"));
    const pending = deferred<{ data: { markers: {}; shape_ids: string[] } }>();
    api.get.mockReturnValueOnce(pending.promise);
    const searching = markers.queryWordMapObject("needle", "", "a");
    markers.upsertRecord({ ...marker("one"), marker_name: "needle" });
    shapes.upsertRecord({ ...shape("s1"), name: "needle" });
    pending.resolve({ data: { markers: {}, shape_ids: [] } });
    await searching;
    markers.setAttributeSearch(criteria, result(["one"], ["s1"]));
    expect([...markers.mapObjectList.keys()]).toEqual(["one"]);
    expect(markers.filteredShapeIds).toEqual(["s1"]);
    markers.setAccount("new-account");
    expect(markers.search).toBeNull();
    expect(markers.filteredShapeIds).toBeNull();
  });
  it("updates text matches when records move into the active layer without a text edit", async () => {
    const markers = useMapObjectStore(),
      shapes = useShapeStore();
    markers.activateScope("a", false);
    shapes.activateScope("a", false);
    markers.upsertRecord(marker("one", "b", "needle"));
    shapes.upsertRecord({ ...shape("s1", "b"), name: "needle" });
    api.get.mockResolvedValueOnce({ data: { markers: {}, shape_ids: [] } });
    await markers.queryWordMapObject("needle", "", "a");
    markers.upsertRecord(marker("one", "a", "needle"));
    shapes.upsertRecord({ ...shape("s1", "a"), name: "needle" });
    markers.refreshSearchResults();
    expect([...markers.mapObjectList.keys()]).toEqual(["one"]);
    expect(markers.filteredShapeIds).toEqual(["s1"]);
  });
  it("keeps canonical data, combines text and attribute IDs, and restores after clear", async () => {
    const markers = useMapObjectStore(),
      shapes = useShapeStore();
    api.get.mockResolvedValueOnce({
      data: { a: marker("a", "a", "needle"), b: marker("b", "a", "needle") },
    });
    await markers.queryMapObject("a", false);
    api.get.mockResolvedValueOnce({ data: [shape("s1"), shape("s2")] });
    await shapes.queryShapes("a", false);
    markers.setAttributeSearch(criteria, result(["a"], ["s1"]));
    expect([...markers.mapObjectList.keys()]).toEqual(["a"]);
    expect(markers.filteredShapeIds).toEqual(["s1"]);
    expect(markers.recordCache.records.size).toBe(2);
    api.get.mockResolvedValueOnce({
      data: {
        markers: { a: marker("a", "a", "needle"), b: marker("b", "a", "needle") },
        shape_ids: ["s1", "s2"],
      },
    });
    await markers.queryWordMapObject("needle", "", "a");
    expect([...markers.mapObjectList.keys()]).toEqual(["a"]);
    expect(markers.filteredShapeIds).toEqual(["s1"]);
    markers.setAttributeSearch(null, null);
    expect(markers.mapObjectList.size).toBe(2);
    expect(markers.search?.query1).toBe("needle");
  });
  it("does not confuse zero results with disabled filters, even during writes", async () => {
    const markers = useMapObjectStore(),
      shapes = useShapeStore();
    api.get.mockResolvedValueOnce({ data: { a: marker("a") } });
    await markers.queryMapObject("a", false);
    api.get.mockResolvedValueOnce({ data: [shape("s1")] });
    await shapes.queryShapes("a", false);
    markers.setAttributeSearch(criteria, result([], []));
    markers.upsertRecord(marker("new"));
    shapes.upsertRecord(shape("new-shape"));
    markers.refreshSearchResults();
    expect(markers.mapObjectList.size).toBe(0);
    expect(markers.filteredShapeIds).toEqual([]);
    markers.setAttributeSearch(null, null);
    expect(markers.mapObjectList.size).toBe(2);
    expect(markers.filteredShapeIds).toBeNull();
  });
});
