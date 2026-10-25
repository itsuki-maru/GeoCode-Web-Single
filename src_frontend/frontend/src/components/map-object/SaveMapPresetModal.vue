<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import apiClient from "@/axiosClient";
import "./form-modal-buttons.css";
import {
  clonePresetDraft,
  isSavedMapPreset,
  mapPresetError,
  mapPresetKindLabel,
  type MapPresetDraft,
  type SavedMapPreset,
} from "@/utils/answer-map-presets";

const props = defineProps<{ isOpen: boolean; draft: MapPresetDraft | null; endpoint: string }>();
const emit = defineEmits<{ close: []; saved: [preset: SavedMapPreset] }>();
const name = ref(""),
  error = ref(""),
  busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const snapshot = shallowRef<MapPresetDraft | null>(null);
let sequence = 0;
let controller: AbortController | undefined;
let previousFocus: HTMLElement | null = null;
const close = () => {
  if (!busy.value) emit("close");
};
watch(
  () => props.isOpen,
  async (open) => {
    sequence++;
    controller?.abort();
    busy.value = false;
    error.value = "";
    if (!open) {
      snapshot.value = null;
      await nextTick();
      if (!props.isOpen && previousFocus?.isConnected) previousFocus.focus();
      return;
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    name.value = "";
    try {
      snapshot.value = props.draft ? clonePresetDraft(props.draft) : null;
      if (!snapshot.value) throw Error("保存する検索条件がありません。");
    } catch (cause) {
      snapshot.value = null;
      error.value = (cause as Error).message;
    }
    await nextTick();
    if (props.isOpen) input.value?.focus();
  },
  { immediate: true },
);
const save = async () => {
  if (!props.isOpen || busy.value || !snapshot.value) return;
  const trimmed = name.value.trim();
  if (!trimmed || [...trimmed].length > 100) {
    error.value = "条件名を1〜100文字で入力してください。";
    return;
  }
  const seq = ++sequence;
  busy.value = true;
  error.value = "";
  controller = new AbortController();
  try {
    const data = (
      await apiClient.post(
        props.endpoint,
        { ...snapshot.value, name: trimmed, schema_version: 1 },
        { signal: controller.signal, timeout: 60000 },
      )
    ).data;
    if (!props.isOpen || seq !== sequence) return;
    if (!isSavedMapPreset(data)) throw Error("Invalid saved condition");
    emit("saved", data);
  } catch (cause) {
    if (props.isOpen && seq === sequence)
      error.value = mapPresetError(
        cause,
        "検索条件を保存できませんでした。入力を確認して再試行してください。",
      );
  } finally {
    if (seq === sequence) busy.value = false;
  }
};
const key = (event: KeyboardEvent) => {
  if (!props.isOpen) return;
  if (
    event.key === "Escape" ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p")
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") close();
  }
};
onMounted(() => window.addEventListener("keydown", key, true));
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
  window.removeEventListener("keydown", key, true);
});
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="110" :closeOnOverlayClick="!busy" @close="close">
    <form
      class="form-settings map-preset-save"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-preset-save-title"
      @submit.prevent="save"
    >
      <h2 id="map-preset-save-title" class="modal-h2">検索条件を保存</h2>
      <p v-if="draft">{{ mapPresetKindLabel(draft.kind) }}の入力中の条件を保存します。</p>
      <label
        >条件名<input
          ref="input"
          v-model="name"
          aria-label="条件名"
          maxlength="100"
          :disabled="busy"
          autocomplete="off"
      /></label>
      <p v-if="error" class="preset-error" role="alert">{{ error }}</p>
      <div class="preset-actions">
        <button class="btn-close" type="button" :disabled="busy" @click="close">閉じる</button>
        <button class="btn-close" type="submit" :disabled="busy || !snapshot">
          {{ busy ? "保存中…" : "保存" }}
        </button>
      </div>
    </form>
  </BaseModal>
</template>

<style scoped>
.map-preset-save {
  width: min(520px, calc(100vw - 64px));
  max-width: 100%;
  box-sizing: border-box;
  color: #172033;
}
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
  margin: 8px 0 20px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
input {
  font: inherit;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid #aeb9c8;
  border-radius: 6px;
  background: white;
  color: #172033;
}
.preset-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 20px;
}
.preset-error {
  color: #7c3f00;
  overflow-wrap: anywhere;
}
</style>
