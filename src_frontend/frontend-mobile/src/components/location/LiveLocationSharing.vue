<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import apiClient from "@/axiosClient";
import { authCheckUrl, liveLocationSessionUrl } from "@/router/urls";

type BrowserPosition = Record<string, number | null>;
type SharingState = "idle" | "waiting" | "starting" | "sharing" | "retrying" | "error";
const allowed = ref(false);
const state = ref<SharingState>("idle");
const latestPosition = ref<BrowserPosition | null>(null);
const sessionId = ref<string | null>(null);
const sequence = ref(0);
const wantsSharing = ref(false);
let timer: number | null = null;
let intervalMs = 5000;
const label = computed(() =>
  state.value === "sharing"
    ? "● 共有中（停止）"
    : state.value === "retrying"
      ? "● 再接続中（停止）"
      : state.value === "waiting" || state.value === "starting"
        ? "位置取得中…"
        : state.value === "error"
          ? wantsSharing.value
            ? "共有エラー（停止）"
            : "共有エラー（再試行）"
          : "現在位置を共有",
);
const buildPayload = (position: BrowserPosition, sequenceNo: number) => ({
  latitude: position.latitude,
  longitude: position.longitude,
  accuracy_m: position.accuracy,
  heading_deg: position.heading,
  speed_mps: position.speed,
  observed_at: new Date(position.timestamp ?? Date.now()).toISOString(),
  sequence_no: sequenceNo,
});
function clearTimer() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}
function schedule() {
  clearTimer();
  if (wantsSharing.value && sessionId.value && document.visibilityState !== "hidden")
    timer = window.setTimeout(sendUpdate, intervalMs);
}
async function createSession() {
  if (!wantsSharing.value || !latestPosition.value || document.visibilityState === "hidden") return;
  state.value = "starting";
  try {
    const response = await apiClient.post(
      liveLocationSessionUrl,
      buildPayload(latestPosition.value, 0),
    );
    sessionId.value = response.data.session_id;
    intervalMs = response.data.upload_interval_ms ?? 5000;
    sequence.value = 0;
    state.value = "sharing";
    schedule();
  } catch {
    state.value = "error";
    wantsSharing.value = false;
  }
}
async function sendUpdate() {
  if (!latestPosition.value || !sessionId.value || !wantsSharing.value) return;
  sequence.value += 1;
  try {
    await apiClient.put(
      `${liveLocationSessionUrl}/${sessionId.value}`,
      buildPayload(latestPosition.value, sequence.value),
    );
    state.value = "sharing";
  } catch (error: any) {
    if ([403, 404, 409].includes(error?.response?.status)) {
      wantsSharing.value = false;
      sessionId.value = null;
      state.value = "error";
      clearTimer();
      return;
    }
    state.value = "retrying";
  }
  schedule();
}
async function stopSharing() {
  wantsSharing.value = false;
  clearTimer();
  const id = sessionId.value;
  sessionId.value = null;
  state.value = "idle";
  if (id)
    try {
      await apiClient.delete(`${liveLocationSessionUrl}/${id}`);
    } catch {
      /* server freshness handles cleanup */
    }
}
function toggleSharing() {
  if (wantsSharing.value) void stopSharing();
  else {
    wantsSharing.value = true;
    state.value = latestPosition.value ? "starting" : "waiting";
    if (latestPosition.value) void createSession();
  }
}
function receivePosition(position: BrowserPosition) {
  latestPosition.value = position;
  if (wantsSharing.value && !sessionId.value && state.value === "waiting") void createSession();
}
function receiveError() {
  if (wantsSharing.value) {
    clearTimer();
    state.value = "error";
  }
}
function bestEffortStop() {
  clearTimer();
  if (sessionId.value && typeof navigator.sendBeacon === "function")
    navigator.sendBeacon(`${liveLocationSessionUrl}/${sessionId.value}/stop`);
  sessionId.value = null;
}
function handleVisibility() {
  if (document.visibilityState === "hidden") bestEffortStop();
  else if (wantsSharing.value) {
    latestPosition.value = null;
    state.value = "waiting";
  }
}
onMounted(async () => {
  try {
    const response = await apiClient.get(authCheckUrl);
    allowed.value = response.data.can_share_live_location === true;
  } catch {
    allowed.value = false;
  }
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", bestEffortStop);
});
onUnmounted(() => {
  bestEffortStop();
  document.removeEventListener("visibilitychange", handleVisibility);
  window.removeEventListener("pagehide", bestEffortStop);
});
defineExpose({ receivePosition, receiveError });
</script>

<template>
  <div v-if="allowed" class="live-sharing" role="status">
    <button :class="{ active: wantsSharing }" type="button" @click="toggleSharing">
      {{ label }}
    </button>
  </div>
</template>
<style scoped>
.live-sharing {
  bottom: 7%;
  position: fixed;
  right: 2%;
  z-index: 3;
}
button {
  background: #fff;
  border: 1px solid #8c959f;
  border-radius: 15px;
  color: #24292f;
  min-height: 40px;
  padding: 7px 12px;
}
button.active {
  background: #cf222e;
  border-color: #cf222e;
  color: #fff;
}
</style>
