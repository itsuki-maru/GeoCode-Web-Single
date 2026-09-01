import { computed, ref, onMounted, onBeforeUnmount } from "vue";

const TALL_WINDOW_THRESHOLD = 947;
const LANDSCAPE_HEIGHT = {
  default: 82,
  tall: 83,
} as const;
const PORTRAIT_HEIGHT = {
  default: 87,
  tall: 88,
} as const;

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

  const divHeight = computed(() => {
    const isTallWindow = height.value > TALL_WINDOW_THRESHOLD;
    const isPortrait = height.value >= width.value;

    if (isPortrait) {
      return isTallWindow ? PORTRAIT_HEIGHT.tall : PORTRAIT_HEIGHT.default;
    }

    return isTallWindow ? LANDSCAPE_HEIGHT.tall : LANDSCAPE_HEIGHT.default;
  });

  return { width, height, divHeight };
}
