<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import apiClient from "@/axiosClient";
import "./form-modal-buttons.css";
import {
  clonePresetDraft,
  describeMapPreset,
  isSavedMapPreset,
  mapPresetError,
  mapPresetKindLabel,
  type MapPresetPage,
  type SavedMapPreset,
} from "@/utils/answer-map-presets";

const props = withDefaults(
  defineProps<{ isOpen: boolean; endpoint: string; restoring?: boolean; restoreError?: string }>(),
  { restoring: false, restoreError: "" },
);
const emit = defineEmits<{ close: []; restore: [preset: SavedMapPreset] }>();
const items = ref<SavedMapPreset[]>([]),
  total = ref(0),
  page = ref(1);
const pageSize = 20;
const loading = ref(false),
  busy = ref(false),
  error = ref("");
const deleting = ref<SavedMapPreset | null>(null);
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const disabled = computed(() => loading.value || busy.value || props.restoring);
let epoch = 0,
  request = 0;
let controller: AbortController | undefined;
let previousFocus: HTMLElement | null = null;

const close = () => {
  if (!busy.value && !props.restoring && !deleting.value) emit("close");
};
const load = async (requestedPage: number) => {
  const currentEpoch = epoch,
    currentRequest = ++request;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  try {
    const data: MapPresetPage = (
      await apiClient.get(props.endpoint, {
        params: { page: requestedPage, page_size: pageSize },
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
  } catch (cause) {
    if (props.isOpen && currentEpoch === epoch && currentRequest === request)
      error.value = mapPresetError(
        cause,
        "保存した検索条件を取得できませんでした。再読み込みしてください。",
      );
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
  emit("restore", { ...preset, ...clonePresetDraft(preset) });
};
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
const dateLabel = (value: string) => {
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
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
      if (deleting.value) {
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
  <BaseModal
    :isOpen="isOpen"
    :zIndex="110"
    :closeOnOverlayClick="!busy && !restoring && !deleting"
    @close="close"
  >
    <section
      class="form-settings map-presets"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-presets-title"
    >
      <h2 id="map-presets-title" class="modal-h2">保存した検索条件</h2>
      <div class="preset-toolbar">
        <span>{{ total }}件</span>
        <button
          class="btn-close"
          type="button"
          :disabled="disabled || !!deleting"
          @click="load(page)"
        >
          再読み込み
        </button>
      </div>
      <p v-if="loading" role="status">読み込み中…</p>
      <p v-if="restoring" role="status">検索条件を呼び出しています…</p>
      <p v-if="error || restoreError" class="preset-error" role="alert">
        {{ error || restoreError }}
      </p>
      <p v-if="!loading && !error && !items.length">保存した検索条件はありません。</p>
      <div v-if="items.length" class="table-scroll">
        <table aria-label="保存した検索条件一覧">
          <thead>
            <tr>
              <th>種別</th>
              <th>名前</th>
              <th>共通フォーム</th>
              <th>条件概要</th>
              <th>保存日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="preset in items" :key="preset.id">
              <td>{{ mapPresetKindLabel(preset.kind) }}</td>
              <td>{{ preset.name }}</td>
              <td>{{ preset.display.form_label || "一覧と同じ範囲" }}</td>
              <td class="preset-description">{{ describeMapPreset(preset) }}</td>
              <td>{{ dateLabel(preset.create_at) }}</td>
              <td>
                <div class="row-actions">
                  <button
                    class="btn-close"
                    type="button"
                    :disabled="disabled || !!deleting"
                    @click="restore(preset)"
                  >
                    呼び出し
                  </button>
                  <button
                    class="btn-close"
                    type="button"
                    :disabled="disabled || !!deleting"
                    @click="deleting = preset"
                  >
                    削除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
      <div class="preset-actions">
        <button
          class="btn-close"
          type="button"
          :disabled="busy || restoring || !!deleting"
          @click="close"
        >
          閉じる
        </button>
      </div>
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
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
  margin: 8px 0 16px;
}
.preset-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.table-scroll {
  overflow: auto;
  min-height: 0;
}
table {
  width: 100%;
  min-width: 980px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 14px;
}
th,
td {
  border: 1px solid #ccc;
  padding: 6px 13px;
  text-align: center;
  overflow-wrap: anywhere;
}
th {
  background: rgb(44, 52, 78);
  color: white;
}
th:nth-child(1) {
  width: 11%;
}
th:nth-child(2) {
  width: 15%;
}
th:nth-child(3) {
  width: 13%;
}
th:nth-child(4) {
  width: 28%;
}
th:nth-child(5) {
  width: 14%;
}
th:nth-child(6) {
  width: 19%;
}
tbody tr {
  background: white;
}
tbody tr:nth-child(even) {
  background: #eee;
}
tbody tr:hover {
  background: #69a5b8;
}
.preset-description {
  white-space: pre-line;
  text-align: left;
}
.row-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}
.row-actions .btn-close {
  padding: 6px 10px;
  white-space: nowrap;
}
.preset-actions,
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
</style>
