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
const lastSentAt = ref<Date | null>(null);
let timer: number | null = null;
let intervalMs = 5000;

const label = computed(() => {
  if (state.value === "sharing") return "● 位置共有中（停止）";
  if (state.value === "retrying") return "● 再接続中（停止）";
  if (state.value === "waiting" || state.value === "starting") return "位置取得中…";
  if (state.value === "error") {
    return wantsSharing.value ? "位置共有エラー（停止）" : "位置共有エラー（再試行）";
  }
  return "現在位置を共有";
});

function buildPayload(position: BrowserPosition, sequenceNo: number) {
  return {
    latitude: position.latitude,
    longitude: position.longitude,
    accuracy_m: position.accuracy,
    heading_deg: position.heading,
    speed_mps: position.speed,
    observed_at: new Date(position.timestamp ?? Date.now()).toISOString(),
    sequence_no: sequenceNo,
  };
}

function clearTimer() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function schedule() {
  clearTimer();
  if (!wantsSharing.value || !sessionId.value || document.visibilityState === "hidden") return;
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
    lastSentAt.value = new Date();
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
    lastSentAt.value = new Date();
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
  if (id) {
    try {
      await apiClient.delete(`${liveLocationSessionUrl}/${id}`);
    } catch {
      // 異常終了時も公開側は最終受信時刻からオフライン判定する。
    }
  }
}

function toggleSharing() {
  if (wantsSharing.value) {
    void stopSharing();
    return;
  }
  wantsSharing.value = true;
  state.value = latestPosition.value ? "starting" : "waiting";
  if (latestPosition.value) void createSession();
}

function receivePosition(position: BrowserPosition) {
  latestPosition.value = position;
  if (wantsSharing.value && !sessionId.value && state.value === "waiting") void createSession();
}

function receiveError() {
  if (!wantsSharing.value) return;
  clearTimer();
  state.value = "error";
}

function bestEffortStop() {
  clearTimer();
  if (sessionId.value && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(`${liveLocationSessionUrl}/${sessionId.value}/stop`);
  }
  sessionId.value = null;
}

function handleVisibility() {
  if (document.visibilityState === "hidden") {
    bestEffortStop();
  } else if (wantsSharing.value) {
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
    <span v-if="lastSentAt && wantsSharing">
      最終送信 {{ lastSentAt.toLocaleTimeString("ja-JP") }}
    </span>
  </div>
</template>

<style scoped>
.live-sharing {
  align-items: center;
  display: flex;
  gap: 8px;
  left: 1%;
  position: fixed;
  top: 2%;
  z-index: 3;
}
button {
  background: #fff;
  border: 1px solid #8c959f;
  border-radius: 8px;
  color: #24292f;
  cursor: pointer;
  padding: 7px 12px;
}
button.active {
  background: #cf222e;
  border-color: #cf222e;
  color: #fff;
}
span {
  color: #57606a;
  font-size: 12px;
}
</style>
