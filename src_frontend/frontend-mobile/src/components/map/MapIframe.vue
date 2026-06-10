<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  srcUrl: string;
  allowedOrigins: string;
}>();

const emit = defineEmits<{
  mapReloadRequested: [layerId?: string | null];
  loginRedirect: [];
  previewImage: [filename: string];
}>();

const filteredMarkerIds = ref<string[] | null>(null);

const postMessageToMap = (messageData: Record<string, unknown>): void => {
  const iframe = document.getElementById("map-iframe") as HTMLIFrameElement;
  if (iframe && iframe instanceof HTMLIFrameElement && iframe.contentWindow) {
    iframe.contentWindow.postMessage(messageData, "*");
  }
};

const focusMarker = (id: string, lat: number, lng: number): void => {
  postMessageToMap({ id: id, lat: lat, lng: lng, type: "focus" });
};

const filterMarkers = (ids: string[] | null): void => {
  filteredMarkerIds.value = ids;
  postMessageToMap({ ids: ids, type: "markerFilter" });
};

const handleIframeLoad = (): void => {
  if (filteredMarkerIds.value !== null) {
    filterMarkers(filteredMarkerIds.value);
  }
};

const handleMessage = (event: MessageEvent): void => {
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
};

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
});

defineExpose({ focusMarker, filterMarkers });
</script>

<template>
  <div class="map-contents">
    <iframe
      :src="srcUrl"
      frameborder="0"
      id="map-iframe"
      allow="geolocation"
      @load="handleIframeLoad"
    ></iframe>
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
