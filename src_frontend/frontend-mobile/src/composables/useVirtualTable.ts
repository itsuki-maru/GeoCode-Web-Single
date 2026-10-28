import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from "vue";

export const TABLE_ROW_HEIGHT = 56;
export const TABLE_OVERSCAN = 6;
export function tableRange(count: number, scrollTop: number, height: number, header: number) {
  const start = Math.min(
    count,
    Math.max(0, Math.floor(Math.max(0, scrollTop - header) / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN),
  );
  const end = Math.min(
    count,
    Math.max(
      start,
      Math.ceil(Math.max(0, scrollTop + height - header) / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN,
    ),
  );
  return { start, end, top: start * TABLE_ROW_HEIGHT, bottom: (count - end) * TABLE_ROW_HEIGHT };
}
export function useVirtualTable(count: Ref<number>, active: Ref<boolean>) {
  const viewport = ref<HTMLElement | null>(null);
  const scrollTop = ref(0),
    height = ref(0),
    header = ref(36);
  let observer: ResizeObserver | undefined;
  function measure() {
    const element = viewport.value;
    if (!element || !active.value) return;
    height.value = element.clientHeight;
    header.value = element.querySelector("thead")?.getBoundingClientRect().height || 36;
    const max = Math.max(0, count.value * TABLE_ROW_HEIGHT + header.value - height.value);
    scrollTop.value = Math.min(scrollTop.value, max);
    element.scrollTop = scrollTop.value;
  }
  function onScroll() {
    if (viewport.value) scrollTop.value = viewport.value.scrollTop;
  }
  watch(
    viewport,
    async (element) => {
      observer?.disconnect();
      if (!element) return;
      await nextTick();
      if (viewport.value !== element) return;
      measure();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(element);
        const head = element.querySelector("thead");
        if (head) observer.observe(head);
      }
    },
    { flush: "post" },
  );
  watch(
    count,
    () => {
      if (active.value) measure();
    },
    { flush: "post" },
  );
  function resetScroll() {
    scrollTop.value = 0;
    if (viewport.value) viewport.value.scrollTop = 0;
  }
  onScopeDispose(() => observer?.disconnect());
  const range = computed(() =>
    tableRange(count.value, scrollTop.value, height.value, header.value),
  );
  return { viewport, range, onScroll, resetScroll };
}
