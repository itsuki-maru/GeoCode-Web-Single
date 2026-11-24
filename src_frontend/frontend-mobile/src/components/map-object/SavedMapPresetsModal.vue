<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import ProgressSpinner from "@/components/common/ProgressSpinner.vue";
import apiClient from "@/axiosClient";
import "./form-modal-buttons.css";
import MapPresetsTable from "./MapPresetsTable.vue";
import {
  cloneSavedMapPreset,
  describeMapPreset,
  isSavedMapPreset,
  mapPresetError,
  type SavedMapPreset,
  type MapPresetPage,
} from "@/utils/answer-map-presets";

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    endpoint: string;
    restoring?: boolean;
    restoreError?: string;
    applying?: boolean;
    applyError?: string;
    applyComplete?: string;
    preparationFailures?: string[];
  }>(),
  { restoring: false, restoreError: "" },
);
const emit = defineEmits<{
  close: [];
  restore: [preset: SavedMapPreset];
  apply: [preset: SavedMapPreset];
  dismissApplyComplete: [];
  pageItems: [items: SavedMapPreset[]];
}>();
const items = shallowRef<SavedMapPreset[]>([]),
  total = ref(0),
  page = ref(1);
const pageSize = 20;
const loading = ref(false),
  busy = ref(false),
  error = ref("");
const deleting = ref<SavedMapPreset | null>(null);
const restoreComplete = ref(false);
const selection = shallowRef<SavedMapPreset | null>(null);
const list = ref<HTMLElement | null>(null);
const applyMessage = ref<InstanceType<typeof MessageModal> | null>(null);
let appliedRowId = "";
let restoreRequested = false;
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const disabled = computed(
  () =>
    loading.value ||
    busy.value ||
    props.restoring ||
    props.applying ||
    restoreComplete.value ||
    !!props.applyComplete,
);
const closeBlocked = computed(
  () =>
    busy.value ||
    props.restoring ||
    props.applying ||
    !!deleting.value ||
    restoreComplete.value ||
    !!props.applyComplete,
);
let epoch = 0,
  request = 0;
let controller: AbortController | undefined;
let previousFocus: HTMLElement | null = null;

const close = () => {
  if (!closeBlocked.value) emit("close");
};
const load = async (requestedPage: number) => {
  const currentEpoch = epoch,
    currentRequest = ++request;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  items.value = [];
  emit("pageItems", []);
  try {
    const data: MapPresetPage = (
      await apiClient.get(props.endpoint, {
        params: { page: requestedPage, page_size: pageSize, versions: "2" },
        signal: controller.signal,
        timeout: 60000,
      })
    ).data;
    if (!props.isOpen || currentEpoch !== epoch || currentRequest !== request) return;
    if (
      !data ||
      !Array.isArray(data.items) ||
      data.items.some((item) => !isSavedMapPreset(item)) ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.page !== requestedPage ||
      data.page_size !== pageSize
    )
      throw Error("Invalid saved conditions");
    items.value = data.items;
    total.value = data.total;
    page.value = requestedPage;
    emit("pageItems", data.items);
  } catch (cause) {
    if (props.isOpen && currentEpoch === epoch && currentRequest === request) {
      const reason = mapPresetError(cause, "保存した検索条件を取得できませんでした。");
      error.value = `${reason} 一覧を閉じて開き直してください。`;
    }
  } finally {
    if (currentEpoch === epoch && currentRequest === request) loading.value = false;
  }
};

watch(
  () => props.isOpen,
  async (open) => {
    epoch++;
    request++;
    controller?.abort();
    busy.value = false;
    loading.value = false;
    deleting.value = null;
    restoreComplete.value = false;
    restoreRequested = false;
    appliedRowId = "";
    selection.value = null;
    error.value = "";
    if (!open) {
      await nextTick();
      if (!props.isOpen && previousFocus?.isConnected) previousFocus.focus();
      return;
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    items.value = [];
    total.value = 0;
    page.value = 1;
    void load(1);
  },
  { immediate: true },
);

const restore = (preset: SavedMapPreset) => {
  if (disabled.value || deleting.value) return;
  // 編集画面には別のオブジェクトを渡し、復元した下書きの編集で一覧が変わらないようにする。
  restoreRequested = true;
  selection.value = preset;
  emit("restore", cloneSavedMapPreset(preset));
};
const apply = (preset: SavedMapPreset) => {
  if (disabled.value || deleting.value) return;
  appliedRowId = preset.id;
  selection.value = preset;
  emit("apply", cloneSavedMapPreset(preset));
};
watch(
  () => props.applyComplete,
  async (message) => {
    await nextTick();
    if (!props.isOpen || props.applyComplete !== message) return;
    if (message) applyMessage.value?.$el.querySelector("button")?.focus();
    else {
      const buttons = list.value?.querySelectorAll<HTMLButtonElement>("[data-preset-apply-id]");
      Array.from(buttons ?? [])
        .find((button) => button.dataset.presetApplyId === appliedRowId)
        ?.focus();
    }
  },
);
watch(
  () => props.restoring,
  (value, previous) => {
    if (!value && previous && restoreRequested) {
      restoreRequested = false;
      if (props.isOpen && !props.restoreError) restoreComplete.value = true;
    }
  },
);
const remove = async () => {
  if (!props.isOpen || !deleting.value || disabled.value) return;
  const currentEpoch = epoch;
  const id = deleting.value.id;
  busy.value = true;
  error.value = "";
  controller = new AbortController();
  try {
    await apiClient.delete(`${props.endpoint}/${encodeURIComponent(id)}`, {
      signal: controller.signal,
      timeout: 60000,
    });
    if (!props.isOpen || currentEpoch !== epoch) return;
    deleting.value = null;
    await load(items.value.length === 1 && page.value > 1 ? page.value - 1 : page.value);
  } catch (cause) {
    if (props.isOpen && currentEpoch === epoch) {
      deleting.value = null;
      error.value = mapPresetError(cause, "検索条件を削除できませんでした。再試行してください。");
    }
  } finally {
    if (currentEpoch === epoch) busy.value = false;
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
    if (event.key === "Escape") {
      if (props.applyComplete) emit("dismissApplyComplete");
      else if (restoreComplete.value) restoreComplete.value = false;
      else if (deleting.value) {
        if (!busy.value) deleting.value = null;
      } else close();
    }
  }
};
onMounted(() => window.addEventListener("keydown", key, true));
onBeforeUnmount(() => {
  epoch++;
  request++;
  controller?.abort();
  window.removeEventListener("keydown", key, true);
});
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="110" :closeOnOverlayClick="!closeBlocked" @close="close">
    <section
      ref="list"
      class="form-settings map-presets"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-presets-title"
    >
      <header class="preset-header">
        <h2 id="map-presets-title">保存した検索条件</h2>
        <button class="btn-close" type="button" :disabled="closeBlocked" @click="close">
          閉じる
        </button>
      </header>
      <p v-if="loading" role="status">読み込み中…</p>
      <p v-if="restoring" role="status">検索条件を呼び出しています…</p>
      <p v-if="applying" role="status">検索条件を適用しています…</p>
      <p v-if="error || applyError || restoreError" class="preset-error" role="alert">
        {{ error || applyError || restoreError }}
      </p>
      <p v-if="preparationFailures?.length" class="preset-error" role="status">
        「{{
          preparationFailures.join("」「")
        }}」の準備に失敗しました。一覧を閉じて開き直してください。
      </p>
      <p v-if="!loading && !error && !items.length">保存した検索条件はありません。</p>
      <MapPresetsTable
        v-if="items.length"
        :items="items"
        :disabled="!!disabled || !!deleting"
        @restore="restore"
        @apply="apply"
        @remove="deleting = $event"
      />
      <nav v-if="pages > 1" class="preset-pagination" aria-label="保存した検索条件のページ">
        <button
          class="btn-close"
          type="button"
          :disabled="disabled || !!deleting || page <= 1"
          @click="load(page - 1)"
        >
          前へ
        </button>
        <span>{{ page }} / {{ pages }}</span>
        <button
          class="btn-close"
          type="button"
          :disabled="disabled || !!deleting || page >= pages"
          @click="load(page + 1)"
        >
          次へ
        </button>
      </nav>
    </section>
  </BaseModal>
  <MessageModal
    class="common-form-confirm"
    :isOpen="isOpen && !!deleting"
    :zIndex="120"
    :busy="busy"
    message="削除しますか？"
    confirmLabel="削除"
    @close="!busy && (deleting = null)"
    @confirm="remove"
  />
  <MessageModal
    v-if="restoreComplete"
    class="common-form-confirm"
    :isOpen="true"
    :zIndex="120"
    message="呼び出しが完了しました。"
    @close="restoreComplete = false"
  />
  <MessageModal
    v-if="applyComplete"
    ref="applyMessage"
    class="common-form-confirm"
    role="dialog"
    aria-modal="true"
    aria-label="処理完了"
    :isOpen="true"
    :zIndex="120"
    :message="applyComplete"
    @close="emit('dismissApplyComplete')"
  />
  <Teleport to="body">
    <ProgressSpinner
      v-if="restoring || applying"
      :isOpen="true"
      :style="{ zIndex: 130 }"
      role="status"
      :aria-label="applying ? '検索条件を適用しています' : '検索条件を呼び出しています'"
    >
      <template v-if="selection" #controls>
        <p class="recall-preview">{{ selection.name }}　{{ describeMapPreset(selection) }}</p>
      </template>
    </ProgressSpinner>
  </Teleport>
</template>

<style scoped>
.map-presets {
  display: flex;
  flex-direction: column;
  width: min(1200px, calc(100vw - 64px));
  max-width: 100%;
  max-height: calc(100dvh - 96px);
  box-sizing: border-box;
  color: #172033;
}
.preset-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ccc;
}
.preset-header h2 {
  min-width: 0;
  margin: 0;
  border: 0;
  font-size: 24px;
  overflow-wrap: anywhere;
}
.preset-header .btn-close {
  flex-shrink: 0;
  margin: 0;
  white-space: nowrap;
}
.table-scroll {
  overflow: auto;
  min-height: 0;
}
.preset-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 16px;
}
.preset-error {
  color: #7c3f00;
  overflow-wrap: anywhere;
}
.recall-preview {
  background: white;
  color: #172033;
  padding: 0.75em 1em;
  max-width: min(70ch, 75vw);
  max-height: 60dvh;
  overflow: auto;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .preset-header h2 {
    font-size: 22px;
  }
}
</style>
