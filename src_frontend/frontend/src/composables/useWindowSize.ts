import { ref, onMounted, onBeforeUnmount } from "vue";

export function useWindowSize() {
  const width = ref(window.innerWidth);
  const height = ref(window.innerHeight);

  const updateSize = () => {
    width.value = window.innerWidth;
    height.value = window.innerHeight;
  };
  onMounted(() => {
    window.addEventListener("resize", updateSize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", updateSize);
  });

  const divHeight = ref(0);
  if (height.value > 947) {
    divHeight.value = 83;
  } else if (height.value <= 947) {
    divHeight.value = 82;
  }

  return { width, height, divHeight };
}
