import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), isAxiosError: () => false }));
vi.mock("@/axiosClient", () => ({ default: api }));
import { useAdvancedMapSearch } from "../useAdvancedMapSearch";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
const criteria = { common_form_id: "form", definition_version: 1, layer_ids: null, conditions: [] };
const result = (shape_ids: string[]) => ({
  common_form_id: "form",
  definition_version: 1,
  as_of: "2026-10-30T00:00:00Z",
  marker_ids: [],
  shape_ids,
  target_count: shape_ids.length,
});
const shape = (id: string) => ({
  id,
  layer_id: "a",
  user_id: "account",
  shape_type: "circle" as const,
  name: id,
  geojson: {
    type: "Feature" as const,
    properties: { radius: 20 },
    geometry: { type: "Point" as const, coordinates: [139, 35] },
  },
  created_at: "",
  updated_at: "2026-10-30T00:00:00Z",
});
let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => wrapper?.unmount());

it("rechecks a saved answer only for changed IDs and updates the shape filter", async () => {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    apply = vi.fn();
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  wrapper = mount(
    defineComponent({
      setup() {
        useAdvancedMapSearch(ref("a"), ref("master"), apply, vi.fn());
        return () => null;
      },
    }),
  );
  markers.setAttributeSearch(criteria, result([]));
  await flushPromises();
  api.post.mockResolvedValue({ data: result(["s1"]) });
  shapes.upsertRecord(shape("s1"));
  await flushPromises();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0]![1]).toMatchObject({
    targets: [{ target_type: "shape", id: "s1" }],
  });
  expect(markers.attributeShapeIds?.has("s1")).toBe(true);
  expect(markers.filteredShapeIds).toEqual(["s1"]);
  expect(apply).toHaveBeenCalled();
});

it("does not restore a cleared attribute search when an older recheck completes", async () => {
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  wrapper = mount(
    defineComponent({
      setup() {
        useAdvancedMapSearch(ref("a"), ref("master"), vi.fn(), vi.fn());
        return () => null;
      },
    }),
  );
  markers.setAttributeSearch(criteria, result([]));
  await flushPromises();
  let resolve!: (value: unknown) => void;
  api.post.mockReturnValue(new Promise((yes) => (resolve = yes)));
  shapes.upsertRecord(shape("s1"));
  await flushPromises();
  markers.setAttributeSearch(null, null);
  resolve({ data: result(["s1"]) });
  await flushPromises();
  expect(markers.attributeSearch).toBeNull();
  expect(markers.attributeShapeIds).toBeNull();
  expect(markers.filteredShapeIds).toBeNull();
});

function mountSearch() {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    apply = vi.fn();
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  let search!: ReturnType<typeof useAdvancedMapSearch>;
  wrapper = mount(
    defineComponent({
      setup() {
        search = useAdvancedMapSearch(ref("a"), ref("master"), apply, vi.fn());
        return () => null;
      },
    }),
  );
  return { markers, shapes, search, apply };
}
function pendingResult() {
  let resolve!: (value: { data: ReturnType<typeof result> }) => void;
  const promise = new Promise<{ data: ReturnType<typeof result> }>((yes) => (resolve = yes));
  return { promise, resolve };
}

it("labels the attribute-only count when the existing text search reduces the visible results", async () => {
  const { markers, shapes, search } = mountSearch();
  shapes.upsertRecord({ ...shape("s1"), name: "alpha" });
  shapes.upsertRecord({ ...shape("s2"), name: "beta" });
  api.get.mockResolvedValueOnce({ data: { markers: {}, shape_ids: ["s1"] } });
  await markers.queryWordMapObject("alpha", "", "a");
  api.get.mockResolvedValueOnce({
    data: [{ id: "form", version: 1, form_title: "設備", form_schema: { fields: [] } }],
  });
  api.post.mockResolvedValue({ data: result(["s1", "s2"]) });
  search.openAdvancedSearch();
  await flushPromises();
  const dialog = document.querySelector("dialog")!;
  const select = dialog.querySelector("select")!;
  select.value = "form";
  select.dispatchEvent(new Event("change"));
  dialog.querySelector<HTMLButtonElement>(".attribute-submit")!.click();
  await flushPromises();
  expect(markers.filteredShapeIds).toEqual(["s1"]);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("属性条件のみの一致件数：2件");
});

it("keeps the modal open on apply and clear, allows another search, and closes on an external reset", async () => {
  const { markers, search, apply } = mountSearch();
  api.get.mockResolvedValue({
    data: [{ id: "form", version: 1, form_title: "設備", form_schema: { fields: [] } }],
  });
  api.post.mockResolvedValue({ data: result(["s1"]) });
  search.openAdvancedSearch();
  await flushPromises();
  const dialog = document.querySelector("dialog")!;
  const selectForm = () => {
    const select = dialog.querySelector("select")!;
    select.value = "form";
    select.dispatchEvent(new Event("change"));
  };
  const click = (text: string) =>
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
  selectForm();
  click("検索");
  await flushPromises();
  expect(markers.attributeShapeIds).toEqual(new Set(["s1"]));
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute("aria-busy")).toBe("false");
  expect(apply).toHaveBeenCalledOnce();
  click("属性条件を解除");
  expect(markers.attributeSearch).toBeNull();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("select")?.value).toBe("");
  selectForm();
  click("検索");
  await flushPromises();
  expect(dialog.open).toBe(true);
  expect(api.post).toHaveBeenCalledTimes(2);
  markers.setAttributeSearch(null, null);
  expect(dialog.open).toBe(false);
});

it("a late canceled request cannot unlock a newer full recheck or discard its queued saves", async () => {
  const { markers, shapes, search } = mountSearch();
  markers.setAttributeSearch(criteria, result([]));
  const old = pendingResult(),
    full = pendingResult();
  api.post
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(full.promise)
    .mockResolvedValue({ data: result(["s2"]) });
  shapes.upsertRecord(shape("s1"));
  await flushPromises();
  expect(api.post).toHaveBeenCalledTimes(1);
  ++markers.attributeRevision;
  search.refreshAttributeSearch();
  await flushPromises();
  expect(api.post).toHaveBeenCalledTimes(2);
  old.resolve({ data: result([]) });
  await flushPromises();
  shapes.upsertRecord(shape("s2"));
  await flushPromises();
  expect(api.post).toHaveBeenCalledTimes(2);
  full.resolve({ data: result(["s1"]) });
  await flushPromises();
  expect(api.post).toHaveBeenCalledTimes(3);
  expect(api.post.mock.calls[2]![1].targets).toEqual([{ target_type: "shape", id: "s2" }]);
  expect(markers.attributeShapeIds).toEqual(new Set(["s1", "s2"]));
});

it("a full read keeps concurrent saves at their previous membership until their own recheck completes", async () => {
  const { markers, shapes, search } = mountSearch();
  shapes.upsertRecord(shape("s1"));
  markers.setAttributeSearch(criteria, result(["s1"]));
  const full = pendingResult(),
    saved = pendingResult();
  api.post.mockReturnValueOnce(full.promise).mockReturnValueOnce(saved.promise);
  search.refreshAttributeSearch();
  shapes.upsertRecord({ ...shape("s1"), updated_at: "2026-10-30T01:00:00Z" });
  await flushPromises();
  full.resolve({ data: result([]) });
  await flushPromises();
  expect(api.post.mock.calls[1]![1].targets).toEqual([{ target_type: "shape", id: "s1" }]);
  expect(markers.attributeShapeIds?.has("s1")).toBe(true);
  expect(markers.filteredShapeIds).toEqual(["s1"]);
  saved.resolve({ data: result([]) });
  await flushPromises();
  expect(markers.attributeShapeIds?.has("s1")).toBe(false);
  expect(markers.filteredShapeIds).toEqual([]);
});

it.each([false, true])(
  "discards a full recheck after criteria are cleared or replaced (replace=%s)",
  async (replace) => {
    const { markers, search } = mountSearch();
    markers.setAttributeSearch(criteria, result([]));
    const full = pendingResult();
    api.post.mockReturnValueOnce(full.promise);
    search.refreshAttributeSearch();
    if (replace)
      markers.setAttributeSearch(
        { ...criteria, common_form_id: "other" },
        { ...result(["keep"]), common_form_id: "other" },
      );
    else markers.setAttributeSearch(null, null);
    full.resolve({ data: result(["old"]) });
    await flushPromises();
    expect(markers.attributeSearch?.common_form_id ?? null).toBe(replace ? "other" : null);
    expect(markers.attributeShapeIds).toEqual(replace ? new Set(["keep"]) : null);
  },
);
