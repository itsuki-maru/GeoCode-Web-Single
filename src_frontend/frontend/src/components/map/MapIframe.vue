<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  srcUrl: string;
  height: number;
  allowedOrigins: string;
}>();

const emit = defineEmits<{
  mapReloadRequested: [layerId?: string | null];
  loginRedirect: [];
  previewImage: [filename: string];
}>();

const filteredObjectIds = ref<{ markerIds: string[] | null; shapeIds: string[] | null }>({
  markerIds: null,
  shapeIds: null,
});

const postMessageToMap = (messageData: Record<string, unknown>): void => {
  const iframe = document.getElementById("map-iframe") as HTMLIFrameElement;
  if (iframe && iframe instanceof HTMLIFrameElement && iframe.contentWindow) {
    iframe.contentWindow.postMessage(messageData, "*");
  }
};

const focusObject = (
  objectType: "marker" | "shape",
  id: string,
  lat: number,
  lng: number,
): void => {
  postMessageToMap({ id: objectType === "marker" ? id : "", lat, lng, type: "focus" });
};

const filterMapObjects = (markerIds: string[] | null, shapeIds: string[] | null): void => {
  const cloneableMarkerIds = Array.isArray(markerIds) ? [...markerIds] : null;
  const cloneableShapeIds = Array.isArray(shapeIds) ? [...shapeIds] : null;
  filteredObjectIds.value = {
    markerIds: cloneableMarkerIds,
    shapeIds: cloneableShapeIds,
  };
  postMessageToMap({
    markerIds: cloneableMarkerIds,
    shapeIds: cloneableShapeIds,
    type: "mapObjectFilter",
  });
};

const handleIframeLoad = (): void => {
  if (filteredObjectIds.value.markerIds !== null || filteredObjectIds.value.shapeIds !== null) {
    filterMapObjects(filteredObjectIds.value.markerIds, filteredObjectIds.value.shapeIds);
  }
  const mapUrl = new URL(props.srcUrl, window.location.origin);
  const latitude = Number(mapUrl.searchParams.get("latitude"));
  const longitude = Number(mapUrl.searchParams.get("longitude"));
  if (
    !mapUrl.searchParams.has("marker_id") &&
    mapUrl.searchParams.has("latitude") &&
    mapUrl.searchParams.has("longitude") &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  ) {
    focusObject("shape", "", latitude, longitude);
  }
};

const handleMessage = async (event: MessageEvent): Promise<void> => {
  const allowedOriginsList: string[] = props.allowedOrigins.split(",");
  if (!allowedOriginsList.includes(event.origin)) {
    console.warn("Cross origin:", event.origin);
    return;
  }
  if (event.data.type === "callParentFunction") {
    emit("previewImage", event.data.message);
  } else if (event.data.type === "callParentReload") {
    emit("mapReloadRequested", event.data.layerId ?? null);
  } else if (event.data.type === "callParentLoginRedirect") {
    emit("loginRedirect");
  }
};

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
});

defineExpose({ focusObject, filterMapObjects });
</script>

<template>
  <div class="iframe-area">
    <iframe
      :src="srcUrl"
      frameborder="0"
      id="map-iframe"
      :style="{ height: height + 'vh' }"
      @load="handleIframeLoad"
    ></iframe>
  </div>
</template>

<style scoped>
iframe {
  width: 100%;
}
</style>
