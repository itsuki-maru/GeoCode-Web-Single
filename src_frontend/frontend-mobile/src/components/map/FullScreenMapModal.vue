<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import ImagePreviewFromIframeModal from "@/components/map/ImagePreviewFromIframeModal.vue";
import { baseUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  imageSrc: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const previewIframe = ref<HTMLIFrameElement | null>(null);

const handlePreviewMessage = (event: MessageEvent): void => {
  const iframe = previewIframe.value;
  if (!props.isOpen || !iframe?.contentWindow || event.source !== iframe.contentWindow) return;

  const previewOrigin = new URL(iframe.src, window.location.href).origin;
  if (event.origin !== previewOrigin) return;
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.type !== "callParentImagePreview") return;

  emit("close");
};

onMounted(() => {
  window.addEventListener("message", handlePreviewMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handlePreviewMessage);
});
</script>

<template>
  <ImagePreviewFromIframeModal :isOpen="isOpen" :zIndex="1000" @close="emit('close')">
    <div class="content-image-view-from-iframe">
      <iframe ref="previewIframe" :src="`${baseUrl}${imageSrc}`" frameborder="0"></iframe>
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
