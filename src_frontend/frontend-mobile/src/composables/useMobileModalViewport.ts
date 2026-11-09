import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// iOSのPWAでも、ソフトウェアキーボードで隠れない表示領域に合わせる。
export function useMobileModalViewport() {
  const height = ref(window.innerHeight);
  const top = ref(0);
  const viewport = window.visualViewport;
  const update = () => {
    height.value =
      viewport?.height && viewport.height > 0
        ? Math.min(viewport.height, window.innerHeight)
        : window.innerHeight;
    top.value = Math.max(0, viewport?.offsetTop ?? 0);
  };
  update();
  onMounted(() => {
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    update();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
  });
  return computed(() => ({
    "--mobile-modal-height": `${height.value}px`,
    "--mobile-modal-top": `${top.value}px`,
  }));
}
