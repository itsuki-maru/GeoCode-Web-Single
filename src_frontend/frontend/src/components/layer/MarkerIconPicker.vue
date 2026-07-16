<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useMarkerIconStore } from "@/stores/markerIcons";
import { baseUrl } from "@/setting";

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{
  "update:modelValue": [id: string | null];
  message: [text: string];
}>();
const store = useMarkerIconStore();
// const query = ref("");
const uploading = ref(false);
const selectedFile = ref<File | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const icons = computed(() => store.icons);
const isUploadReady = computed(() => selectedFile.value !== null && !uploading.value);
const iconUrl = (name: string) => `${baseUrl}/static/marker-icons/${name}`;
const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

onMounted(() => store.load());
const formatFileSize = (size: number): string => {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const clearFile = (): void => {
  selectedFile.value = null;
  if (fileInputRef.value) fileInputRef.value.value = "";
};

const selectFile = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    selectedFile.value = null;
    return;
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    emit("message", "PNG、JPEG、GIF、WebP形式の画像を選択してください。");
    clearFile();
    return;
  }
  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    emit("message", "5MBを超える画像はアップロードできません。");
    clearFile();
    return;
  }
  selectedFile.value = file;
};

const upload = async (): Promise<void> => {
  if (!selectedFile.value || uploading.value) return;
  uploading.value = true;
  try {
    await store.upload(selectedFile.value);
    emit("message", "アイコンをアップロードしました。");
    clearFile();
  } catch {
    emit("message", "アイコンのアップロードに失敗しました。");
  } finally {
    uploading.value = false;
  }
};

const remove = async (id: string) => {
  try {
    await store.remove(id);
    if (props.modelValue === id) emit("update:modelValue", null);
    emit("message", "アイコンを削除しました。");
  } catch {
    emit("message", "アイコンの削除に失敗しました。");
  }
};
</script>

<template>
  <section class="icon-picker">
    <div class="upload-panel">
      <label class="file-picker-card">
        <span class="file-picker-title">アイコン画像を選択</span>
        <span class="file-picker-subtitle">クリックして PNG・JPEG・GIF・WebP を追加</span>
        <input
          ref="fileInputRef"
          type="file"
          class="file-input"
          accept="image/png,image/jpeg,image/gif,image/webp"
          :disabled="uploading"
          @change="selectFile"
        />
      </label>
      <div class="selection-summary" :class="{ empty: !selectedFile }">
        <template v-if="selectedFile">
          <span class="summary-label">選択中</span>
          <strong class="file-name">{{ selectedFile.name }}</strong>
          <div class="summary-meta">
            <span class="meta-chip">画像</span>
            <span class="meta-chip">{{ formatFileSize(selectedFile.size) }}</span>
            <span class="meta-chip meta-chip-muted">{{ selectedFile.type }}</span>
          </div>
        </template>
        <p v-else class="empty-text">
          まだファイルは選択されていません。5MB までアップロードできます。
        </p>
      </div>
      <div class="upload-actions">
        <button type="button" class="btn-file-upload" :disabled="!isUploadReady" @click="upload">
          {{ uploading ? "アップロード中..." : "アップロード" }}
        </button>
        <button
          type="button"
          class="btn-secondary"
          :disabled="!selectedFile || uploading"
          @click="clearFile"
        >
          選択をクリア
        </button>
      </div>
    </div>

    <div class="library-panel">
      <div class="library-heading">
        <strong>使用できるアイコン</strong>
        <span>{{ icons.length }} 件</span>
      </div>
      <!--
      <form class="search-row" @submit.prevent="store.load(query.trim())">
        <input v-model="query" maxlength="100" placeholder="アイコン名で検索" />
        <button type="submit">検索</button>
        <button
          type="button"
          @click="
            query = '';
            store.load();
          "
        >
          クリア
        </button>
      </form>
      -->
      <div class="icon-grid">
        <button
          type="button"
          class="icon-card default-icon"
          :class="{ selected: modelValue === null }"
          @click="emit('update:modelValue', null)"
        >
          <span class="default-marker">標準</span>
        </button>
        <div
          v-for="icon in icons"
          :key="icon.id"
          class="icon-card"
          :class="{ selected: modelValue === icon.id }"
        >
          <button type="button" class="select-icon" @click="emit('update:modelValue', icon.id)">
            <img :src="iconUrl(icon.uuid_filename)" :alt="icon.filename" />
            <span>{{ icon.filename }}</span>
          </button>
          <button type="button" class="delete-icon" title="削除" @click="remove(icon.id)">×</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.icon-picker {
  margin-top: 18px;
  text-align: left;
}
.toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.upload-button {
  padding: 6px 10px;
  border: 1px solid #777;
  border-radius: 4px;
  cursor: pointer;
}
.upload-button input {
  display: none;
}
.icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  margin-top: 10px;
}
.icon-card {
  position: relative;
  min-height: 68px;
  border: 2px solid transparent;
  background: #f3f3f3;
  border-radius: 6px;
}
.icon-card.selected {
  border-color: #1769aa;
}
.select-icon {
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}
.select-icon img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}
.select-icon span {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delete-icon {
  position: absolute;
  top: 0;
  right: 2px;
  border: 0;
  background: transparent;
  color: #b00020;
}
.default-marker,
.default-icon {
  font-size: 13px;
  color: #111;
}
.section-heading h3 {
  margin: 0;
  font-size: 18px;
}

.section-heading p {
  margin: 6px 0 0;
  color: #5d6b83;
  font-size: 13px;
}

.upload-panel,
.library-panel {
  margin-top: 14px;
  padding: 16px;
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
  padding: 20px 16px;
  border: 2px dashed #7d96d7;
  border-radius: 14px;
  background-color: #f8fbff;
  color: #1d3776;
  text-align: center;
  cursor: pointer;
}

.file-picker-title {
  font-size: 16px;
  font-weight: 700;
}

.file-picker-subtitle {
  color: #49619b;
  font-size: 13px;
}

.selection-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #dbe3f0;
  border-radius: 14px;
  background-color: #fff;
}

.selection-summary.empty {
  background-color: #f9fafc;
}

.summary-label {
  color: #5d6b83;
  font-size: 12px;
}

.file-name {
  overflow-wrap: anywhere;
  color: #1e2430;
}

.summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
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

.upload-actions,
.search-row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.upload-actions button {
  flex: 1;
  min-height: 42px;
  border-radius: 10px;
}

.btn-file-upload {
  background: rgb(28, 58, 190);
  color: #fff;
}

.btn-secondary {
  background: #d9deea;
  color: #25304a;
}

button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.library-heading {
  display: flex;
  justify-content: space-between;
  color: #25304a;
}

.library-heading span {
  color: #66758d;
  font-size: 13px;
}

.search-row input {
  min-width: 0;
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #b9c4d6;
  border-radius: 8px;
}

.search-row button {
  padding: 8px 12px;
}

.icon-grid {
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
  max-height: 250px;
  margin-top: 14px;
  padding: 2px;
}

.icon-card {
  min-height: 76px;
  overflow: hidden;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 1px 4px rgb(31 48 82 / 12%);
}

.icon-card.selected {
  border-color: #315fca;
  background: #f2f6ff;
}

.select-icon {
  justify-content: center;
  gap: 4px;
  padding: 6px;
}

.select-icon img {
  width: 40px;
  height: 40px;
}

.select-icon span {
  font-size: 12px;
  color: #111;
}

.delete-icon {
  top: 3px;
  right: 4px;
  width: 25px;
  height: 25px;
  padding: 0;
  border-radius: 50%;
  background: #fff;
  line-height: 23px;
}
</style>
