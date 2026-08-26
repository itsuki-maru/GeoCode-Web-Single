<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { MapObjectUpdatePayload } from "@/interface";

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
let updateRequestSequence = 0;
const pendingUpdateRequests = new Map<
  string,
  { resolve: (updated: boolean) => void; timer: number }
>();

const getMapIframe = (): HTMLIFrameElement | null => {
  const iframe = document.getElementById("map-iframe");
  return iframe instanceof HTMLIFrameElement ? iframe : null;
};

const postMessageToMap = (messageData: Record<string, unknown>): boolean => {
  const iframe = getMapIframe();
  if (!iframe?.contentWindow) return false;
  const targetOrigin = new URL(props.srcUrl, window.location.origin).origin;
  iframe.contentWindow.postMessage(messageData, targetOrigin);
  return true;
};

const updateMapObject = (payload: MapObjectUpdatePayload): Promise<boolean> => {
  const requestId = `map-object-update-${Date.now()}-${++updateRequestSequence}`;
  const cloneablePayload = JSON.parse(JSON.stringify(payload)) as MapObjectUpdatePayload;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingUpdateRequests.delete(requestId);
      resolve(false);
    }, 2000);
    pendingUpdateRequests.set(requestId, { resolve, timer });
    if (!postMessageToMap({ type: "mapObjectUpdate", requestId, payload: cloneablePayload })) {
      window.clearTimeout(timer);
      pendingUpdateRequests.delete(requestId);
      resolve(false);
    }
  });
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
  const markerId = mapUrl.searchParams.get("marker_id");
  const latitude = Number(mapUrl.searchParams.get("latitude"));
  const longitude = Number(mapUrl.searchParams.get("longitude"));
  if (
    mapUrl.searchParams.has("latitude") &&
    mapUrl.searchParams.has("longitude") &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  ) {
    if (markerId && markerId !== "0") {
      focusObject("marker", markerId, latitude, longitude);
    } else {
      focusObject("shape", "", latitude, longitude);
    }
  }
};

const handleMessage = async (event: MessageEvent): Promise<void> => {
  const allowedOriginsList: string[] = props.allowedOrigins.split(",");
  if (!allowedOriginsList.includes(event.origin)) {
    console.warn("Cross origin:", event.origin);
    return;
  }
  const iframe = getMapIframe();
  if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.type === "callParentFunction") {
    emit("previewImage", event.data.message);
  } else if (event.data.type === "callParentReload") {
    emit("mapReloadRequested", event.data.layerId ?? null);
  } else if (event.data.type === "callParentLoginRedirect") {
    emit("loginRedirect");
  } else if (event.data.type === "mapObjectUpdateResult") {
    const request = pendingUpdateRequests.get(event.data.requestId);
    if (!request) return;
    window.clearTimeout(request.timer);
    pendingUpdateRequests.delete(event.data.requestId);
    request.resolve(event.data.success === true);
  }
};

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
  pendingUpdateRequests.forEach(({ resolve, timer }) => {
    window.clearTimeout(timer);
    resolve(false);
  });
  pendingUpdateRequests.clear();
});

defineExpose({ focusObject, filterMapObjects, updateMapObject });
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
.iframe-area {
  width: 100%;
  overflow: hidden;
  line-height: 0;
}

iframe {
  display: block;
  width: 100%;
  border: 0;
}
</style>
