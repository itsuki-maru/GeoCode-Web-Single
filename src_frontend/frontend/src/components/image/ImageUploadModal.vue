<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AxiosProgressEvent } from "axios";
import type { UploadProgressState } from "@/interface";
import BaseModal from "@/components/common/BaseModal.vue";
import { useImageResize } from "@/composables/useImageResize";
import { useVideoPoster } from "@/composables/useVideoPoster";
import { isMP4, isPDF, ALLOWED_MIME_TYPES } from "@/composables/useFileTypeCheck";
import { useImageStore } from "@/stores/images";
import { imageUploadUrl } from "@/router/urls";
import { baseUrl } from "@/setting";
import apiClient from "@/axiosClient";

const props = defineProps<{
  isOpen: boolean;
  isEditingMarker: boolean;
  isHttpsProtocol: boolean;
}>();

const emit = defineEmits<{
  close: [];
  uploaded: [markdownLink: string];
  message: [text: string];
  showUploadedUrl: [url: string, uniqueFileName: string];
  uploadProgressChange: [progress: UploadProgressState];
}>();

const imageStore = useImageStore();
const { resizeImageWithCanvas } = useImageResize();
const { generateVideoPoster } = useVideoPoster();
const MAX_UPLOAD_FILE_SIZE = 100 * 1024 * 1024;

const selectedImageBlob = ref<Blob | null>(null);
const selectedPosterBlob = ref<Blob | null>(null);
const selectedFileName = ref<string>("");
const selectedFileSize = ref<number | null>(null);
const selectedMimeType = ref<string>("");
const selectedPosterFileName = ref<string>("");
const selectedAssetKind = ref<"image" | "video" | "pdf" | "">("");
const isImageSendNow = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const emptyProgressState = (): UploadProgressState => ({
  isOpen: false,
  phase: "preparing",
  percent: null,
  fileName: "",
  message: "",
});

const acceptedFileTypes = "JPEG, PNG, WebP, GIF, MP4, PDF";

const selectedFileTypeLabel = computed(() => {
  switch (selectedAssetKind.value) {
    case "image":
      return "画像";
    case "video":
      return "動画";
    case "pdf":
      return "PDF";
    default:
      return "未選択";
  }
});

const isUploadReady = computed(() => selectedImageBlob.value !== null && !isImageSendNow.value);

const formatFileSize = (size: number | null): string => {
  if (size === null) return "-";
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

watch(isImageSendNow, () => {
  if (!isImageSendNow.value) {
    emit("uploadProgressChange", emptyProgressState());
  }
});

const emitProgress = (progress: UploadProgressState): void => {
  emit("uploadProgressChange", progress);
};

const handleUploadProgress = (progressEvent: AxiosProgressEvent): void => {
  const loaded = progressEvent.loaded ?? 0;
  const total = progressEvent.total ?? undefined;
  const percent = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;

  emitProgress({
    isOpen: true,
    phase: percent === 100 ? "finalizing" : "uploading",
    percent: percent === 100 ? null : percent,
    fileName: selectedFileName.value,
    message:
      percent === 100
        ? "アップロード完了。サーバーで保存処理中です。"
        : "ファイルをアップロードしています。",
    loadedBytes: loaded,
    totalBytes: total,
  });
};

const onImageSelect = async (): Promise<void> => {
  const element = fileInputRef.value;
  if (!element || element.value === "" || element.value === null) {
    emit("message", "画像ファイルを選択してください。");
    return;
  }

  const file = element.files!;
  const fileObj = file[0];
  if (!fileObj) {
    return;
  }
  const fileName = fileObj.name;
  selectedFileSize.value = fileObj.size;
  selectedMimeType.value = fileObj.type;

  if (!ALLOWED_MIME_TYPES.includes(fileObj.type)) {
    emit("message", "許可されていない形式のファイルです。");
    imageClear();
    return;
  }

  if (fileObj.size > MAX_UPLOAD_FILE_SIZE) {
    emit("message", "100MBを超えるファイルはアップロードできません。");
    imageClear();
    return;
  }

  if (fileObj.type.startsWith("image/")) {
    try {
      emitProgress({
        isOpen: true,
        phase: "preparing",
        percent: null,
        fileName,
        message: "画像をアップロード用に最適化しています。",
      });
      selectedImageBlob.value = await resizeImageWithCanvas(fileObj);
      selectedPosterBlob.value = null;
      selectedPosterFileName.value = "";
      selectedAssetKind.value = "image";
    } catch (error) {
      console.error("リサイズエラー: ", error);
      selectedImageBlob.value = null;
    } finally {
      emitProgress(emptyProgressState());
    }
  } else if (fileObj.type === "video/mp4") {
    try {
      emitProgress({
        isOpen: true,
        phase: "preparing",
        percent: null,
        fileName,
        message: "動画のposter画像を生成しています。",
      });
      const poster = await generateVideoPoster(fileObj);
      selectedImageBlob.value = fileObj;
      selectedPosterBlob.value = poster.blob;
      selectedPosterFileName.value = poster.fileName;
      selectedAssetKind.value = "video";
    } catch (error) {
      console.error("動画poster生成エラー: ", error);
      selectedImageBlob.value = fileObj;
      selectedPosterBlob.value = null;
      selectedPosterFileName.value = "";
      selectedAssetKind.value = "video";
      emit("message", "動画のposter画像生成に失敗したため、動画のみアップロードします。");
    } finally {
      emitProgress(emptyProgressState());
    }
  } else {
    selectedImageBlob.value = fileObj;
    selectedPosterBlob.value = null;
    selectedPosterFileName.value = "";
    selectedAssetKind.value = "pdf";
  }
  selectedFileName.value = fileName;
};

const uploadImage = async (): Promise<void> => {
  if (isImageSendNow.value === true) {
    return;
  } else {
    isImageSendNow.value = true;
  }

  if (!selectedImageBlob.value) {
    emit("message", "ファイルを選択してください。");
    isImageSendNow.value = false;
    return;
  }

  const payload = new FormData();
  payload.append("upload_file", selectedImageBlob.value, selectedFileName.value);
  payload.append("asset_kind", selectedAssetKind.value);

  if (selectedAssetKind.value === "video" && selectedPosterBlob.value) {
    payload.append("poster_file", selectedPosterBlob.value, selectedPosterFileName.value);
  }

  try {
    emitProgress({
      isOpen: true,
      phase: "uploading",
      percent: 0,
      fileName: selectedFileName.value,
      message: "ファイルをアップロードしています。",
      loadedBytes: 0,
    });
    const response = await apiClient.post(imageUploadUrl, payload, {
      onUploadProgress: handleUploadProgress,
    });

    const uniqueFileName = response.data["uuid_filename"];

    let imageUrlMarkdown = "";
    if (isMP4(uniqueFileName)) {
      imageUrlMarkdown = `?[${selectedFileName.value}](${baseUrl}/static/images/${uniqueFileName})`;
    } else {
      if (isPDF(uniqueFileName)) {
        imageUrlMarkdown = `[${selectedFileName.value}](${baseUrl}/static/images/${uniqueFileName})`;
      } else {
        imageUrlMarkdown = `![${selectedFileName.value}](${baseUrl}/static/images/${uniqueFileName})`;
      }
    }

    if (props.isEditingMarker) {
      emit("uploaded", imageUrlMarkdown);
      emit("message", "画像を挿入しました。");
    } else {
      if (props.isHttpsProtocol) {
        navigator.clipboard.writeText(imageUrlMarkdown);
        emit("message", "アップロード完了。リンクをクリップボードにコピーしました。");
      } else {
        emit("showUploadedUrl", imageUrlMarkdown, uniqueFileName);
      }
    }

    imageStore.initList();
    imageClear();
  } catch (error) {
    console.error(error);
    emit(
      "message",
      "アップロードエラー。ファイルのサイズが大きすぎる、又はサポート対象外のファイルです。",
    );
  } finally {
    selectedImageBlob.value = null;
    selectedPosterBlob.value = null;
    selectedFileName.value = "";
    selectedFileSize.value = null;
    selectedMimeType.value = "";
    selectedPosterFileName.value = "";
    selectedAssetKind.value = "";
    isImageSendNow.value = false;
    emitProgress(emptyProgressState());
  }
};

const imageClear = (): void => {
  selectedFileName.value = "";
  selectedFileSize.value = null;
  selectedMimeType.value = "";
  selectedImageBlob.value = null;
  selectedPosterBlob.value = null;
  selectedPosterFileName.value = "";
  selectedAssetKind.value = "";
  if (!fileInputRef.value || fileInputRef.value.value === null) return;
  fileInputRef.value.value = "";
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="upload-modal-content">
      <h2 class="modal-h2">画像・動画・PDFの追加</h2>
      <p class="upload-lead">
        追加したいファイルを 1 件選択してアップロードします。対応形式: {{ acceptedFileTypes }}
      </p>
      <p v-if="isEditingMarker" class="upload-context">
        アップロード後、マーカー編集欄へそのまま挿入できます。
      </p>

      <div class="upload-panel">
        <label for="image1" class="file-picker-card">
          <span class="file-picker-title">ファイルを選択</span>
          <span class="file-picker-subtitle">クリックして画像・動画・PDFを追加</span>
        </label>
        <input
          ref="fileInputRef"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,application/pdf"
          id="image1"
          class="file-input"
          @change="onImageSelect"
        />

        <div class="selection-summary" :class="{ empty: !selectedFileName }">
          <template v-if="selectedFileName">
            <div class="summary-row">
              <span class="summary-label">選択中</span>
              <span class="summary-value file-name">{{ selectedFileName }}</span>
            </div>
            <div class="summary-meta">
              <span class="meta-chip">{{ selectedFileTypeLabel }}</span>
              <span class="meta-chip">{{ formatFileSize(selectedFileSize) }}</span>
              <span v-if="selectedMimeType" class="meta-chip meta-chip-muted">{{
                selectedMimeType
              }}</span>
            </div>
          </template>
          <p v-else class="empty-text">
            まだファイルは選択されていません。100MB までアップロードできます。
          </p>
        </div>

        <div class="action-row">
          <button
            type="submit"
            class="btn-file-upload"
            :disabled="!isUploadReady"
            @click.prevent="uploadImage()"
          >
            {{ isImageSendNow ? "アップロード中..." : "アップロード" }}
          </button>
          <button
            type="button"
            class="btn-secondary"
            :disabled="!selectedFileName"
            @click.prevent="imageClear()"
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
.upload-modal-content {
  width: min(40vw, 560px);
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.upload-lead,
.upload-context {
  margin: 12px 0 0;
  line-height: 1.5;
}

.upload-context {
  color: #3559a9;
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

@media (max-width: 900px) {
  .upload-modal-content {
    width: min(70vw, 560px);
  }
}

@media (max-width: 640px) {
  .upload-modal-content {
    width: min(90vw, 560px);
  }

  .action-row {
    flex-direction: column;
  }
}
</style>
