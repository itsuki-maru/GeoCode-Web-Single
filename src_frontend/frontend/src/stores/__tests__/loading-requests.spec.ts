import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const marker = (id: string) => ({
  id,
  layer_id: id,
  marker_name: id,
  latitude: 0,
  longitude: 0,
  detail: "",
  update_at: "",
});
const shape = (id: string) => ({ id, layer_id: id, name: id, geojson: {} });
beforeEach(() => setActivePinia(createPinia()));
describe("map data request ordering", () => {
  it("ignores an old full-list response after loading a selected layer", async () => {
    const pending = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    api.get
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ data: { selected: marker("selected") } });
    const store = useMapObjectStore();
    const old = store.initList();
    expect(await store.queryMapObject("selected", false)).toBe(true);
    pending.resolve({ data: { all: marker("all") } });
    await old;
    expect([...store.mapObjectList.keys()]).toEqual(["selected"]);
  });
  it("ignores an old search and its shape filter after a layer switch", async () => {
    const pending = deferred<{
      data: { markers: Record<string, ReturnType<typeof marker>>; shape_ids: string[] };
    }>();
    api.get
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ data: { selected: marker("selected") } });
    const store = useMapObjectStore();
    const old = store.queryWordMapObject("old", "", "old");
    await store.queryMapObject("selected", false);
    pending.resolve({ data: { markers: { old: marker("old") }, shape_ids: ["old"] } });
    await old;
    expect([...store.mapObjectList.keys()]).toEqual(["selected"]);
    expect(store.filteredShapeIds).toBeNull();
  });
  it("keeps the latest shape response when requests resolve out of order", async () => {
    const pending = deferred<{ data: ReturnType<typeof shape>[] }>();
    api.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ data: [shape("new")] });
    const store = useShapeStore();
    const old = store.queryShapes("old", false);
    await store.queryShapes("new", false);
    pending.resolve({ data: [shape("old")] });
    expect(await old).toBe(false);
    expect([...store.shapeList.keys()]).toEqual(["new"]);
  });
  it("does not publish aborted marker/shape responses even if the transport still resolves", async () => {
    const markers = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    const shapes = deferred<{ data: ReturnType<typeof shape>[] }>();
    api.get.mockReturnValueOnce(markers.promise).mockReturnValueOnce(shapes.promise);
    const controller = new AbortController();
    const objects = useMapObjectStore(),
      figures = useShapeStore();
    const oldMarkers = objects.queryMapObject("old", false, controller.signal);
    const oldShapes = figures.queryShapes("old", false, controller.signal);
    controller.abort();
    markers.resolve({ data: { old: marker("old") } });
    shapes.resolve({ data: [shape("old")] });
    expect(await oldMarkers).toBe(false);
    expect(await oldShapes).toBe(false);
    expect(objects.mapObjectList.size).toBe(0);
    expect(figures.shapeList.size).toBe(0);
  });
});
