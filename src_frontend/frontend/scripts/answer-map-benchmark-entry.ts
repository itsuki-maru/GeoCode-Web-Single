// Built only by measure-answer-map.mjs; all application components stay unchanged.
// @ts-nocheck
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import AnswerMap from "@bench-component";

const opened = ref(false), component = ref();
const options = (window as any).__ANSWER_MAP_BENCH_OPTIONS__;
createApp({
  setup: () => () => opened.value ? h(AnswerMap, {
    ref: component,
    isOpen: true,
    query: options.query,
    action: `${location.origin}/form-answers/map`,
    printEnabled: !options.mobile,
    class: options.mobile ? "answer-map-mobile-layout" : undefined,
    onClose: () => { opened.value = false; },
  }) : null,
}).use(createPinia()).mount("#host");

window.__answerMapBenchmark = {
  async open() { opened.value = true; await nextTick(); },
  async close() {
    const frame = document.querySelector(".map-content > iframe");
    const runtime = frame?.contentWindow?.__answerMapRuntime;
    if (runtime) (window.__closedMapRefs ||= []).push(new WeakRef(runtime));
    opened.value = false;
    await nextTick();
  },
  state: () => component.value?.benchmarkState() ?? { closed: true },
  filter: (operation: string) => component.value.benchmarkFilter(operation),
  color: (enabled: boolean) => component.value.benchmarkColor(enabled),
  print: () => component.value.benchmarkPrint(),
  clearPrint: () => component.value.benchmarkClearPrint(),
  csvCheck: () => component.value.benchmarkCsvCheck(),
  retainedRuntimes: () => (window.__closedMapRefs || []).filter((ref) => ref.deref()).length,
};
