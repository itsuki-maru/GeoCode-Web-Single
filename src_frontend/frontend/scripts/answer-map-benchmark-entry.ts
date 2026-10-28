// Built only by measure-answer-map.mjs; all application components stay unchanged.
// @ts-nocheck
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import AnswerMap from "@bench-component";

const opened = ref(false), component = ref();
const options = (window as any).__ANSWER_MAP_BENCH_OPTIONS__;
const pinia = createPinia();
const parentFrame = ref();
const parentState = { enabled: !!options.parentRetained, ready: !options.parentRetained, failed: false, shapes: 0, markers: 0 };
const parentParts = options.parentRetained ? await Promise.all([
  import("@/components/map/MapIframe.vue"),
  import("@/stores/shapes"),
  import("@/stores/mapobjects"),
]) : null;
const shapeStore = parentParts?.[1].useShapeStore(pinia);
const markerStore = parentParts?.[2].useMapObjectStore(pinia);
const seedParent = options.parentRetained ? (async () => {
  const response = await fetch("/__bench-parent-records", { cache: "no-store" });
  if (!response.ok) throw new Error("Parent diagnostic records unavailable");
  const records = await response.json();
  await shapeStore.recordCache.load("", true, async () => records.shapes, true);
  await markerStore.recordCache.load("", true, async () => Object.values(records.markers), true);
  shapeStore.activateScope("", true);
  markerStore.activateScope("", true);
  parentState.shapes = shapeStore.getScopeRecords().length;
  parentState.markers = markerStore.getScopeRecords().length;
})() : Promise.resolve();
let parentInitializing = false;
async function initializeParent() {
  if (parentInitializing || parentState.ready) return;
  parentInitializing = true;
  try {
    await seedParent;
    if (!(await parentFrame.value.initializeMapObjects({
      markers: Object.fromEntries(markerStore.getScopeRecords().map((record) => [record.id, record])),
      shapes: shapeStore.getScopeRecords(),
    }))) throw new Error("Parent diagnostic initialization failed");
    const shape = shapeStore.getScopeRecords()[0];
    const point = (coordinates) => {
      if (!Array.isArray(coordinates)) return null;
      if (typeof coordinates[0] === "number") return coordinates;
      for (const child of coordinates) { const value = point(child); if (value) return value; }
      return null;
    };
    const coordinate = point((shape?.geojson?.type === "Feature" ? shape.geojson.geometry : shape?.geojson)?.coordinates);
    // An empty ID moves the real editor to zoom16 without opening a popup or
    // requesting a fresh body. Geometry/render-idle is verified by the runner.
    if (coordinate) parentFrame.value.focusObject("shape", "", coordinate[1], coordinate[0]);
    // Setup is excluded from the measured answer-map opening. Retain actual
    // Pinia records and the editor iframe while the answer modal is measured.
    for (let index = 0; index < 12; index++) await new Promise(requestAnimationFrame);
    parentState.ready = true;
  } catch {
    parentState.failed = true;
  }
}
createApp({
  setup: () => () => h("div", [options.parentRetained ? h(parentParts[0].default, {
    ref: parentFrame,
    srcUrl: "/profile/parent-map?data_source=parent&is_master=true",
    height: 100,
    allowedOrigins: location.origin,
    onMapDataRequested: initializeParent,
    onMapObjectWriteRequested: (_request, reply) => reply({ status: 403, data: {} }),
  }) : null, opened.value ? h(AnswerMap, {
    ref: component,
    isOpen: true,
    query: options.query,
    action: `${location.origin}/form-answers/map`,
    printEnabled: !options.mobile,
    class: options.mobile ? "answer-map-mobile-layout" : undefined,
    onClose: () => { opened.value = false; },
  }) : null]),
}).use(pinia).mount("#host");
if (options.parentRetained) void nextTick().then(initializeParent);

window.__answerMapBenchmark = {
  async open() {
    window.__benchmarkMark?.("parent.open.start");
    opened.value = true;
    await nextTick();
  },
  async close() {
    const frame = document.querySelector(".map-content > iframe");
    const runtime = frame?.contentWindow?.__answerMapRuntime;
    if (runtime) (window.__closedMapRefs ||= []).push(new WeakRef(runtime));
    opened.value = false;
    await nextTick();
  },
  state: () => component.value?.benchmarkState() ?? { closed: true },
  parentState: () => ({ ...parentState }),
  filter: (operation: string) => component.value.benchmarkFilter(operation),
  color: (enabled: boolean) => component.value.benchmarkColor(enabled),
  print: () => component.value.benchmarkPrint(),
  clearPrint: () => component.value.benchmarkClearPrint(),
  csvCheck: () => component.value.benchmarkCsvCheck(),
  retainedRuntimes: () => (window.__closedMapRefs || []).filter((ref) => ref.deref()).length,
};
