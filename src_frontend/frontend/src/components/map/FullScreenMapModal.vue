<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { mapAnatherLayerUrl } from "@/router/urls";
import {
  isShareMapSnapshot,
  type ShareMapSnapshot,
} from "../../../../template-scripts/src/map/common/share-snapshot";

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  share: [snapshot: ShareMapSnapshot];
}>();

const mapIframe = ref<HTMLIFrameElement | null>(null);
const openPrint = (): void => {
  const iframe = mapIframe.value;
  if (!props.isOpen || !iframe?.contentWindow) return;
  const origin = new URL(iframe.src, window.location.href).origin;
  iframe.contentWindow.postMessage({ type: "readOnlyPrintOpen" }, origin);
};
defineExpose({ openPrint });

const handleMessage = (event: MessageEvent): void => {
  const iframe = mapIframe.value;
  if (!props.isOpen || !iframe?.contentWindow || event.source !== iframe.contentWindow) return;
  if (event.origin !== new URL(iframe.src, window.location.href).origin) return;
  if (event.data?.type !== "shareMapSnapshot" || !isShareMapSnapshot(event.data.snapshot)) return;
  emit("share", event.data.snapshot);
};

onMounted(() => window.addEventListener("message", handleMessage));
onUnmounted(() => window.removeEventListener("message", handleMessage));
</script>

<template>
  <div class="overlay-fullscreen-map" v-if="isOpen">
    <iframe
      ref="mapIframe"
      class="content-fullscreen-map"
      :src="mapAnatherLayerUrl"
      title="全画面地図"
      frameborder="0"
    ></iframe>
    <button class="fullscreen-close-btn" @click="emit('close')">閉じる</button>
  </div>
</template>

<style scoped>
.overlay-fullscreen-map {
  z-index: 10;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.content-fullscreen-map {
  z-index: 11;
  width: 100%;
  height: 95vh;
  padding: 1em;
  background: #444444;
  border-radius: 10px;
}

.fullscreen-close-btn {
  z-index: 12;
  position: fixed;
  bottom: 5%;
  left: 2%;
}
</style>
