<script setup lang="ts">
import ImagePreviewFromIframeModal from "@/components/map/ImagePreviewFromIframeModal.vue";
import { baseUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  imageSrc: string;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <ImagePreviewFromIframeModal :isOpen="isOpen" :zIndex="1000" @close="emit('close')">
    <div class="content-image-view-from-iframe">
      <iframe :src="`${baseUrl}${imageSrc}`" frameborder="0"></iframe>
    </div>
  </ImagePreviewFromIframeModal>
</template>

<style scoped>
.content-image-view-from-iframe {
  overflow: auto;
  max-width: 100%;
  width: 100%;
  padding: 0;
  background: transparent;
  text-align: center;
}

iframe {
  width: 100%;
  height: 100dvh;
}
</style>
