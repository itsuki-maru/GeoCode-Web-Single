<script setup lang="ts">
import { computed, ref } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import { isMP4 } from "@/composables/useFileTypeCheck";
import { useImageStore } from "@/stores/images";
import { imageDeleteUrl } from "@/router/urls";
import { baseUrl } from "@/setting";
import apiClient from "@/axiosClient";
import { AxiosError } from "axios";

const props = defineProps<{
  isOpen: boolean;
  imageFilename: string;
  imageId: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
  loginRedirect: [];
}>();

const imageStore = useImageStore();
const showDeleteConfirm = ref(false);
const imageUrl = computed(() => {
  if (!props.imageFilename) return "";
  const prefix = props.readOnly ? baseUrl : `${baseUrl}/static/images/`;
  return `${prefix}${props.imageFilename}`;
});

const onDelete = async (): Promise<void> => {
  if (!props.imageId) {
    showDeleteConfirm.value = false;
    return;
  }
  try {
    await apiClient.delete(imageDeleteUrl + `/${props.imageId}`);
    imageStore.deleteImage(props.imageId);
    emit("message", "削除しました。");
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const status = axiosError.response.status;
        switch (status) {
          case 400:
            emit("message", `${axiosError.response.data}`);
            break;
          case 401:
            emit("loginRedirect");
            break;
          default:
            console.error(`An error occurred: ${status}`, axiosError.response.data);
        }
      }
    }
  }
  showDeleteConfirm.value = false;
  emit("close");
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="readOnly ? 15 : 2" @close="emit('close')">
    <div class="preview-content">
      <div class="image-preview">
        <video v-if="imageUrl && isMP4(imageFilename)" controls :src="imageUrl" id="img-preview"></video>
        <img v-else-if="imageUrl" :src="imageUrl" id="img-preview" alt="プレビュー" />
      </div>
      <div class="btn-zone" v-if="!readOnly">
        <button @click.prevent="showDeleteConfirm = true">削除</button>
        <button @click.prevent="emit('close')">閉じる</button>
      </div>
    </div>
  </BaseModal>

  <ConfirmModal
    :isOpen="showDeleteConfirm"
    title="削除の確認"
    message="本当にこのデータを削除しますか？"
    @confirm="onDelete"
    @cancel="showDeleteConfirm = false"
  />
</template>

<style scoped>
.preview-content {
  max-width: 50vw;
  height: auto;
  width: auto;
  background: #fff;
  text-align: center;
}

.preview-content :deep(#img-preview) {
  max-width: 100%;
  max-height: 70vh;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}
</style>
