import { createPinia, setActivePinia } from "pinia";
import { shallowMount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  request: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import MapView from "@/views/MapView.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
import * as jsonTransfer from "@/utils/json-transfer";
import { disableTokenUrl, exportJsonUrl } from "@/router/urls";
import { LAST_ACTIVE_LAYER_STORAGE_KEY } from "@/composables/useLastActiveLayer";
import { getLayersUrl, getMasterLayerIdUrl, getMapObjectsUrl, shapesUrl } from "@/router/urls";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const layers = Object.fromEntries(
  ["master", "a", "b"].map((id) => [
    id,
    {
      id,
      layer_name: id,
      user_id: "user",
      is_master: id === "master",
    },
  ]),
);
const marker = (id: string) => ({
  id,
  layer_id: id,
  marker_name: id,
  latitude: 35,
  longitude: 139,
  detail: "",
  update_at: "",
});
const shape = (id: string) => ({
  id,
  layer_id: id,
  shape_type: "circle",
  name: id,
  geojson: {},
  created_at: "",
  updated_at: "",
});
let wrapper: VueWrapper | undefined;
let layerResponse: Promise<{ data: typeof layers }>;
let getMarkers: (id: string) => Promise<{ data: Record<string, ReturnType<typeof marker>> }>;
let getShapes: (id: string) => Promise<{ data: ReturnType<typeof shape>[] }>;

const initializeFrame = vi.fn();
const updateFrame = vi.fn();
const upsertFrame = vi.fn();
const deleteFrame = vi.fn();
const focusFrame = vi.fn();
const filterFrame = vi.fn();
const tileFrame = vi.fn();
const reloadFrame = vi.fn();
const frame = defineComponent({
  name: "MapIframe",
  props: ["srcUrl", "height", "allowedOrigins", "inputPolicies"],
  emits: [
    "mapLoaded",
    "mapObjectChanged",
    "mapReloadRequested",
    "mapDataRequested",
    "mapObjectWriteRequested",
  ],
  setup(_, { expose }) {
    expose({
      initializeMapObjects: initializeFrame,
      upsertMapObject: upsertFrame,
      deleteMapObject: deleteFrame,
      focusObject: focusFrame,
      updateTileOverlays: tileFrame,
      filterMapObjects: filterFrame,
      reloadMapFrame: reloadFrame,
      updateMapObject: updateFrame,
    });
    return () => null;
  },
});
function mountView() {
  wrapper = shallowMount(MapView, {
    global: { provide: { isShowAppHeader: ref(true) }, stubs: { MapIframe: frame } },
  });
  return wrapper;
}
const dataRequests = () =>
  api.get.mock.calls.filter(
    ([url]) => url.startsWith(getMapObjectsUrl) || url.startsWith(shapesUrl),
  );
const frameComponent = () => wrapper!.getComponent({ name: "MapIframe" });
const spinner = () => wrapper!.getComponent({ name: "ProgressSpinner" }).props("isOpen");
const changeLayer = async (id: string) => {
  wrapper!.getComponent({ name: "MapToolbar" }).vm.$emit("update:activeLayer", id);
  await flushPromises();
};

beforeEach(() => {
  initializeFrame.mockReset().mockResolvedValue(true);
  upsertFrame.mockReset().mockResolvedValue(true);
  api.request.mockReset();
  updateFrame.mockReset().mockResolvedValue(true);
  deleteFrame.mockReset().mockResolvedValue(true);
  focusFrame.mockReset();
  filterFrame.mockReset();
  tileFrame.mockReset().mockResolvedValue(true);
  reloadFrame.mockReset().mockReturnValue(true);
  setActivePinia(createPinia());
  localStorage.clear();
  layerResponse = Promise.resolve({ data: layers });
  getMarkers = async (id) => ({ data: { [id]: marker(id) } });
  getShapes = async (id) => ({ data: [shape(id)] });
  api.get.mockImplementation((url: string) => {
    if (url === getLayersUrl) return layerResponse;
    if (url === getMasterLayerIdUrl) return Promise.resolve({ data: { id: "master" } });
    if (url.startsWith(getMapObjectsUrl))
      return getMarkers(new URL(url, window.location.origin).searchParams.get("layer")!);
    if (url.startsWith(shapesUrl))
      return getShapes(new URL(url, window.location.origin).searchParams.get("layer_id")!);
    return Promise.resolve({ data: {} });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it.each([false, true])(
  "re-evaluates restored attribute results after reload failure (prior recheck completed=%s)",
  async (completed) => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    const markers = useMapObjectStore(),
      shapes = useShapeStore();
    const criteria = {
      common_form_id: "form",
      definition_version: 1,
      layer_ids: ["a"],
      conditions: [],
    };
    const empty = {
      common_form_id: "form",
      definition_version: 1,
      as_of: "2026-10-30T00:00:00Z",
      marker_ids: [] as string[],
      shape_ids: [] as string[],
      target_count: 0,
    };
    const matched = { ...empty, shape_ids: ["a"], target_count: 1 };
    markers.setAttributeSearch(criteria, empty);
    await flushPromises();
    const recheck = deferred<{ data: typeof empty }>();
    api.post.mockReturnValueOnce(recheck.promise).mockResolvedValue({ data: matched });
    shapes.upsertRecord({
      ...shape("a"),
      user_id: "user",
      shape_type: "circle",
      updated_at: "2026-10-30T00:00:00Z",
      geojson: {
        type: "Feature",
        properties: { radius: 10 },
        geometry: { type: "Point", coordinates: [139, 35] },
      },
    });
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(1);
    const pendingMarkers = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    const pendingShapes = deferred<{ data: ReturnType<typeof shape>[] }>();
    getMarkers = () => pendingMarkers.promise;
    getShapes = () => pendingShapes.promise;
    frameComponent().vm.$emit("mapReloadRequested");
    await flushPromises();
    if (completed) {
      recheck.resolve({ data: matched });
      await flushPromises();
      expect(markers.attributeShapeIds?.has("a")).toBe(true);
    }
    pendingMarkers.resolve({ data: { a: marker("a") } });
    pendingShapes.reject(Error("offline"));
    await flushPromises();
    expect(markers.attributeSearch?.common_form_id).toBe("form");
    expect(markers.attributeShapeIds?.has("a")).toBe(true);
    expect(markers.filteredShapeIds).toEqual(["a"]);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post.mock.calls[1]![1].targets).toBeUndefined();
    if (!completed) {
      recheck.resolve({ data: empty });
      await flushPromises();
      expect(markers.attributeShapeIds?.has("a")).toBe(true);
    }
  },
);

describe("selected layer startup", () => {
  it("waits for layer metadata before fetching any marker/shape data, then requests only the saved layer", async () => {
    const pending = deferred<{ data: typeof layers }>();
    layerResponse = pending.promise;
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    expect(dataRequests()).toHaveLength(0);
    expect(spinner()).toBe(true);
    expect(frameComponent().props("srcUrl")).toBe("");
    pending.resolve({ data: layers });
    await flushPromises();
    expect(dataRequests()).toHaveLength(2);
    for (const [url] of dataRequests()) {
      expect(new URL(url, window.location.origin).searchParams.get("is_master")).toBe("false");
      expect(
        new URL(url, window.location.origin).searchParams.get("layer") ??
          new URL(url, window.location.origin).searchParams.get("layer_id"),
      ).toBe("a");
    }
    expect(api.get.mock.calls.filter(([url]) => url === getLayersUrl)).toHaveLength(1);
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
    expect(frameComponent().props("srcUrl")).toContain("layer=a&is_master=false");
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    expect(spinner()).toBe(false);
  });

  it.each([null, "deleted", "master"])(
    "uses master for a missing/deleted/master selection (%s)",
    async (saved) => {
      if (saved) localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, saved);
      mountView();
      await flushPromises();
      expect(dataRequests()).toHaveLength(2);
      for (const [url] of dataRequests())
        expect(new URL(url, window.location.origin).searchParams.get("is_master")).toBe("true");
      expect(frameComponent().props("srcUrl")).toContain("layer=master&is_master=true");
      expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("master");
    },
  );

  it("does not fetch all data or keep the spinner open when metadata fails", async () => {
    layerResponse = Promise.reject(new Error("offline"));
    mountView();
    await flushPromises();
    expect(dataRequests()).toHaveLength(0);
    expect(spinner()).toBe(false);
    expect(wrapper!.getComponent({ name: "MessageModal" }).props("message")).toContain("初期情報");
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBeNull();
  });

  it("falls back after a failed saved-layer request and saves only the successful selection", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    const failed = deferred<{ data: ReturnType<typeof shape>[] }>();
    getShapes = (id) => (id === "a" ? failed.promise : Promise.resolve({ data: [shape(id)] }));
    mountView();
    await flushPromises();
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("a");
    expect(frameComponent().props("srcUrl")).toBe("");
    failed.reject(new Error("failed"));
    await flushPromises();
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("master");
    expect([...useShapeStore().shapeList.keys()]).toEqual(["master"]);
  });

  it("shows an error and closes the spinner when master data fails", async () => {
    getShapes = async () => {
      throw new Error("offline");
    };
    mountView();
    await flushPromises();
    expect(spinner()).toBe(false);
    expect(frameComponent().props("srcUrl")).toBe("");
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBeNull();
    expect(wrapper!.getComponent({ name: "MessageModal" }).props("message")).toContain(
      "地図データ",
    );
  });

  it("stops waiting for an old frame when the next layer and its fallback fail", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    expect(spinner()).toBe(true);
    getShapes = async () => {
      throw new Error("offline");
    };
    await changeLayer("b");
    expect(spinner()).toBe(false);
    expect(frameComponent().props("srcUrl")).toContain("layer=a&");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("a");
  });

  it("shares pending data safely across A to B and back to A", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    const firstMarkers = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    const firstShapes = deferred<{ data: ReturnType<typeof shape>[] }>();
    getMarkers = (id) =>
      id === "a" ? firstMarkers.promise : Promise.resolve({ data: { [id]: marker(id) } });
    getShapes = (id) => (id === "a" ? firstShapes.promise : Promise.resolve({ data: [shape(id)] }));
    mountView();
    await flushPromises();
    await changeLayer("b");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["b"]);
    firstMarkers.resolve({ data: { a: marker("a") } });
    firstShapes.resolve({ data: [shape("a")] });
    await flushPromises();
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["b"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["b"]);
    await changeLayer("a");
    expect(dataRequests()).toHaveLength(4);
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
    const latestUrl = frameComponent().props("srcUrl");
    frameComponent().vm.$emit("mapLoaded", "old-map-url");
    await flushPromises();
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", latestUrl);
    await flushPromises();
    expect(spinner()).toBe(false);
  });

  it("レイヤの制限設定を地図へ渡し、変更しても地図やデータを再取得しない", async () => {
    mountView();
    await flushPromises();
    const src = frameComponent().props("srcUrl");
    const count = dataRequests().length;
    expect(frameComponent().props("inputPolicies")).toEqual({ master: false, a: false, b: false });
    useLayersStore().layersList.get("a")!.restrict_free_text = true;
    await flushPromises();
    expect(frameComponent().props("inputPolicies")).toEqual({ master: false, a: true, b: false });
    expect(frameComponent().props("srcUrl")).toBe(src);
    expect(dataRequests()).toHaveLength(count);
    useLayersStore().layersList.get("a")!.restrict_free_text = false;
    await flushPromises();
    expect(frameComponent().props("inputPolicies")).toEqual({ master: false, a: false, b: false });
  });
  it("回答編集の保存結果を表示中のオブジェクトと地図へ反映する", async () => {
    mountView();
    await flushPromises();
    const object = { ...marker("master"), detail: "修正後の本文" };
    window.dispatchEvent(new CustomEvent("geocode-answer-updated", { detail: object }));
    await flushPromises();
    expect(useMapObjectStore().mapObjectList.get("master")?.detail).toBe("修正後の本文");
    expect(updateFrame).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: "marker", id: "master", detail: "修正後の本文" }),
    );
    window.dispatchEvent(
      new CustomEvent("geocode-answer-updated", {
        detail: { ...marker("hidden"), detail: "別レイヤ" },
      }),
    );
    await flushPromises();
    expect(useMapObjectStore().mapObjectList.has("hidden")).toBe(false);
  });

  it.each(["master", "a"])(
    "JSON取込後は選択中の %s の範囲で両一覧と同じURLの地図を更新する",
    async (selected) => {
      localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, selected);
      mountView();
      await flushPromises();
      const initialRequests = dataRequests().length;
      getMarkers = async (id) => ({ data: { fresh: { ...marker("fresh"), layer_id: id } } });
      getShapes = async (id) => ({ data: [{ ...shape("fresh"), layer_id: id }] });
      wrapper!.getComponent({ name: "JsonImportModal" }).vm.$emit("imported");
      await flushPromises();
      expect(dataRequests()).toHaveLength(initialRequests + 2);
      for (const [url] of dataRequests().slice(initialRequests)) {
        const params = new URL(url, window.location.origin).searchParams;
        expect(params.get("is_master")).toBe(String(selected === "master"));
        expect(params.get("layer") ?? params.get("layer_id")).toBe(selected);
      }
      expect(api.get.mock.calls.filter(([url]) => url === getLayersUrl)).toHaveLength(2);
      expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["fresh"]);
      expect([...useShapeStore().shapeList.keys()]).toEqual(["fresh"]);
      expect(reloadFrame).toHaveBeenCalledTimes(1);
      expect(wrapper!.getComponent({ name: "MapToolbar" }).props("activeLayer")).toBe(selected);
      expect(wrapper!.getComponent({ name: "MessageModal" }).props("message")).toBe(
        "データのインポートが完了しました。",
      );
    },
  );

  it("JSON取込後の再取得失敗を取込失敗にせず、表示の再試行だけで回復する", async () => {
    mountView();
    await flushPromises();
    getShapes = async () => {
      throw new Error("offline");
    };
    const modal = wrapper!.getComponent({ name: "JsonImportModal" });
    modal.vm.$emit("imported");
    await flushPromises();
    expect(modal.props("syncFailed")).toBe(true);
    expect(wrapper!.getComponent({ name: "MessageModal" }).props("message")).toContain(
      "インポートは完了しましたが",
    );
    expect(frameComponent().props("srcUrl")).toContain("layer=master&");
    expect([...useShapeStore().shapeList.keys()]).toEqual(["master"]);
    getShapes = async () => ({ data: [shape("recovered")] });
    modal.vm.$emit("retrySync");
    await flushPromises();
    expect(modal.props("syncFailed")).toBe(false);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["recovered"]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("JSON送信終了の通知で表示同期中のスピナーを消さない", async () => {
    mountView();
    await flushPromises();
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    const pending = deferred<{ data: ReturnType<typeof shape>[] }>();
    getShapes = () => pending.promise;
    const modal = wrapper!.getComponent({ name: "JsonImportModal" });
    modal.vm.$emit("showProgress", true);
    modal.vm.$emit("imported");
    modal.vm.$emit("showProgress", false);
    await flushPromises();
    expect(spinner()).toBe(true);
    expect(modal.props("syncBusy")).toBe(true);
    pending.resolve({ data: [shape("fresh")] });
    await flushPromises();
    expect(modal.props("syncBusy")).toBe(false);
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    expect(spinner()).toBe(false);
  });
});

describe("cached map data and mutation synchronization", () => {
  it("supplies the same initial records to the parent-mode map and reuses a visited layer", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    expect(new URL(frameComponent().props("srcUrl")).searchParams.get("data_source")).toBe(
      "parent",
    );
    expect(initializeFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        markers: { a: marker("a") },
        shapes: [shape("a")],
        scopeKey: "a",
      }),
    );
    await changeLayer("b");
    expect(dataRequests()).toHaveLength(4);
    await changeLayer("a");
    expect(dataRequests()).toHaveLength(4);
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
  });

  it("applies map additions and deletions to the original records without fetching either list", async () => {
    mountView();
    await flushPromises();
    const count = dataRequests().length;
    const acknowledge = vi.fn();
    const added = { ...marker("new"), layer_id: "master" };
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "upsert",
        objectType: "marker",
        object: added,
        mutationId: "add-1",
      },
      acknowledge,
    );
    await flushPromises();
    expect(acknowledge).toHaveBeenCalledWith(true);
    expect(useMapObjectStore().getById("new")).toEqual(added);
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "delete",
        objectType: "shape",
        id: "master",
        mutationId: "delete-1",
      },
      acknowledge,
    );
    await flushPromises();
    expect(useShapeStore().getById("master")).toBeUndefined();
    expect(dataRequests()).toHaveLength(count);
    // 通知を再試行しても安全であり、サーバーの更新処理は繰り返さない。
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "delete",
        objectType: "shape",
        id: "master",
        mutationId: "delete-1",
      },
      acknowledge,
    );
    await flushPromises();
    expect(dataRequests()).toHaveLength(count);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("re-supplies cached records after a map update failure without fetching the lists", async () => {
    mountView();
    await flushPromises();
    const count = dataRequests().length;
    updateFrame.mockResolvedValueOnce(false);
    const object = { ...marker("master"), detail: "保存済みの本文" };
    window.dispatchEvent(new CustomEvent("geocode-answer-updated", { detail: object }));
    await flushPromises();
    expect(initializeFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        markers: { master: object },
      }),
    );
    expect(dataRequests()).toHaveLength(count);
  });
});

describe("map lifecycle while data changes", () => {
  it("uses the latest original records when the iframe asks to initialize again", async () => {
    mountView();
    await flushPromises();
    const requests = dataRequests().length;
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "delete",
        objectType: "shape",
        id: "master",
        mutationId: "gone",
      },
      vi.fn(),
    );
    frameComponent().vm.$emit("mapDataRequested");
    await flushPromises();
    expect(initializeFrame).toHaveBeenLastCalledWith(expect.objectContaining({ shapes: [] }));
    expect(dataRequests()).toHaveLength(requests);
  });

  it("restores the previous cached scope and URL if the new iframe cannot apply data", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    initializeFrame.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await changeLayer("b");
    expect(frameComponent().props("srcUrl")).toContain("layer=a&");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
    expect(dataRequests()).toHaveLength(4);
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("a");
  });

  it("retains a saved change from the visible old map when the next scope fetch fails", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    const pending = deferred<{ data: ReturnType<typeof shape>[] }>();
    getShapes = (id) => (id === "b" ? pending.promise : Promise.resolve({ data: [shape(id)] }));
    await changeLayer("b");
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "upsert",
        objectType: "marker",
        object: { ...marker("added"), layer_id: "a" },
        mutationId: "during-fetch",
      },
      vi.fn(),
    );
    await flushPromises();
    pending.reject(new Error("offline"));
    await flushPromises();
    expect(frameComponent().props("srcUrl")).toContain("layer=a&");
    expect(useMapObjectStore().mapObjectList.has("added")).toBe(true);
    expect(dataRequests()).toHaveLength(4);
  });

  it("finishes a parent-owned save after its source map has been replaced", async () => {
    mountView();
    await flushPromises();
    const pending = deferred<{ status: number; data: unknown }>();
    api.request.mockReturnValue(pending.promise);
    const reply = vi.fn();
    frameComponent().vm.$emit(
      "mapObjectWriteRequested",
      {
        url: "/marker?layer_id=master&latitude=35&longitude=139",
        method: "POST",
        requestId: "write-old-frame",
      },
      reply,
    );
    await flushPromises();
    await changeLayer("a");
    const saved = { ...marker("saved"), layer_id: "master", update_at: "2026-10-27T00:00:00" };
    pending.resolve({ status: 201, data: { id: "saved", message: "Created", object: saved } });
    await flushPromises();
    expect(useMapObjectStore().getById("saved")).toEqual(saved);
    expect(useMapObjectStore().mapObjectList.has("saved")).toBe(false);
    expect(api.request).toHaveBeenCalledTimes(1);
    await changeLayer("master");
    expect(useMapObjectStore().mapObjectList.has("saved")).toBe(true);
    expect(dataRequests()).toHaveLength(2);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ status: 201 }));
  });

  it("updates search matches locally after a map mutation", async () => {
    mountView();
    await flushPromises();
    api.get.mockResolvedValueOnce({ data: { markers: {}, shape_ids: [] } });
    await useMapObjectStore().queryWordMapObject("needle", "", "master");
    const requests = api.get.mock.calls.length;
    const added = { ...marker("matching"), layer_id: "master", marker_name: "needle" };
    frameComponent().vm.$emit(
      "mapObjectChanged",
      { operation: "upsert", objectType: "marker", object: added, mutationId: "match" },
      vi.fn(),
    );
    await flushPromises();
    expect(useMapObjectStore().mapObjectList.has("matching")).toBe(true);
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "upsert",
        objectType: "marker",
        object: { ...added, marker_name: "other" },
        mutationId: "unmatch",
      },
      vi.fn(),
    );
    await flushPromises();
    expect(useMapObjectStore().mapObjectList.has("matching")).toBe(false);
    expect(api.get.mock.calls).toHaveLength(requests);
  });
});

describe("search responses during layer navigation", () => {
  it("restores server text matches after a failed reload without changing database case folding", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    const record = { ...marker("a"), marker_name: "Ａ地点" };
    getMarkers = async () => ({ data: { a: record } });
    mountView();
    await flushPromises();
    api.get.mockResolvedValueOnce({ data: { markers: {}, shape_ids: [] } });
    wrapper!
      .getComponent({ name: "MapToolbar" })
      .vm.$emit("mapObjectSearch", { query1: "ａ", query2: "" }, false);
    await flushPromises();
    const markers = useMapObjectStore();
    expect(markers.mapObjectList.size).toBe(0);
    getShapes = async () => {
      throw Error("offline");
    };
    frameComponent().vm.$emit("mapReloadRequested");
    await flushPromises();
    expect(markers.search?.query1).toBe("ａ");
    expect(markers.mapObjectList.size).toBe(0);
    markers.setAttributeSearch(
      {
        common_form_id: "form",
        definition_version: 1,
        layer_ids: ["a"],
        conditions: [],
      },
      {
        common_form_id: "form",
        definition_version: 1,
        as_of: "2026-10-30T00:00:00Z",
        marker_ids: ["a"],
        shape_ids: [],
        target_count: 1,
      },
    );
    expect(markers.mapObjectList.size).toBe(0);
    markers.setAttributeSearch(null, null);
    expect(markers.mapObjectList.size).toBe(0);
  });
  it("does not restore another layer with the previous layer's delayed query", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    const pending = deferred<{
      data: { markers: Record<string, ReturnType<typeof marker>>; shape_ids: string[] };
    }>();
    api.get.mockReturnValueOnce(pending.promise);
    wrapper!
      .getComponent({ name: "MapToolbar" })
      .vm.$emit("mapObjectSearch", { query1: "old query", query2: "" }, false);
    await flushPromises();
    await changeLayer("b");
    pending.resolve({ data: { markers: {}, shape_ids: [] } });
    await flushPromises();
    getShapes = async () => {
      throw new Error("offline");
    };
    await changeLayer("a");
    expect(frameComponent().props("srcUrl")).toContain("layer=a&");
    // A はキャッシュ済みのため、取得できない新しい範囲を指定し、以前の表示への復元を検証する。
    await changeLayer("b");
    useMapObjectStore().invalidateCache();
    useShapeStore().invalidateCache();
    await changeLayer("a");
    expect(frameComponent().props("srcUrl")).toContain("layer=b&");
    expect(useMapObjectStore().search).toBeNull();
    expect(useMapObjectStore().mapObjectList.has("b")).toBe(true);
  });
});

describe("map account boundary", () => {
  it("removes the previous account's map and rejects its delayed writes after logout", async () => {
    mountView();
    await flushPromises();
    const count = dataRequests().length;
    useAuthStore().logout();
    await flushPromises();
    expect(frameComponent().props("srcUrl")).toBe("");
    expect(useMapObjectStore().getById("master")).toBeUndefined();
    const reply = vi.fn();
    frameComponent().vm.$emit(
      "mapObjectWriteRequested",
      { url: "/shape", method: "POST", body: {}, requestId: "old-user" },
      reply,
    );
    await flushPromises();
    expect(api.request).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(dataRequests()).toHaveLength(count);
  });
});

describe("delayed answer results from another scope", () => {
  it("updates the cached old record without adding its marker to the current map", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    await changeLayer("b");
    const count = dataRequests().length;
    updateFrame.mockClear();
    window.dispatchEvent(
      new CustomEvent("geocode-answer-updated", {
        detail: { ...marker("a"), detail: "saved after navigation" },
      }),
    );
    await flushPromises();
    expect(useMapObjectStore().getById("a")?.detail).toBe("saved after navigation");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["b"]);
    expect(updateFrame).not.toHaveBeenCalled();
    expect(dataRequests()).toHaveLength(count);
  });
});

describe("table visibility without reloading the map", () => {
  it("suspends/reopens the table without replacing the iframe or fetching map records", async () => {
    mountView();
    await flushPromises();
    const frameVm = frameComponent().vm;
    const source = frameComponent().props("srcUrl");
    const requests = dataRequests().length;
    const initializations = initializeFrame.mock.calls.length;
    const reloads = reloadFrame.mock.calls.length;
    const table = () => wrapper!.getComponent({ name: "MapObjectTable" });
    expect(table().props("active")).toBe(true);
    await wrapper!.get(".map-object-table-toggle").trigger("click");
    expect(table().props("active")).toBe(false);
    await wrapper!.get(".map-object-table-toggle").trigger("click");
    expect(table().props("active")).toBe(true);
    await flushPromises();
    expect(frameComponent().vm).toBe(frameVm);
    expect(frameComponent().props("srcUrl")).toBe(source);
    expect(dataRequests()).toHaveLength(requests);
    expect(initializeFrame).toHaveBeenCalledTimes(initializations);
    expect(reloadFrame).toHaveBeenCalledTimes(reloads);
  });
});

const OPERATIONS_MOBILE = false;

// 実際の Pinia ストアと再現可能なテストデータを使い、親子間の取り決めを検証する。
const insertMarkdown = vi.fn();
const refreshShared = vi.fn();
const initializeShared = vi.fn();
const initializeLayerList = vi.fn();
const operationStub = (name: string, props: string[], methods: Record<string, unknown>) =>
  defineComponent({
    name,
    props,
    setup(_, { expose }) {
      expose(methods);
      return () => null;
    },
  });
const operationComponent = (name: string) => wrapper!.getComponent({ name });
const operationMessage = () => operationComponent("MessageModal").props("message");
const layerConfirmation = () => wrapper!.findAllComponents({ name: "ConfirmModal" })[0]!;
async function operationsReady(extraStubs: Record<string, unknown> = {}, attached = false) {
  localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
  wrapper = shallowMount(MapView, {
    attachTo: attached ? document.body : undefined,
    global: {
      provide: { isShowAppHeader: ref(true), showSplashScreen: ref(false) },
      stubs: {
        MapIframe: frame,
        LayerListModal: operationStub("LayerListModal", ["isOpen"], {
          initSearch: initializeLayerList,
          handleOpen: initializeLayerList,
        }),
        OnetimeSettingModal: operationStub("OnetimeSettingModal", ["isOpen", "layerList"], {
          initRows: initializeShared,
          copiedLayer: initializeShared,
          fetchCurrentSharedUrl: refreshShared,
        }),
        MapObjectEditModal: operationStub(
          "MapObjectEditModal",
          ["isOpen", "targetType", "targetId", "layerList", "isHttpsProtocol"],
          { insertUploadedMarkdown: insertMarkdown },
        ),
        ...extraStubs,
      },
    },
  });
  await flushPromises();
  frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
  await flushPromises();
  expect(spinner()).toBe(false);
}
async function requestLayerDeletion() {
  operationComponent("LayerListModal").vm.$emit(
    OPERATIONS_MOBILE ? "delete" : "deleteLayer",
    "a",
    "a",
  );
  await flushPromises();
  expect(layerConfirmation().props("isOpen")).toBe(true);
  expect(layerConfirmation().props("message")).toContain("a");
}

describe("地図画面のレイヤ・編集・共有操作", () => {
  it.each(["rename", "deleteLayer"])(
    "masterレイヤの危険な操作を確認前に拒否する: %s",
    async (event) => {
      await operationsReady();
      const remove = vi.spyOn(useLayersStore(), "deleteLayer");
      operationComponent("LayerListModal").vm.$emit(event, "master", "master");
      await flushPromises();
      expect(remove).not.toHaveBeenCalled();
      expect(layerConfirmation().props("isOpen")).toBe(false);
      expect(operationComponent("LayerRenameModal").props("isOpen")).toBe(false);
      expect(operationMessage()).toBe(
        event === "rename"
          ? "masterレイヤは名前を変更できません。"
          : "masterレイヤは削除できません。",
      );
    },
  );

  it("地図の読取専用プレビューから一覧削除へ移ると削除対象と権限を更新する", async () => {
    await operationsReady();
    frameComponent().vm.$emit("previewImage", "public.png");
    await flushPromises();
    const preview = operationComponent("ImagePreviewModal");
    expect(preview.props()).toMatchObject({
      isOpen: true,
      imageFilename: "public.png",
      imageId: "",
      readOnly: true,
    });
    operationComponent("ImageListModal").vm.$emit("deleteRequest", "own-image-id");
    await flushPromises();
    expect(preview.props()).toMatchObject({
      isOpen: true,
      imageFilename: "",
      imageId: "own-image-id",
      readOnly: false,
    });
  });

  it("削除の取消ではAPIも一覧も変更しない", async () => {
    await operationsReady();
    const remove = vi.spyOn(useLayersStore(), "deleteLayer");
    await requestLayerDeletion();
    layerConfirmation().vm.$emit("cancel");
    await flushPromises();
    expect(layerConfirmation().props("isOpen")).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(operationComponent("MapToolbar").props("activeLayer")).toBe("a");
    expect(useLayersStore().layersList.has("a")).toBe(true);
  });

  it("削除失敗では選択・表示データを保持し、成功通知を出さない", async () => {
    await operationsReady();
    const remove = vi.spyOn(useLayersStore(), "deleteLayer").mockResolvedValue(false);
    const reload = vi.spyOn(useLayersStore(), "initList");
    const requests = dataRequests().length;
    await requestLayerDeletion();
    layerConfirmation().vm.$emit("confirm");
    await flushPromises();
    expect(remove).toHaveBeenCalledExactlyOnceWith("a");
    expect(reload).not.toHaveBeenCalled();
    expect(dataRequests()).toHaveLength(requests);
    expect(operationComponent("MapToolbar").props("activeLayer")).toBe("a");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect(useLayersStore().layersList.has("a")).toBe(true);
    expect(operationMessage()).toBe("a を削除できませんでした。");
    expect(spinner()).toBe(false);
  });

  it("削除と再取得が完了した場合だけ成功を通知し、masterへ戻す", async () => {
    await operationsReady();
    vi.spyOn(useLayersStore(), "deleteLayer").mockResolvedValue(true);
    layerResponse = Promise.resolve({ data: { master: layers.master!, b: layers.b! } });
    await requestLayerDeletion();
    layerConfirmation().vm.$emit("confirm");
    await flushPromises();
    expect(operationMessage()).toBe("a を削除しました。");
    expect(operationComponent("MapToolbar").props("activeLayer")).toBe("master");
    expect(useLayersStore().layersList.has("a")).toBe(false);
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("master");
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["master"]);
  });

  it.each(["objects", "layers"])("削除後の同期失敗を削除失敗と区別する: %s", async (failure) => {
    await operationsReady();
    const remove = vi.spyOn(useLayersStore(), "deleteLayer").mockResolvedValue(true);
    const reload = vi.spyOn(useLayersStore(), "initList");
    if (failure === "objects")
      getShapes = async () => {
        throw new Error("offline");
      };
    else reload.mockResolvedValue(false);
    await requestLayerDeletion();
    layerConfirmation().vm.$emit("confirm");
    await flushPromises();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(operationMessage()).toBe(
      "a は削除されましたが、画面の同期に失敗しました。再読み込みしてください。",
    );
    expect(reload).toHaveBeenCalledTimes(failure === "objects" ? 0 : 1);
    expect(layerConfirmation().props("isOpen")).toBe(false);
  });

  it("削除処理中の二重確認でAPIを重複送信しない", async () => {
    await operationsReady();
    const pending = deferred<boolean>();
    const remove = vi.spyOn(useLayersStore(), "deleteLayer").mockReturnValue(pending.promise);
    await requestLayerDeletion();
    layerConfirmation().vm.$emit("confirm");
    layerConfirmation().vm.$emit("confirm");
    await flushPromises();
    expect(remove).toHaveBeenCalledTimes(1);
    pending.resolve(false);
    await flushPromises();
    expect(operationMessage()).toBe("a を削除できませんでした。");
  });

  it("名前変更の対象IDと名前を渡し、閉じる操作を反映する", async () => {
    await operationsReady();
    operationComponent("LayerListModal").vm.$emit("rename", "a", "現場レイヤ");
    await flushPromises();
    const modal = operationComponent("LayerRenameModal");
    expect(modal.props()).toMatchObject({ isOpen: true, layerId: "a", currentName: "現場レイヤ" });
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props("isOpen")).toBe(false);
  });

  it.each(["marker", "shape"])("編集対象を渡し、終了後に対象IDを残さない: %s", async (type) => {
    await operationsReady();
    operationComponent("MapObjectTable").vm.$emit("editObject", type, "target-id");
    await flushPromises();
    const modal = operationComponent("MapObjectEditModal");
    expect(modal.props()).toMatchObject({ isOpen: true, targetType: type, targetId: "target-id" });
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props()).toMatchObject({ isOpen: false, targetId: "" });
  });

  it("アップロード画像を編集中のオブジェクトにだけ挿入する", async () => {
    await operationsReady();
    const upload = operationComponent("ImageUploadModal");
    upload.vm.$emit("uploaded", "![画像](https://example.test/file.png)", "file");
    await flushPromises();
    expect(insertMarkdown).not.toHaveBeenCalled();
    operationComponent("MapObjectTable").vm.$emit("editObject", "marker", "a");
    await flushPromises();
    upload.vm.$emit("uploaded", "![画像](https://example.test/file.png)", "file");
    await flushPromises();
    expect(insertMarkdown).toHaveBeenCalledExactlyOnceWith(
      "![画像](https://example.test/file.png)",
    );
  });

  it("画像一覧から正しいファイルとIDをプレビューへ渡す", async () => {
    await operationsReady();
    operationComponent("ImageListModal").vm.$emit("preview", "photo.png", "image-id");
    await flushPromises();
    const modal = operationComponent("ImagePreviewModal");
    expect(modal.props("isOpen")).toBe(true);
    expect(modal.props("imageId")).toBe("image-id");
    expect(modal.props(OPERATIONS_MOBILE ? "imageSrc" : "imageFilename")).toBe("photo.png");
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props("isOpen")).toBe(false);
  });

  it("PDFは別ウィンドウで開き、画像プレビューを表示しない", async () => {
    await operationsReady();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    operationComponent("ImageListModal").vm.$emit("preview", "document.pdf", "pdf-id");
    await flushPromises();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("/static/images/document.pdf"),
      "_blank",
      "noopener noreferrer",
    );
    expect(operationComponent("ImagePreviewModal").props("isOpen")).toBe(false);
  });

  it("生成した共有情報を表示し、無効化後に情報を消して現在値を再取得する", async () => {
    await operationsReady();
    const settings = operationComponent("OnetimeSettingModal");
    const expiry = "2026-12-01 00:00:00"; // ペイロード用のテストデータであり、実際の時計とは比較しない。
    settings.vm.$emit("generated", "https://example.test/share/id", "share-id", false, expiry);
    await flushPromises();
    const modal = operationComponent("OnetimeUrlModal");
    expect(modal.props()).toMatchObject({
      isOpen: true,
      url: "https://example.test/share/id",
      uuid: "share-id",
      expiration: expiry,
    });
    modal.vm.$emit("invalidated");
    await flushPromises();
    expect(modal.props()).toMatchObject({ isOpen: false, url: "", uuid: "", expiration: "" });
    expect(refreshShared).toHaveBeenCalledTimes(1);
  });

  it("子画面のメッセージを表示し、閉じると内容を消す", async () => {
    await operationsReady();
    operationComponent("LayerRenameModal").vm.$emit("message", "名前を更新しました。");
    await flushPromises();
    const modal = operationComponent("MessageModal");
    expect(modal.props()).toMatchObject({ isOpen: true, message: "名前を更新しました。" });
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props()).toMatchObject({ isOpen: false, message: "" });
  });
});

describe("保存済みオブジェクトの地図反映と復旧", () => {
  afterEach(() => vi.unstubAllGlobals());
  const markerChange = (layerId = "a") => ({
    objectType: "marker",
    id: "a",
    layerId,
    name: "更新済み",
    detail: "保存済みの本文",
    latitude: 36,
    longitude: 140,
  });
  const shapeRecord = () => ({
    ...shape("a"),
    user_id: "user",
    updated_at: "2026-01-01T00:00:00Z",
    geojson: {
      type: "Feature",
      properties: { radius: 10 },
      geometry: { type: "Point", coordinates: [140, 36] },
    },
  });

  it("保存後のマーカーを差分反映してフォーカスし、一覧を再取得しない", async () => {
    await operationsReady();
    const requests = dataRequests().length;
    const payload = markerChange();
    operationComponent("MapObjectEditModal").vm.$emit("updated", payload, "a");
    await flushPromises();
    expect(updateFrame).toHaveBeenCalledExactlyOnceWith(payload);
    expect(focusFrame).toHaveBeenCalledExactlyOnceWith("marker", "a", 36, 140);
    expect(dataRequests()).toHaveLength(requests);
  });

  it("図形の保存後は原本から中心座標を求めてフォーカスする", async () => {
    await operationsReady();
    const record = shapeRecord();
    useShapeStore().upsertRecord(record);
    const payload = {
      objectType: "shape",
      id: "a",
      layerId: "a",
      shapeType: "circle",
      name: "円",
      geojson: record.geojson,
    };
    operationComponent("MapObjectEditModal").vm.$emit("updated", payload, "a");
    await flushPromises();
    expect(updateFrame).toHaveBeenCalledExactlyOnceWith(payload);
    expect(focusFrame).toHaveBeenCalledExactlyOnceWith("shape", "a", 36, 140);
  });

  it("原本のない図形では位置を推測してフォーカスしない", async () => {
    await operationsReady();
    operationComponent("MapObjectEditModal").vm.$emit(
      "updated",
      {
        objectType: "shape",
        id: "missing",
        layerId: "a",
        shapeType: "circle",
        name: "",
        geojson: {},
      },
      "a",
    );
    await flushPromises();
    expect(updateFrame).toHaveBeenCalledTimes(1);
    expect(focusFrame).not.toHaveBeenCalled();
  });

  it("別レイヤに移したマーカーへ切り替え、保存済み座標をURLへ引き継ぐ", async () => {
    await operationsReady();
    const payload = markerChange("b");
    operationComponent("MapObjectEditModal").vm.$emit("updated", payload, "a");
    await flushPromises();
    expect(operationComponent("MapToolbar").props("activeLayer")).toBe("b");
    const params = new URL(frameComponent().props("srcUrl"), window.location.origin).searchParams;
    expect(params.get("layer")).toBe("b");
    expect(params.get("marker_id")).toBe("a");
    expect(params.get("latitude")).toBe("36");
    expect(params.get("longitude")).toBe("140");
    expect(updateFrame).not.toHaveBeenCalled();
  });

  it("別レイヤに属する更新で現在の地図を差分更新・再取得しない", async () => {
    await operationsReady();
    const requests = dataRequests().length;
    const source = frameComponent().props("srcUrl");
    operationComponent("MapObjectEditModal").vm.$emit("updated", markerChange("b"), "b");
    await flushPromises();
    expect(updateFrame).not.toHaveBeenCalled();
    expect(focusFrame).not.toHaveBeenCalled();
    expect(frameComponent().props("srcUrl")).toBe(source);
    expect(dataRequests()).toHaveLength(requests);
  });

  it("差分描画が失敗したら保存済み原本を再送し、保存APIを再実行しない", async () => {
    await operationsReady();
    const saved = {
      ...marker("a"),
      user_id: "user",
      latitude: 36,
      longitude: 140,
      detail: "保存済みの本文",
      update_at: "2026-01-01T00:00:00Z",
    };
    useMapObjectStore().upsertRecord(saved);
    const requests = dataRequests().length;
    updateFrame.mockResolvedValueOnce(false);
    initializeFrame.mockClear();
    operationComponent("MapObjectEditModal").vm.$emit("updated", markerChange(), "a");
    await flushPromises();
    expect(initializeFrame).toHaveBeenCalledWith(
      expect.objectContaining({ markers: { a: saved } }),
    );
    expect(dataRequests()).toHaveLength(requests);
    expect(api.request).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("master表示では別レイヤへの移動後も選択を変えず更新する", async () => {
    await operationsReady();
    await changeLayer("master");
    updateFrame.mockClear();
    operationComponent("MapObjectEditModal").vm.$emit("updated", markerChange("b"), "a");
    await flushPromises();
    expect(operationComponent("MapToolbar").props("activeLayer")).toBe("master");
    expect(updateFrame).toHaveBeenCalledExactlyOnceWith(markerChange("b"));
  });

  it("一覧のフォーカス操作を地図へ送り、座標を正確にコピーする", async () => {
    await operationsReady();
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: navigator.userAgent, clipboard: { writeText: copy } });
    operationComponent("MapObjectTable").vm.$emit("focusObject", "marker", "a", 35.5, 139.25);
    await flushPromises();
    expect(focusFrame).toHaveBeenCalledExactlyOnceWith("marker", "a", 35.5, 139.25);
    expect(copy).toHaveBeenCalledExactlyOnceWith("35.5,139.25");
  });

  it.each([true, false])("タイル設定の差分反映結果に応じて再描画する: %s", async (updated) => {
    await operationsReady();
    tileFrame.mockResolvedValueOnce(updated);
    reloadFrame.mockClear();
    const tiles = [{ id: "tile", url: "https://example.test/{z}/{x}/{y}.png" }];
    operationComponent("LayerCreateModal").vm.$emit("tilesChanged", tiles);
    await flushPromises();
    expect(tileFrame).toHaveBeenCalledExactlyOnceWith(tiles);
    expect(reloadFrame).toHaveBeenCalledTimes(updated ? 0 : 1);
  });
});

describe("削除後の描画復旧", () => {
  const removeFromView = async () => {
    if (OPERATIONS_MOBILE) operationComponent("MapObjectTable").vm.$emit("deleteMarker", "a");
    else {
      // サーバー上の削除は PC 版の編集画面が管理し、成功した後にのみイベントを発行する。
      useMapObjectStore().removeRecord("a");
      operationComponent("MapObjectEditModal").vm.$emit("deleted", "a");
    }
    await flushPromises();
  };
  beforeEach(() => {
    if (OPERATIONS_MOBILE) api.delete.mockResolvedValue({});
  });

  it("削除済みマーカーを地図から除去し、一覧を再取得しない", async () => {
    await operationsReady();
    const requests = dataRequests().length;
    await removeFromView();
    expect(deleteFrame).toHaveBeenCalledExactlyOnceWith("a");
    expect(useMapObjectStore().getById("a")).toBeUndefined();
    expect(operationMessage()).toBe("削除しました。");
    expect(dataRequests()).toHaveLength(requests);
  });

  it("差分削除が失敗したら原本を再送し、削除済みマーカーを復元しない", async () => {
    await operationsReady();
    deleteFrame.mockResolvedValueOnce(false);
    initializeFrame.mockClear();
    const requests = dataRequests().length;
    await removeFromView();
    expect(initializeFrame).toHaveBeenCalledWith(expect.objectContaining({ markers: {} }));
    expect(useMapObjectStore().getById("a")).toBeUndefined();
    expect(operationMessage()).toBe("削除しました。");
    expect(dataRequests()).toHaveLength(requests);
  });

  it.each(["false", "rejection"])(
    "復旧も失敗した場合は削除完了と同期失敗を区別する: %s",
    async (failure) => {
      await operationsReady();
      if (failure === "false") {
        deleteFrame.mockResolvedValueOnce(false);
        initializeFrame.mockResolvedValueOnce(false);
      } else deleteFrame.mockRejectedValueOnce(new Error("frame unavailable"));
      await removeFromView();
      expect(useMapObjectStore().getById("a")).toBeUndefined();
      expect(operationMessage()).toBe(
        "マーカーは削除されましたが、地図の同期に失敗しました。再読み込みしてください。",
      );
    },
  );
});

describe("JSON出力のダウンロードと失敗後の再試行", () => {
  const createUrl = vi.fn();
  const revokeUrl = vi.fn();
  const downloads: { href: string; name: string; connected: boolean }[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    downloads.length = 0;
    createUrl.mockReturnValue("blob:https://example.test/export");
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, name: this.download, connected: this.isConnected });
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const exportNow = async () => {
    operationComponent("MapToolbar").vm.$emit("exportJson");
    await flushPromises();
  };

  it("選択レイヤのBlobを正しい名前でダウンロードし、60000ms後にURLを解放する", async () => {
    await operationsReady();
    const blob = new Blob(['{"version":3,"n":9007199254740993}'], { type: "application/json" });
    const fetch = vi.spyOn(jsonTransfer, "fetchJsonExport").mockResolvedValueOnce(blob);
    await exportNow();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${exportJsonUrl}a`);
    expect(createUrl).toHaveBeenCalledExactlyOnceWith(blob);
    expect(downloads).toEqual([
      { href: "blob:https://example.test/export", name: "export_a_v3.json", connected: true },
    ]);
    expect(document.querySelector('a[download="export_a_v3.json"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(59999);
    expect(revokeUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:https://example.test/export");
  });

  it("出力待ち中の重複操作を抑止し、完了後は再実行できる", async () => {
    await operationsReady();
    const pending = deferred<Blob>();
    const fetch = vi
      .spyOn(jsonTransfer, "fetchJsonExport")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(new Blob(["{}"]));
    await exportNow();
    await exportNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveLength(0);
    pending.resolve(new Blob(["{}"]));
    await flushPromises();
    await exportNow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(downloads).toHaveLength(2);
  });

  it.each([
    [400, { error: "出力対象がありません。" }, "出力対象がありません。"],
    [413, { error: "出力上限を超えています。" }, "出力上限を超えています。"],
    [400, {}, "JSONを出力できませんでした。"],
    [500, {}, "JSONを出力できませんでした。再試行してください。"],
  ])("APIエラーではダウンロードせず、失敗後に再試行できる: %s", async (status, data, message) => {
    await operationsReady();
    api.isAxiosError.mockReturnValue(true);
    const fetch = vi
      .spyOn(jsonTransfer, "fetchJsonExport")
      .mockRejectedValueOnce({ response: { status, data } })
      .mockResolvedValue(new Blob(["{}"]));
    await exportNow();
    expect(operationMessage()).toBe(message);
    expect(createUrl).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
    await exportNow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(downloads).toHaveLength(1);
  });

  it("非Axiosの失敗でも利用者に通知し、再実行できる", async () => {
    await operationsReady();
    const fetch = vi
      .spyOn(jsonTransfer, "fetchJsonExport")
      .mockRejectedValueOnce(new Error("download unavailable"))
      .mockResolvedValue(new Blob(["{}"]));
    await exportNow();
    expect(operationMessage()).toBe("JSONを出力できませんでした。再試行してください。");
    expect(downloads).toHaveLength(0);
    await exportNow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(downloads).toHaveLength(1);
  });

  it("401応答で認証を解除し、ログアウトAPIを呼んでダウンロードしない", async () => {
    await operationsReady();
    expect(useAuthStore().isAuthenticated).toBe(true);
    api.isAxiosError.mockReturnValue(true);
    api.post.mockResolvedValueOnce({});
    vi.spyOn(jsonTransfer, "fetchJsonExport").mockRejectedValueOnce({ response: { status: 401 } });
    await exportNow();
    expect(useAuthStore().isAuthenticated).toBe(false);
    expect(api.post).toHaveBeenCalledExactlyOnceWith(disableTokenUrl);
    expect(downloads).toHaveLength(0);
  });
});

describe("通知の検証とアップロード状態の連携", () => {
  it.each([
    { operation: "upsert", objectType: "marker", object: { id: "bad", geojson: {} } },
    { operation: "upsert", objectType: "shape", object: { id: "bad", marker_name: "bad" } },
    { operation: "delete", objectType: "marker" },
  ])("不正な差分通知は原本を変えず受領を拒否する: $objectType/$operation", async (change) => {
    await operationsReady();
    const ack = vi.fn();
    const count = dataRequests().length;
    frameComponent().vm.$emit("mapObjectChanged", { ...change, mutationId: "invalid" }, ack);
    await flushPromises();
    expect(ack).toHaveBeenCalledExactlyOnceWith(false);
    expect(useMapObjectStore().getById("bad")).toBeUndefined();
    expect(useShapeStore().getById("bad")).toBeUndefined();
    expect(dataRequests()).toHaveLength(count);
  });
  it.each(["marker", "shape"] as const)(
    "古い%s差分を原本へ採用せず、現在の原本を地図へ戻す",
    async (kind) => {
      await operationsReady();
      const ack = vi.fn();
      const store = kind === "marker" ? useMapObjectStore() : useShapeStore();
      vi.spyOn(store, "upsertRecord").mockReturnValue(false);
      const record = kind === "marker" ? marker("a") : shape("a");
      const upsert = upsertFrame;
      upsert.mockClear();
      frameComponent().vm.$emit(
        "mapObjectChanged",
        { operation: "upsert", objectType: kind, object: record, mutationId: "old" },
        ack,
      );
      await flushPromises();
      expect(ack).toHaveBeenCalledWith(true);
      expect(upsert).toHaveBeenCalledWith(kind, expect.objectContaining({ id: "a" }));
      expect(api.post).not.toHaveBeenCalled();
    },
  );
  it("削除済み原本への遅い通知を再表示させず、例外時は受領を拒否する", async () => {
    await operationsReady();
    const store = useMapObjectStore(),
      ack = vi.fn();
    vi.spyOn(store, "upsertRecord")
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error("cache failure");
      });
    frameComponent().vm.$emit(
      "mapObjectChanged",
      { operation: "upsert", objectType: "marker", object: marker("gone"), mutationId: "old-gone" },
      ack,
    );
    await flushPromises();
    expect(deleteFrame).toHaveBeenCalledWith("gone", "marker");
    frameComponent().vm.$emit(
      "mapObjectChanged",
      { operation: "upsert", objectType: "marker", object: marker("a"), mutationId: "throws" },
      ack,
    );
    await flushPromises();
    expect(ack.mock.lastCall).toEqual([false]);
  });
  it("マーカー削除の通知で原本と検索結果を更新し、所属変更後は移動先を表示する", async () => {
    await operationsReady();
    const ack = vi.fn();
    frameComponent().vm.$emit(
      "mapObjectChanged",
      { operation: "delete", objectType: "marker", id: "a", mutationId: "delete-a" },
      ack,
    );
    await flushPromises();
    expect(useMapObjectStore().getById("a")).toBeUndefined();
    frameComponent().vm.$emit(
      "mapObjectChanged",
      {
        operation: "upsert",
        objectType: "marker",
        object: { ...marker("moved"), layer_id: "b" },
        previousLayerId: "a",
        mutationId: "move-b",
      },
      ack,
    );
    await flushPromises();
    expect(ack.mock.calls.every(([success]) => success)).toBe(true);
    expect(frameComponent().props("srcUrl")).toContain("layer=b");
  });
  it("進捗を表示モーダルへ反映し、公開したアップロードリンクをコピーできる", async () => {
    await operationsReady({}, true);
    const progress = {
      isOpen: true,
      phase: "uploading",
      percent: 42,
      fileName: "photo.png",
      message: "送信中",
    };
    operationComponent("ImageUploadModal").vm.$emit("uploadProgressChange", progress);
    await flushPromises();
    expect(operationComponent("UploadProgressModal").props()).toMatchObject({
      isOpen: true,
      progress,
    });
    if (OPERATIONS_MOBILE)
      operationComponent("ImageUploadModal").vm.$emit("uploaded", "![写真](/photo.png)", "file");
    else
      operationComponent("ImageUploadModal").vm.$emit(
        "showUploadedUrl",
        "![写真](/photo.png)",
        "file",
      );
    await flushPromises();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await wrapper!.get("code#file-uploaded").trigger("click");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("![写真](/photo.png)");
    expect(operationMessage()).toContain("コピーしました");
    await wrapper!.get(".content-uploaded-message button").trigger("click");
    expect(wrapper!.get("code").text()).toBe("");
  });
});

describe("ショートカットとツールバーの操作", () => {
  const press = (key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    window.dispatchEvent(event);
    return event;
  };
  it.each([
    ["1", "LayerCreateModal"],
    ["2", "ImageUploadModal"],
    ["3", "ImageListModal"],
    ["4", "QRCodeGeneratorModal"],
    ["6", "FullScreenMapModal"],
  ])("Ctrl+%sで%sを開閉し、閉じた後にも再度操作できる", async (key, name) => {
    await operationsReady();
    expect(operationComponent(name).props("isOpen")).toBe(false);
    expect(press(key, { ctrlKey: true }).defaultPrevented).toBe(true);
    await flushPromises();
    expect(operationComponent(name).props("isOpen")).toBe(true);
    press(key, { ctrlKey: true });
    await flushPromises();
    expect(operationComponent(name).props("isOpen")).toBe(false);
  });
  it("共有設定と編集中の保存を要求し、検索リセットと一覧表示を連携する", async () => {
    const save = vi.fn(),
      reset = vi.fn();
    await operationsReady({
      MapToolbar: operationStub("MapToolbar", ["activeLayer"], { onMapObjectSearch: reset }),
      MapObjectEditModal: operationStub("MapObjectEditModal", ["isOpen", "targetId"], {
        updateMapObject: save,
      }),
    });
    press("5", { ctrlKey: true });
    await flushPromises();
    expect(initializeShared).toHaveBeenCalled();
    expect(refreshShared).toHaveBeenCalled();
    expect(operationComponent("OnetimeSettingModal").props("isOpen")).toBe(true);
    press("m", { ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    operationComponent("MapObjectTable").vm.$emit("editObject", "marker", "a");
    await flushPromises();
    press("m", { ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    press("3", { altKey: true });
    expect(reset).toHaveBeenCalledExactlyOnceWith(true);
    press("4", { altKey: true });
    await flushPromises();
    expect(initializeLayerList).toHaveBeenCalled();
    expect(operationComponent("LayerListModal").props("isOpen")).toBe(true);
  });
  it("検索欄とレイヤ選択へフォーカスを移し、非表示の第二検索欄へは移さない", async () => {
    await operationsReady();
    const inputs = ["search-textbox1", "search-textbox2", "layer-select-elm"].map((id) => {
      const input = document.createElement("input");
      input.id = id;
      document.body.append(input);
      return input;
    });
    try {
      press("1", { altKey: true });
      expect(document.activeElement).toBe(inputs[0]);
      press("2", { altKey: true });
      expect(document.activeElement).toBe(inputs[0]);
      Object.defineProperty(inputs[1], "offsetParent", {
        configurable: true,
        value: document.body,
      });
      press("2", { altKey: true });
      expect(document.activeElement).toBe(inputs[1]);
      press("5", { altKey: true });
      expect(document.activeElement).toBe(inputs[2]);
    } finally {
      inputs.forEach((input) => input.remove());
    }
  });
  it("印刷準備中・他のダイアログ・既に処理済みのキーで別操作を始めない", async () => {
    await operationsReady();
    const event = new KeyboardEvent("keydown", { key: "1", ctrlKey: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    await flushPromises();
    expect(operationComponent("LayerCreateModal").props("isOpen")).toBe(false);
    const other = document.createElement("dialog");
    other.setAttribute("open", "");
    document.body.append(other);
    expect(press("1", { ctrlKey: true }).defaultPrevented).toBe(false);
    other.remove();
    press("p", { ctrlKey: true, repeat: true });
    await flushPromises();
    expect(wrapper!.findComponent({ name: "PrintMapModal" }).exists()).toBe(false);
    press("p", { metaKey: true });
    await flushPromises();
    expect(wrapper!.findComponent({ name: "PrintMapModal" }).exists()).toBe(true);
    expect(press("1", { ctrlKey: true }).defaultPrevented).toBe(false);
    operationComponent("PrintMapModal").vm.$emit("close");
    await flushPromises();
    operationComponent("QRCodeGeneratorModal").vm.$emit("message", "通知");
    await flushPromises();
    press("Escape");
    await flushPromises();
    expect(operationComponent("MessageModal").props("isOpen")).toBe(false);
  });
  it.each([
    "newLayer",
    "imageUpload",
    "imageList",
    "qrCode",
    "fullScreenMap",
    "importJson",
    "onetimeSetting",
    "layerList",
  ])("ツールバーの%s要求を表示状態へ反映する", async (event) => {
    await operationsReady();
    operationComponent("MapToolbar").vm.$emit(event);
    await flushPromises();
    const names: Record<string, string> = {
      newLayer: "LayerCreateModal",
      imageUpload: "ImageUploadModal",
      imageList: "ImageListModal",
      qrCode: "QRCodeGeneratorModal",
      fullScreenMap: "FullScreenMapModal",
      importJson: "JsonImportModal",
      onetimeSetting: "OnetimeSettingModal",
      layerList: "LayerListModal",
    };
    const modal = operationComponent(names[event]!);
    expect(modal.props("isOpen")).toBe(true);
    modal.vm.$emit("close");
    await flushPromises();
    expect(modal.props("isOpen")).toBe(false);
  });
});

describe("アカウント設定・位置情報・回答更新の連携", () => {
  it("初期化後のプライバシー設定変更だけを利用者へ通知する", async () => {
    const privateMode = ref(false),
      initialized = ref(false),
      openSettings = vi.fn(() => {
        initialized.value = true;
      });
    await operationsReady({
      UserPrivacySetting: defineComponent({
        name: "UserPrivacySetting",
        setup(_, { expose }) {
          expose({
            isUserPrivate: privateMode,
            isInitialized: initialized,
            openCloseUserSettingModal: openSettings,
          });
          return () => null;
        },
      }),
    });
    privateMode.value = true;
    await flushPromises();
    expect(operationMessage()).not.toContain("ON になりました");
    (wrapper!.vm as any).openUserPrivacySettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
    privateMode.value = false;
    await flushPromises();
    expect(operationMessage()).toContain("OFF になりました");
    privateMode.value = true;
    await flushPromises();
    expect(operationMessage()).toContain("ON になりました");
  });
  it("地図の現在位置と取得失敗を共有コンポーネントへ渡す", async () => {
    const receive = vi.fn(),
      error = vi.fn();
    await operationsReady({
      LiveLocationSharing: operationStub("LiveLocationSharing", [], {
        receivePosition: receive,
        receiveError: error,
      }),
    });
    const position = { latitude: 35, longitude: 139, accuracy: 12 };
    frameComponent().vm.$emit("userLocation", position);
    frameComponent().vm.$emit("userLocationError", 2);
    await flushPromises();
    expect(receive).toHaveBeenCalledExactlyOnceWith(position);
    expect(error).toHaveBeenCalledTimes(1);
  });
  it("回答保存の図形差分を原本へ反映し、対象外IDの通知を無視する", async () => {
    await operationsReady();
    const record = {
      ...shape("a"),
      name: "回答反映",
      geojson: {
        type: "Feature",
        geometry: { type: "Point", coordinates: [139, 35] },
        properties: { radius: 10 },
      },
    };
    window.dispatchEvent(new CustomEvent("geocode-answer-updated", { detail: record }));
    await flushPromises();
    expect(useShapeStore().getById("a")?.name).toBe("回答反映");
    window.dispatchEvent(
      new CustomEvent("geocode-answer-updated", { detail: { ...record, id: "missing" } }),
    );
    await flushPromises();
    expect(useShapeStore().getById("missing")).toBeUndefined();
  });
});

describe("地図再生成中の保存と失敗時の再同期", () => {
  it.each(["upsert", "delete", "sync-failed"])(
    "旧フレームの保存完了を新フレームへ反映し、保存要求は再送しない: %s",
    async (outcome) => {
      await operationsReady();
      const pending = deferred<{ status: number; data: unknown }>(),
        reply = vi.fn();
      api.request.mockReturnValue(pending.promise);
      frameComponent().vm.$emit(
        "mapObjectWriteRequested",
        {
          url: outcome === "delete" ? "/marker/delete/a" : "/marker/update/a",
          method: outcome === "delete" ? "DELETE" : "PUT",
          requestId: "old-runtime-save",
          body: { detail: "更新" },
        },
        reply,
      );
      await flushPromises();
      const requests = dataRequests().length;
      frameComponent().vm.$emit("mapDataRequested");
      await flushPromises();
      const initializations = initializeFrame.mock.calls.length;
      deleteFrame.mockClear();
      upsertFrame.mockClear();
      if (outcome === "sync-failed") upsertFrame.mockResolvedValueOnce(false);
      const saved = { ...marker("a"), detail: "保存済み", update_at: "2026-01-01T00:00:00Z" };
      pending.resolve({
        status: 200,
        data: outcome === "delete" ? { message: "Deleted" } : { object: saved },
      });
      await flushPromises();
      expect(api.request).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.lastCall![0].status).toBe(200);
      expect(dataRequests()).toHaveLength(requests);
      if (outcome === "delete") {
        expect(deleteFrame).toHaveBeenCalledWith("a", "marker");
        expect(useMapObjectStore().getById("a")).toBeUndefined();
      } else {
        expect(upsertFrame).toHaveBeenCalledWith("marker", saved);
        expect(useMapObjectStore().getById("a")).toEqual(saved);
      }
      expect(initializeFrame.mock.calls.length).toBe(
        initializations + (outcome === "sync-failed" ? 1 : 0),
      );
      if (outcome === "sync-failed")
        expect(initializeFrame.mock.lastCall![0].markers.a).toEqual(saved);
      expect(spinner()).toBe(false);
    },
  );
  it("保存待ち中にログアウトした場合は成功応答も差分通知も反映しない", async () => {
    await operationsReady();
    const pending = deferred<{ status: number; data: unknown }>(),
      reply = vi.fn();
    api.request.mockReturnValue(pending.promise);
    frameComponent().vm.$emit(
      "mapObjectWriteRequested",
      { url: "/marker/update/a", method: "PUT", requestId: "before-logout" },
      reply,
    );
    await flushPromises();
    useAuthStore().logout();
    await flushPromises();
    upsertFrame.mockClear();
    deleteFrame.mockClear();
    pending.resolve({
      status: 200,
      data: {
        object: { ...marker("a"), detail: "旧アカウントの保存", update_at: "2026-01-01T00:00:00Z" },
      },
    });
    await flushPromises();
    const ack = vi.fn();
    frameComponent().vm.$emit(
      "mapObjectChanged",
      { operation: "delete", objectType: "marker", id: "a", mutationId: "late" },
      ack,
    );
    expect(reply.mock.lastCall![0].status).toBe(409);
    expect(ack).toHaveBeenCalledWith(false);
    expect(useMapObjectStore().getById("a")).toBeUndefined();
    expect(upsertFrame).not.toHaveBeenCalled();
    expect(deleteFrame).not.toHaveBeenCalled();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(frameComponent().props("srcUrl")).toBe("");
  });
});
