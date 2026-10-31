// measure-answer-map.mjs でのみビルドし、アプリのコンポーネントはすべて変更せずに使う。
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
    // 空の ID を指定すると、実際の編集画面はポップアップを開いたり本文を再取得したりせずに
    // ズーム 16 へ移動する。図形と描画の完了は実行側で検証する。
    if (coordinate) parentFrame.value.focusObject("shape", "", coordinate[1], coordinate[0]);
    // 準備処理は回答地図を開く時間の計測に含めない。回答モーダルの計測中は、
    // 実際の Pinia レコードと編集用 iframe を保持する。
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
