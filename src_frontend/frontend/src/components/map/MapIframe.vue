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
let mapObjectRequestSequence = 0;
const pendingMapObjectRequests = new Map<
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

const reloadMapFrame = (): boolean => {
  const iframe = getMapIframe();
  if (!iframe) return false;
  iframe.src = props.srcUrl;
  return true;
};

const requestMapObjectMutation = (
  type: "mapObjectUpdate" | "mapObjectDelete",
  messageData: Record<string, unknown>,
): Promise<boolean> => {
  const requestId = `map-object-${Date.now()}-${++mapObjectRequestSequence}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingMapObjectRequests.delete(requestId);
      resolve(false);
    }, 2000);
    pendingMapObjectRequests.set(requestId, { resolve, timer });
    if (!postMessageToMap({ type, requestId, ...messageData })) {
      window.clearTimeout(timer);
      pendingMapObjectRequests.delete(requestId);
      resolve(false);
    }
  });
};

const updateMapObject = (payload: MapObjectUpdatePayload): Promise<boolean> => {
  const cloneablePayload = JSON.parse(JSON.stringify(payload)) as MapObjectUpdatePayload;
  return requestMapObjectMutation("mapObjectUpdate", { payload: cloneablePayload });
};

const deleteMapObject = (id: string): Promise<boolean> => {
  return requestMapObjectMutation("mapObjectDelete", { id });
};

const focusObject = (
  objectType: "marker" | "shape",
  id: string,
  lat: number,
  lng: number,
): void => {
  postMessageToMap({ objectType, id, lat, lng, type: "focus" });
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
  } else if (
    event.data.type === "mapObjectUpdateResult" ||
    event.data.type === "mapObjectDeleteResult"
  ) {
    const request = pendingMapObjectRequests.get(event.data.requestId);
    if (!request) return;
    window.clearTimeout(request.timer);
    pendingMapObjectRequests.delete(event.data.requestId);
    request.resolve(event.data.success === true);
  }
};

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
  pendingMapObjectRequests.forEach(({ resolve, timer }) => {
    window.clearTimeout(timer);
    resolve(false);
  });
  pendingMapObjectRequests.clear();
});

defineExpose({ deleteMapObject, focusObject, filterMapObjects, reloadMapFrame, updateMapObject });
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
