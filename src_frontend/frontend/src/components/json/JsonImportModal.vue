<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { importJsonUrl } from "@/router/urls";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectStore } from "@/stores/mapobjects";
import apiClient from "@/axiosClient";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
  showProgress: [show: boolean];
}>();

const layersStore = useLayersStore();
const mapobjStore = useMapObjectStore();
const isJsonSendNow = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const selectedFileName = ref("");
const selectedFileSize = ref<number | null>(null);
const selectedMimeType = ref("");

const isImportReady = computed(() => selectedFileName.value !== "" && !isJsonSendNow.value);

const formatFileSize = (size: number | null): string => {
  if (size === null) return "-";
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

watch(isJsonSendNow, () => {
  emit("showProgress", isJsonSendNow.value);
});

const onJsonSelect = (): void => {
  const element = fileInputRef.value;
  if (!element || !element.files || element.files.length === 0) {
    clearJson();
    return;
  }

  const fileObj = element.files[0];
  if (fileObj) {
    selectedFileName.value = fileObj.name;
    selectedFileSize.value = fileObj.size;
    selectedMimeType.value = fileObj.type;
  }
};

const importJsonData = async (): Promise<void> => {
  if (isJsonSendNow.value === true) {
    return;
  } else {
    isJsonSendNow.value = true;
  }

  const payload = new FormData();
  const element = fileInputRef.value;
  if (!element || element.value === "" || element.value === null) {
    emit("message", "JSONファイルを選択してください。");
    isJsonSendNow.value = false;
    return;
  }

  const file = element.files!;
  const fileObj = file[0];
  if (!fileObj) {
    isJsonSendNow.value = false;
    return;
  }
  payload.append("upload_file", fileObj);

  try {
    await apiClient.post(importJsonUrl, payload);
    emit("message", "データのインポートが完了しました。");
    layersStore.initList();
    mapobjStore.initList();
    clearJson();
    isJsonSendNow.value = false;
  } catch (error) {
    isJsonSendNow.value = false;
    emit("message", "インポートに失敗しました。データ形式が正しくありません。");
  }
};

const clearJson = (): void => {
  selectedFileName.value = "";
  selectedFileSize.value = null;
  selectedMimeType.value = "";
  if (!fileInputRef.value || fileInputRef.value.value === null) return;
  fileInputRef.value.value = "";
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="json-import-content">
      <h2 class="modal-h2">データのインポート（JSON）</h2>
      <p class="upload-lead">エクスポート済みの JSON ファイルを 1 件選択してインポートします。</p>

      <div class="upload-panel">
        <label for="jsonfile" class="file-picker-card">
          <span class="file-picker-title">JSONファイルを選択</span>
          <span class="file-picker-subtitle">クリックして .json ファイルを追加</span>
        </label>
        <input
          ref="fileInputRef"
          type="file"
          accept=".json,application/json"
          id="jsonfile"
          class="file-input"
          @change="onJsonSelect"
        />

        <div class="selection-summary" :class="{ empty: !selectedFileName }">
          <template v-if="selectedFileName">
            <div class="summary-row">
              <span class="summary-label">選択中</span>
              <span class="summary-value file-name">{{ selectedFileName }}</span>
            </div>
            <div class="summary-meta">
              <span class="meta-chip">JSON</span>
              <span class="meta-chip">{{ formatFileSize(selectedFileSize) }}</span>
              <span v-if="selectedMimeType" class="meta-chip meta-chip-muted">{{
                selectedMimeType
              }}</span>
            </div>
          </template>
          <p v-else class="empty-text">
            まだファイルは選択されていません。インポート前に内容を確認してください。
          </p>
        </div>

        <div class="action-row">
          <button
            type="submit"
            class="btn-file-upload"
            :disabled="!isImportReady"
            @click.prevent="importJsonData()"
          >
            {{ isJsonSendNow ? "インポート中..." : "インポート" }}
          </button>
          <button
            type="button"
            class="btn-secondary"
            :disabled="!selectedFileName"
            @click.prevent="clearJson()"
          >
            選択をクリア
          </button>
        </div>
      </div>
      <div class="btn-zone">
        <button @click.prevent="emit('close')">閉じる</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.json-import-content {
  width: min(40vw, 560px);
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.upload-lead {
  margin: 12px 0 0;
  line-height: 1.5;
}

.upload-panel {
  margin-top: 18px;
  padding: 18px;
  border: 1px solid #d5dce8;
  border-radius: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f4f7fb 100%);
}

.file-input {
  display: none;
}

.file-picker-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px 18px;
  border: 2px dashed #7d96d7;
  border-radius: 14px;
  background-color: #f8fbff;
  color: #1d3776;
  text-align: center;
  cursor: pointer;
}

.file-picker-title {
  font-size: 17px;
  font-weight: 700;
}

.file-picker-subtitle {
  font-size: 13px;
  color: #49619b;
}

.selection-summary {
  margin-top: 14px;
  padding: 14px;
  border-radius: 14px;
  background-color: #ffffff;
  border: 1px solid #dbe3f0;
}

.selection-summary.empty {
  background-color: #f9fafc;
}

.summary-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-label {
  font-size: 12px;
  color: #5d6b83;
}

.summary-value {
  color: #1e2430;
}

.file-name {
  font-weight: 700;
  word-break: break-all;
}

.summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.meta-chip {
  padding: 4px 10px;
  border-radius: 999px;
  background-color: #e8eefb;
  color: #28407d;
  font-size: 12px;
}

.meta-chip-muted {
  background-color: #eef1f6;
  color: #556173;
}

.empty-text {
  margin: 0;
  color: #66758d;
  line-height: 1.5;
}

.action-row {
  display: flex;
  gap: 12px;
  margin-top: 18px;
}

.action-row button {
  flex: 1;
}

.btn-file-upload {
  min-height: 44px;
  font-size: 14px;
  background: rgb(28, 58, 190);
  color: #fff;
}

.btn-secondary {
  min-height: 44px;
  background: #d9deea;
  color: #25304a;
}

.btn-file-upload:disabled,
.btn-secondary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 900px) {
  .json-import-content {
    width: min(70vw, 560px);
  }
}

@media (max-width: 640px) {
  .json-import-content {
    width: min(90vw, 560px);
  }

  .action-row {
    flex-direction: column;
  }
}
</style>
