import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MapObjectTable from "@/components/map-object/MapObjectTable.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { MapObjectTableIndex } from "@/composables/map-object-table-index";
import * as centers from "@/composables/useShapeCenter";
import { marker, shape } from "@/composables/__tests__/table-fixtures";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
const MOBILE = false;
let wrapper: VueWrapper | undefined;
let viewportHeight = 560;
let resize: (() => void) | undefined;
beforeEach(() => {
  setActivePinia(createPinia());
  viewportHeight = 560;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
    return (this as HTMLElement).classList.contains("table-area") ? viewportHeight : 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function table(active = true) {
  wrapper = mount(MapObjectTable, {
    props: {
      active,
      activeLayer: "a",
      ...(MOBILE ? { mapObjectQueryFormData: { query1: "", query2: "" } } : { height: 70 }),
    },
  });
  await nextTick();
  await nextTick();
  return wrapper;
}
function seed(count = 2000) {
  const records = Array.from({ length: count }, (_, i) => shape(String(i).padStart(5, "0")));
  useShapeStore().shapeList = new Map(records.map((record) => [record.id, record]));
}
async function scroll(top: number) {
  const area = wrapper!.get(".table-area");
  (area.element as HTMLElement).scrollTop = top;
  await area.trigger("scroll");
}
function rowKeys() {
  return wrapper!.findAll("[data-row-key]").map((row) => row.attributes("data-row-key"));
}

describe("virtual map object table", () => {
  it("mounts a bounded set of rows, uses lazy centers, and edits/focuses the scrolled typed ID", async () => {
    seed(20000);
    const spy = vi.spyOn(centers, "getShapeCenter");
    await table();
    expect(rowKeys().length).toBeLessThanOrEqual(23);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(23);
    await scroll(1000 * 56 + 36);
    expect(rowKeys()).toContain("shape:01000");
    const row = wrapper!.get('[data-row-key="shape:01000"]');
    await row.findAll("td")[1]!.trigger("click");
    await row.findAll("td")[2]!.trigger("click");
    expect(wrapper!.emitted("editObject")?.at(-1)).toEqual(["shape", "01000"]);
    expect(wrapper!.emitted("focusObject")?.at(-1)).toEqual(["shape", "01000", 35.0005, 139.0005]);
    await scroll(20000 * 56);
    expect(rowKeys().at(-1)).toBe("shape:19999");
    expect(api.get).not.toHaveBeenCalled();
  });
  it("patches changed IDs after dirtyIds are consumed, without rebuilding or recalculating other centers", async () => {
    seed();
    useMapObjectStore().upsertRecord(marker("same"));
    await table();
    const rebuild = vi.spyOn(MapObjectTableIndex.prototype, "reset");
    const spy = vi.spyOn(centers, "getShapeCenter");
    const shapes = useShapeStore(),
      markers = useMapObjectStore();
    shapes.upsertRecord({ ...shape("00000", "updated"), updated_at: "2026-03-01T00:00:00" });
    markers.refreshSearchResults();
    expect(shapes.dirtyIds.size).toBe(0);
    await nextTick();
    expect(wrapper!.get('[data-row-key="shape:00000"]').text()).toContain("updated");
    expect(rebuild).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    shapes.upsertRecord(shape("same", ""));
    markers.refreshSearchResults();
    await nextTick();
    expect(rowKeys()).toContain("shape:same");
    expect(rowKeys()).toContain("marker:same");
    markers.removeRecord("same");
    await nextTick();
    expect(rowKeys()).not.toContain("marker:same");
    expect(rowKeys()).toContain("shape:same");
    shapes.removeRecord("same");
    markers.refreshSearchResults();
    await nextTick();
    expect(rowKeys()).not.toContain("shape:same");
    expect(api.get).not.toHaveBeenCalled();
  });
  it("suspends while hidden and restores scroll, latest records, and saved mobile query on reopen", async () => {
    seed();
    await table();
    await scroll(5600);
    await wrapper!.setProps({ active: false });
    expect(wrapper!.find(".table-area").exists()).toBe(false);
    const rebuild = vi.spyOn(MapObjectTableIndex.prototype, "reset");
    const spy = vi.spyOn(centers, "getShapeCenter");
    useShapeStore().upsertRecord(shape("00100", "hidden update"));
    useMapObjectStore().refreshSearchResults();
    await nextTick();
    expect(rebuild).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    await wrapper!.setProps({ active: true });
    await nextTick();
    await nextTick();
    expect((wrapper!.get(".table-area").element as HTMLElement).scrollTop).toBe(5600);
    expect(wrapper!.get('[data-row-key="shape:00100"]').text()).toContain("hidden update");
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
  });
  it("searches all records including offscreen items and updates search membership incrementally", async () => {
    const shapes = useShapeStore(),
      markers = useMapObjectStore();
    shapes.upsertRecord(shape("offscreen", "needle"));
    shapes.upsertRecord(shape("other", "other"));
    await table();
    markers.search = { query1: "needle", query2: "", layerId: "a" };
    markers.refreshSearchResults(true);
    await nextTick();
    expect(rowKeys()).toEqual(["shape:offscreen"]);
    shapes.upsertRecord({ ...shape("offscreen", "gone"), updated_at: "2026-02-01T00:00:00" });
    markers.refreshSearchResults();
    await nextTick();
    expect(rowKeys()).toEqual([]);
    shapes.upsertRecord({ ...shape("other", "needle"), updated_at: "2026-02-01T00:00:00" });
    markers.refreshSearchResults();
    await nextTick();
    expect(rowKeys()).toEqual(["shape:other"]);
    markers.clearSearch();
    markers.refreshSearchResults(true);
    await nextTick();
    expect(rowKeys()).toHaveLength(2);
  });
  it("publishes fetched snapshots and server search results, and coalesces a bulk edit into one rebuild", async () => {
    await table();
    api.get.mockResolvedValueOnce({ data: [shape("loaded", "needle")] });
    await useShapeStore().queryShapes("a", true);
    await nextTick();
    expect(rowKeys()).toEqual(["shape:loaded"]);
    api.get.mockResolvedValueOnce({
      data: { markers: { loaded: marker("loaded", "needle") }, shape_ids: ["loaded"] },
    });
    await useMapObjectStore().queryWordMapObject("needle", "", "a");
    await nextTick();
    expect(rowKeys()).toEqual(["marker:loaded", "shape:loaded"]);
    useMapObjectStore().clearSearch();
    await nextTick();
    const rebuild = vi.spyOn(MapObjectTableIndex.prototype, "reset");
    for (let i = 0; i < 300; ++i) useShapeStore().upsertRecord(shape(`bulk-${i}`));
    useMapObjectStore().refreshSearchResults();
    await nextTick();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(wrapper!.get("table").attributes("aria-rowcount")).toBe("303");
  });
  it("resizes the virtual window, clamps deletions at the bottom and clears on account/scope reset", async () => {
    seed(100);
    await table();
    await scroll(100 * 56);
    viewportHeight = 280;
    resize?.();
    await nextTick();
    expect(rowKeys().length).toBeLessThanOrEqual(18);
    const shapes = useShapeStore();
    shapes.resetCache();
    await nextTick();
    expect(rowKeys()).toEqual([]);
    expect((wrapper!.get(".table-area").element as HTMLElement).scrollTop).toBe(0);
    shapes.upsertRecord(shape("new"));
    await nextTick();
    expect(rowKeys()).toEqual(["shape:new"]);
    shapes.activateScope("b", false);
    await nextTick();
    expect(rowKeys()).toEqual([]);
    shapes.setAccount("different user");
    await nextTick();
    expect(rowKeys()).toEqual([]);
  });
});

if (MOBILE)
  describe("virtual mobile gestures and query state", () => {
    async function swipeMarker() {
      useMapObjectStore().upsertRecord(marker("same"));
      useShapeStore().upsertRecord(shape("same"));
      await table();
      const row = wrapper!.get('[data-row-key="marker:same"]');
      await row.trigger("touchstart", { touches: [{ clientX: 200 }] });
      await row.trigger("touchmove", { touches: [{ clientX: 50 }] });
      await row.trigger("touchend", { changedTouches: [{ clientX: 50 }] });
    }
    it("deletes only the original marker and cancels pending confirmation on close/unmount/removal", async () => {
      vi.useFakeTimers();
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      await swipeMarker();
      expect(wrapper!.get('[data-row-key="shape:same"]').classes()).not.toContain("confirm-delete");
      await vi.advanceTimersByTimeAsync(300);
      expect(wrapper!.emitted("deleteMarker")).toEqual([["same"]]);
      wrapper!.unmount();
      wrapper = undefined;
      await swipeMarker();
      await wrapper!.setProps({ active: false });
      await vi.advanceTimersByTimeAsync(300);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(wrapper!.emitted("deleteMarker")).toBeUndefined();
      wrapper!.unmount();
      wrapper = undefined;
      await swipeMarker();
      useMapObjectStore().removeRecord("same");
      await nextTick();
      await vi.advanceTimersByTimeAsync(300);
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    it("keeps the mobile search input across closing/reopening and emits a single query update", async () => {
      await table();
      await wrapper!.get("#search-textbox1").setValue("needle");
      expect(wrapper!.emitted("mapObjectSearch")).toEqual([
        [{ query1: "needle", query2: "" }, false],
      ]);
      await wrapper!.setProps({ active: false });
      await wrapper!.setProps({ active: true });
      expect((wrapper!.get("#search-textbox1").element as HTMLInputElement).value).toBe("needle");
      expect(wrapper!.emitted("mapObjectSearch")).toHaveLength(1);
    });
  });
