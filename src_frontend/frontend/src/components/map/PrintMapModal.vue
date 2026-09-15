<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { mapAnatherLayerUrl } from "@/router/urls";

const props = defineProps<{ layerIds: string[] | null }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const frame = ref<HTMLIFrameElement | null>(null);
const error = ref("");
const initialized = ref(false);
const frameKey = ref(0);
const printUrl = `${mapAnatherLayerUrl}?print=1`;
const printOrigin = new URL(printUrl, window.location.href).origin;
let state: Record<string, unknown> | null = null;
let ready = false;
let requestId = "";
let timer: number | undefined;
let sourceWindow: Window | null = null;
let sourceOrigin = "";
let previousFocus: HTMLElement | null = null;

const fail = (message: string) => {
  window.clearTimeout(timer);
  error.value = message;
};
const sendState = () => {
  if (!ready || !state || error.value) return;
  frame.value?.contentWindow?.postMessage({ type: "printInitialize", state }, printOrigin);
};
const requestState = () => {
  const source = document.getElementById("map-iframe") as HTMLIFrameElement | null;
  if (!source?.contentWindow) {
    fail("現在の地図を取得できません。地図の読み込み後に開き直してください。");
    return;
  }
  sourceWindow = source.contentWindow;
  sourceOrigin = new URL(source.src, window.location.href).origin;
  requestId = `print-${Date.now()}-${frameKey.value}`;
  sourceWindow.postMessage({ type: "printStateRequest", requestId }, sourceOrigin);
  window.clearTimeout(timer);
  timer = window.setTimeout(
    () => fail("印刷プレビューを読み込めませんでした。再試行してください。"),
    15000,
  );
};
const receive = (event: MessageEvent) => {
  if (!event.data || typeof event.data !== "object") return;
  if (
    event.source === sourceWindow &&
    event.origin === sourceOrigin &&
    event.data.type === "printStateResult" &&
    event.data.requestId === requestId
  ) {
    state = { ...event.data.state, layerIds: props.layerIds === null ? null : [...props.layerIds] };
    sendState();
    return;
  }
  if (event.source !== frame.value?.contentWindow || event.origin !== printOrigin) return;
  if (event.data.type === "printReady") {
    ready = true;
    sendState();
  } else if (event.data.type === "printInitialized") {
    window.clearTimeout(timer);
    initialized.value = true;
    frame.value?.focus();
  } else if (event.data.type === "printClose") emit("close");
  else if (event.data.type === "printError")
    fail("印刷用の地図を作成できませんでした。再試行してください。");
};
const retry = () => {
  error.value = "";
  initialized.value = false;
  state = null;
  ready = false;
  frameKey.value++;
  requestState();
};
const handlePrintKey = (event: KeyboardEvent) => {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.isComposing ||
    event.key.toLowerCase() !== "p"
  )
    return;
  event.preventDefault();
  if (event.repeat || !initialized.value || error.value) return;
  frame.value?.contentWindow?.postMessage({ type: "printExecute" }, printOrigin);
};
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("message", receive);
  window.addEventListener("keydown", handlePrintKey);
  dialog.value?.showModal();
  requestState();
});
onBeforeUnmount(() => {
  window.clearTimeout(timer);
  window.removeEventListener("message", receive);
  window.removeEventListener("keydown", handlePrintKey);
  dialog.value?.close();
  previousFocus?.focus();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="print-dialog"
    aria-label="地図の印刷プレビュー"
    @cancel.prevent="emit('close')"
  >
    <header class="print-header">
      <span>印刷プレビュー</span>
      <button type="button" @click="emit('close')">閉じる</button>
    </header>
    <div class="print-content">
      <iframe
        :key="frameKey"
        ref="frame"
        :src="printUrl"
        title="地図の印刷プレビュー"
        :class="{ 'is-loading': !initialized || error }"
      ></iframe>
      <div v-if="!initialized || error" class="print-loading" role="status">
        <p>{{ error || "印刷プレビューを準備しています…" }}</p>
        <button v-if="error" type="button" @click="retry">再試行</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.print-dialog {
  padding: 0;
  border: 0;
  border-radius: 12px;
  width: 96vw;
  height: 94vh;
  max-width: none;
  max-height: none;
  overflow: hidden;
  background: #edf1f5;
}
.print-dialog::backdrop {
  background: rgb(15 23 42 / 65%);
}
.print-dialog[open] {
  display: flex;
  flex-direction: column;
}
.print-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  flex: none;
  background: white;
  border-bottom: 1px solid #d3dce6;
}
.print-header button {
  padding: 0.6em 1.2em;
  cursor: pointer;
  border: 1px solid #5f5f5f;
  border-radius: 8px;
  background: #5f5f5f;
  color: #ffffff;
  font: inherit;
  font-weight: 500;
  box-shadow: 0 2px 2px rgb(0 0 0 / 20%);
  transition: border-color 0.25s;
}
.print-header button:hover {
  border-color: #396cd8;
}
.print-header button:active {
  border-color: #396cd8;
  background: #e8e8e8;
  color: #333333;
}
.print-header button:focus-visible {
  outline: 2px solid #396cd8;
  outline-offset: 2px;
}
.print-content {
  position: relative;
  flex: 1;
  min-height: 0;
}
.print-dialog iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.print-dialog iframe.is-loading {
  visibility: hidden;
}
.print-loading {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
}
.print-loading button {
  padding: 8px 16px;
  cursor: pointer;
}
</style>
