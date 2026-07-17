<script setup lang="ts">
import { computed } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { isMP4 } from "@/composables/useFileTypeCheck";
import { baseUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  imageSrc: string;
  imageId: string;
}>();

const emit = defineEmits<{
  close: [];
  deleteRequest: [id: string];
}>();

const imageUrl = computed(() =>
  props.imageSrc ? `${baseUrl}/static/images/${props.imageSrc}` : "",
);
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="13" @close="emit('close')">
    <div class="content-image-view">
      <video v-if="imageUrl && isMP4(imageSrc)" controls :src="imageUrl" width="90%" height="90%"></video>
      <img v-else-if="imageUrl" :src="imageUrl" width="90%" height="90%" alt="プレビュー" />
      <div class="btn-zone">
        <button @click.prevent="emit('close')">閉じる</button>
        <button @click.prevent="emit('deleteRequest', imageId)" class="btn-delete">削除</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.content-image-view {
  max-width: 85%;
  height: auto;
  width: auto;
  padding: 1em;
  background: #fff;
  text-align: center;
  border-radius: 10px;
  margin: auto;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

.btn-delete {
  background-color: #961414a6;
}
</style>
