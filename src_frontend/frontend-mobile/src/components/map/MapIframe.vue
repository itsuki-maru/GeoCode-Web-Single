<script setup lang="ts">
import { onMounted } from "vue";

const props = defineProps<{
  srcUrl: string;
  allowedOrigins: string;
}>();

const emit = defineEmits<{
  mapReloadRequested: [layerId?: string | null];
  loginRedirect: [];
  previewImage: [filename: string];
}>();

const focusMarker = (id: string, lat: number, lng: number): void => {
  const iframe = document.getElementById("map-iframe") as HTMLIFrameElement;
  if (iframe && iframe instanceof HTMLIFrameElement && iframe.contentWindow) {
    const messageData = { id: id, lat: lat, lng: lng, type: "focus" };
    iframe.contentWindow.postMessage(messageData, "*");
  }
};

onMounted(() => {
  window.addEventListener("message", function (event) {
    const allowedOriginsList: string[] = props.allowedOrigins.split(",");
    if (!allowedOriginsList.includes(event.origin)) {
      console.warn("Cross origin:", event.origin);
      return;
    }
    if (event.data.type === "callParentReload") {
      emit("mapReloadRequested", event.data.layerId ?? null);
    } else if (event.data.type === "callParentLoginRedirect") {
      emit("loginRedirect");
    } else if (event.data.type === "callParentImagePreview") {
      emit("previewImage", event.data.message);
    }
  });
});

defineExpose({ focusMarker });
</script>

<template>
  <div class="map-contents">
    <iframe :src="srcUrl" frameborder="0" id="map-iframe" allow="geolocation"></iframe>
  </div>
</template>

<style scoped>
.map-contents {
  text-align: center;
}

iframe {
  width: 100%;
  height: 100vh;
}
</style>
