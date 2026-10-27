import { createPinia, setActivePinia } from "pinia";
import { shallowMount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import MapView from "@/views/MapViewMobile.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
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
      upsertMapObject: vi.fn().mockResolvedValue(true),
      deleteMapObject: vi.fn().mockResolvedValue(true),
      filterMapObjects: vi.fn(),
      reloadMapFrame: () => true,
      updateMapObject: updateFrame,
    });
    return () => null;
  },
});
function mountView(showSplashScreen = ref(false)) {
  wrapper = shallowMount(MapView, {
    global: {
      provide: { isShowAppHeader: ref(true), showSplashScreen },
      stubs: { MapIframe: frame },
    },
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
  api.request.mockReset();
  updateFrame.mockReset().mockResolvedValue(true);
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

  it("スプラッシュ中も取得を進め、終了後に地図が未表示ならプログレスを表示する", async () => {
    const showSplashScreen = ref(true);
    mountView(showSplashScreen);
    expect(spinner()).toBe(false);
    await flushPromises();
    expect(dataRequests()).toHaveLength(2);
    expect(frameComponent().props("srcUrl")).not.toBe("");
    expect(spinner()).toBe(false);

    showSplashScreen.value = false;
    await flushPromises();
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    expect(spinner()).toBe(false);

    await changeLayer("a");
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    expect(spinner()).toBe(false);
  });

  it("スプラッシュ中に地図を読み終えた場合は終了後もプログレスを表示しない", async () => {
    const showSplashScreen = ref(true);
    mountView(showSplashScreen);
    await flushPromises();
    frameComponent().vm.$emit("mapLoaded", frameComponent().props("srcUrl"));
    await flushPromises();
    expect(spinner()).toBe(false);
    showSplashScreen.value = false;
    await flushPromises();
    expect(spinner()).toBe(false);
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
    // A retried notification is safe and does not repeat the server mutation.
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
  it("does not restore another layer with the previous layer's delayed query", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    mountView();
    await flushPromises();
    const pending = deferred<{
      data: { markers: Record<string, ReturnType<typeof marker>>; shape_ids: string[] };
    }>();
    api.get.mockReturnValueOnce(pending.promise);
    wrapper!
      .getComponent({ name: "MapObjectTable" })
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
    // A was cached, so force a new, unavailable scope to exercise old-display restore.
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
