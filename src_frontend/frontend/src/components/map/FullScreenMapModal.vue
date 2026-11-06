<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { mapAnatherLayerUrl } from "@/router/urls";
import {
  isShareMapSnapshot,
  type ShareMapSnapshot,
} from "../../../../template-scripts/src/map/common/share-snapshot";

const props = defineProps<{
  isOpen: boolean;
  closeBlocked?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  share: [snapshot: ShareMapSnapshot];
}>();

const mapIframe = ref<HTMLIFrameElement | null>(null);
const childModalOpen = ref(false);
const closeRequestId = ref<number | null>(null);
const closeResponseTimeoutMs = 750;
let closeBridgeReady = false;
let sessionId = 0;
let requestSequence = 0;
let closeTimer: number | undefined;

const sendToMap = (message: Record<string, unknown>): void => {
  const iframe = mapIframe.value;
  if (!props.isOpen || !iframe?.contentWindow) return;
  const origin = new URL(iframe.src, window.location.href).origin;
  iframe.contentWindow.postMessage(message, origin);
};

const clearCloseRequest = (): void => {
  window.clearTimeout(closeTimer);
  closeTimer = undefined;
  closeRequestId.value = null;
};

const resetCloseBridge = (): void => {
  clearCloseRequest();
  sessionId += 1;
  closeBridgeReady = false;
  childModalOpen.value = false;
};

const connectCloseBridge = (): void => {
  sendToMap({ type: "readOnlyFullscreenCloseConnect", sessionId });
};

const requestClose = (): void => {
  if (!props.isOpen || props.closeBlocked || childModalOpen.value || closeRequestId.value !== null)
    return;
  const requestId = ++requestSequence;
  closeRequestId.value = requestId;
  if (!closeBridgeReady) connectCloseBridge();
  sendToMap({ type: "readOnlyFullscreenCloseRequest", sessionId, requestId });
  closeTimer = window.setTimeout(() => {
    clearCloseRequest();
    // 読み込み失敗や認証画面への遷移時にも全画面から退出できるようにする。
    if (!closeBridgeReady && props.isOpen && !props.closeBlocked) emit("close");
  }, closeResponseTimeoutMs);
};

const onFrameLoad = (event: Event): void => {
  if (!props.isOpen || event.currentTarget !== mapIframe.value) return;
  const requestedWhileLoading = !closeBridgeReady && closeRequestId.value !== null;
  resetCloseBridge();
  if (requestedWhileLoading) requestClose();
  else connectCloseBridge();
};

const openPrint = (): void => sendToMap({ type: "readOnlyPrintOpen" });
defineExpose({ openPrint, requestClose });

const handleMessage = (event: MessageEvent): void => {
  const iframe = mapIframe.value;
  if (!props.isOpen || !iframe?.contentWindow || event.source !== iframe.contentWindow) return;
  if (event.origin !== new URL(iframe.src, window.location.href).origin) return;
  const data = event.data;
  if (data?.type === "shareMapSnapshot" && isShareMapSnapshot(data.snapshot)) {
    emit("share", data.snapshot);
    return;
  }
  if (data?.sessionId !== sessionId || typeof data.modalOpen !== "boolean") return;
  if (data.type === "readOnlyFullscreenCloseState") {
    closeBridgeReady = true;
    childModalOpen.value = data.modalOpen;
    if (data.modalOpen) clearCloseRequest();
  } else if (data.type === "readOnlyFullscreenCloseResult") {
    if (closeRequestId.value === null || data.requestId !== closeRequestId.value) return;
    clearCloseRequest();
    closeBridgeReady = true;
    childModalOpen.value = data.modalOpen;
    if (!data.modalOpen && !props.closeBlocked) emit("close");
  }
};

watch(() => props.isOpen, resetCloseBridge, { immediate: true, flush: "sync" });
watch(
  () => props.closeBlocked,
  (blocked) => {
    if (blocked) clearCloseRequest();
  },
);
onMounted(() => window.addEventListener("message", handleMessage));
onUnmounted(() => {
  clearCloseRequest();
  window.removeEventListener("message", handleMessage);
});
</script>

<template>
  <div class="overlay-fullscreen-map" v-if="isOpen">
    <iframe
      ref="mapIframe"
      class="content-fullscreen-map"
      :src="mapAnatherLayerUrl"
      title="全画面地図"
      frameborder="0"
      @load="onFrameLoad"
    ></iframe>
    <button
      v-show="!childModalOpen && !closeBlocked"
      type="button"
      class="fullscreen-close-btn"
      :disabled="closeRequestId !== null"
      @click="requestClose"
    >
      閉じる
    </button>
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
