import { createPinia, setActivePinia } from "pinia";
import { shallowMount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), isAxiosError: vi.fn(() => false) }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import MapView from "@/views/MapViewMobile.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
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

const frame = defineComponent({
  name: "MapIframe",
  props: ["srcUrl", "height", "allowedOrigins"],
  emits: ["mapLoaded"],
  setup(_, { expose }) {
    expose({ filterMapObjects: vi.fn(), reloadMapFrame: () => true });
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
    expect(frameComponent().props("srcUrl")).toBe("");
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("a");
  });

  it("ignores an aborted response even after switching from A to B and back to A", async () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "a");
    const firstMarkers = deferred<{ data: Record<string, ReturnType<typeof marker>> }>();
    const firstShapes = deferred<{ data: ReturnType<typeof shape>[] }>();
    let markerCalls = 0,
      shapeCalls = 0;
    getMarkers = (id) =>
      id === "a" && ++markerCalls === 1
        ? firstMarkers.promise
        : Promise.resolve({ data: { [id]: marker(id) } });
    getShapes = (id) =>
      id === "a" && ++shapeCalls === 1
        ? firstShapes.promise
        : Promise.resolve({ data: [shape(id)] });
    mountView();
    await flushPromises();
    const firstSignal = dataRequests()[0]![1].signal as AbortSignal;
    await changeLayer("b");
    expect(firstSignal.aborted).toBe(true);
    await changeLayer("a");
    const latestUrl = frameComponent().props("srcUrl");
    firstMarkers.resolve({ data: { stale: marker("stale") } });
    firstShapes.resolve({ data: [shape("stale")] });
    await flushPromises();
    expect([...useMapObjectStore().mapObjectList.keys()]).toEqual(["a"]);
    expect([...useShapeStore().shapeList.keys()]).toEqual(["a"]);
    expect(frameComponent().props("srcUrl")).toBe(latestUrl);
    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("a");
    frameComponent().vm.$emit("mapLoaded", "old-map-url");
    await flushPromises();
    expect(spinner()).toBe(true);
    frameComponent().vm.$emit("mapLoaded", latestUrl);
    await flushPromises();
    expect(spinner()).toBe(false);
  });
});
