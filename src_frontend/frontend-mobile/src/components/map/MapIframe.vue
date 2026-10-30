<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, toRaw } from "vue";
import type { MapObjectUpdatePayload, MapObjectData, ShapeData } from "@/interface";

type MapObjectChange = {
  operation: "upsert" | "delete";
  objectType: "marker" | "shape";
  object?: MapObjectData | ShapeData;
  id?: string;
  previousLayerId?: string | null;
  mutationId: string;
};
type MapObjectSnapshot = {
  markers: Record<string, MapObjectData>;
  shapes: ShapeData[];
  scopeKey?: string;
  revision?: number;
};

const props = defineProps<{
  attributeSearchActive?: boolean;
  srcUrl: string;
  allowedOrigins: string;
  inputPolicies?: Record<string, boolean>;
}>();

const emit = defineEmits<{
  mapReloadRequested: [layerId?: string | null];
  mapDataRequested: [];
  mapObjectWriteRequested: [
    request: { url: string; method: string; body?: unknown; requestId: string },
    reply: (result: { status: number; data: unknown }) => void,
  ];
  mapObjectChanged: [change: MapObjectChange, acknowledge: (success: boolean) => void];
  advancedSearch: [];
  loginRedirect: [];
  mapLoaded: [url: string];
  previewImage: [filename: string];
  userLocation: [position: Record<string, number | null>];
  userLocationError: [code: number];
}>();

const filteredObjectIds = ref<{ markerIds: string[] | null; shapeIds: string[] | null }>({
  markerIds: null,
  shapeIds: null,
});
let mapObjectRequestSequence = 0;
let runtimeId: string | null = null;
let transportLoaded = false;
let runtimeProbeId: string | null = null;
let initializationSequence = 0;
let hasInitializedData = false;
let initializationPending = false;
let disposed = false;
const runtimeWaiters = new Set<(ready: boolean) => void>();
const receivedMutations = new Set<string>();
const usesParentData = () =>
  new URL(props.srcUrl, window.location.origin).searchParams.get("data_source") === "parent";
const cancelPending = () => {
  runtimeId = null;
  runtimeProbeId = null;
  transportLoaded = false;
  initializationPending = false;
  ++initializationSequence;
  receivedMutations.clear();
  runtimeWaiters.forEach((resolve) => resolve(false));
  runtimeWaiters.clear();
  pendingMapObjectRequests.forEach(({ resolve, timer }) => {
    window.clearTimeout(timer);
    resolve(false);
  });
  pendingMapObjectRequests.clear();
};
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
  try {
    iframe.contentWindow.postMessage(messageData, targetOrigin);
    return true;
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("name" in error) ||
      error.name !== "DataCloneError"
    )
      return false;
    try {
      iframe.contentWindow.postMessage(plainMessageValue(messageData), targetOrigin);
      return true;
    } catch {
      return false;
    }
  }
};

// The parent owns layer state; legacy callers may omit policies.
const syncInputPolicies = (): boolean => {
  if (!props.inputPolicies) return false;
  return postMessageToMap({ type: "layerInputPolicies", policies: { ...props.inputPolicies } });
};
watch(() => props.inputPolicies, syncInputPolicies, { deep: true });

watch(
  () => props.srcUrl,
  () => {
    cancelPending();
    hasInitializedData = false;
  },
);

const reloadMapFrame = (): boolean => {
  const iframe = getMapIframe();
  if (!iframe) return false;
  cancelPending();
  iframe.src = props.srcUrl;
  return true;
};

const requestMapObjectMutation = (
  type: "mapObjectUpdate" | "mapObjectDelete" | "tileOverlaysUpdate" | "mapObjectsInitialize",
  messageData: Record<string, unknown>,
  timeoutMs = 2000,
): Promise<boolean> => {
  const requestId = `map-object-${Date.now()}-${++mapObjectRequestSequence}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingMapObjectRequests.delete(requestId);
      resolve(false);
    }, timeoutMs);
    pendingMapObjectRequests.set(requestId, { resolve, timer });
    if (!postMessageToMap({ type, requestId, runtimeId, ...messageData })) {
      window.clearTimeout(timer);
      pendingMapObjectRequests.delete(requestId);
      resolve(false);
    }
  });
};

const updateMapObject = (payload: MapObjectUpdatePayload): Promise<boolean> => {
  const cloneablePayload = payload;
  return requestMapObjectMutation("mapObjectUpdate", { payload: cloneablePayload });
};

const upsertMapObject = (
  objectType: "marker" | "shape",
  object: MapObjectData | ShapeData,
): Promise<boolean> =>
  requestMapObjectMutation("mapObjectUpdate", {
    payload: { objectType, object },
  });

const deleteMapObject = (
  id: string,
  objectType: "marker" | "shape" = "marker",
): Promise<boolean> => {
  return requestMapObjectMutation("mapObjectDelete", { id, objectType });
};

// Unwrap Vue proxies without repeated stringify/parse of the complete dataset.
function plainMessageValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const raw = toRaw(value);
  if (Array.isArray(raw)) return raw.map(plainMessageValue);
  return Object.fromEntries(
    Object.entries(raw).map(([key, entry]) => [key, plainMessageValue(entry)]),
  );
}

const probeRuntime = (): void => {
  runtimeProbeId = `map-runtime-${Date.now()}-${++mapObjectRequestSequence}`;
  postMessageToMap({ type: "mapRuntimeProbe", requestId: runtimeProbeId });
};

const waitForRuntime = (): Promise<boolean> => {
  if (runtimeId && !runtimeProbeId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      window.clearTimeout(timer);
      runtimeWaiters.delete(finish);
      resolve(ready);
    };
    const timer = window.setTimeout(() => finish(false), 30000);
    runtimeWaiters.add(finish);
    probeRuntime();
  });
};

const initializeMapObjects = async (snapshot: MapObjectSnapshot): Promise<boolean> => {
  if (!usesParentData()) return true;
  const sequence = ++initializationSequence;
  initializationPending = true;
  if (!(await waitForRuntime()) || disposed || sequence !== initializationSequence) {
    if (sequence === initializationSequence) initializationPending = false;
    return false;
  }
  const url = props.srcUrl;
  const success = await requestMapObjectMutation(
    "mapObjectsInitialize",
    {
      snapshot,
    },
    30000,
  );
  if (sequence === initializationSequence) initializationPending = false;
  if (!success || disposed || sequence !== initializationSequence || props.srcUrl !== url)
    return false;
  hasInitializedData = true;
  completeMapLoad();
  return true;
};

const focusObject = (
  objectType: "marker" | "shape",
  id: string,
  lat: number,
  lng: number,
): void => {
  postMessageToMap({ objectType, id, lat, lng, type: "focus" });
};

const sendAttributeSearchState = () => {
  if (props.attributeSearchActive !== undefined)
    postMessageToMap({ type: "attributeSearchState", active: props.attributeSearchActive });
};
watch(() => props.attributeSearchActive, sendAttributeSearchState);
const filterMapObjects = (markerIds: string[] | null, shapeIds: string[] | null): void => {
  sendAttributeSearchState();
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

const handleIframeLoad = (event: Event): void => {
  if (
    !(event.target instanceof HTMLIFrameElement) ||
    event.target.getAttribute("src") !== props.srcUrl
  )
    return;
  transportLoaded = true;
  if (usesParentData()) {
    probeRuntime();
    return;
  }
  completeMapLoad();
};

const completeMapLoad = (): void => {
  emit("mapLoaded", props.srcUrl);
  syncInputPolicies();
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

const handleMessage = (event: MessageEvent): void => {
  const allowedOriginsList: string[] = props.allowedOrigins.split(",");
  if (!allowedOriginsList.includes(event.origin)) {
    console.warn("Cross origin:", event.origin);
    return;
  }
  const iframe = getMapIframe();
  if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.type === "mapRuntimeReady") {
    if (usesParentData() && !transportLoaded) return;
    if (typeof event.data.runtimeId !== "string") return;
    if (!event.data.requestId) {
      probeRuntime();
      return;
    }
    if (!runtimeProbeId || event.data.requestId !== runtimeProbeId) return;
    runtimeProbeId = null;
    const previousRuntime = runtimeId;
    runtimeId = event.data.runtimeId;
    const shouldRestore =
      previousRuntime !== runtimeId && hasInitializedData && !initializationPending;
    runtimeWaiters.forEach((resolve) => resolve(true));
    runtimeWaiters.clear();
    if (shouldRestore) emit("mapDataRequested");
    return;
  }
  if (event.data.runtimeId && event.data.runtimeId !== runtimeId) return;
  if (event.data.type === "advancedMapSearchOpen") {
    emit("advancedSearch");
    return;
  }
  if (event.data.type === "mapObjectWriteRequested") {
    if (!runtimeId || event.data.runtimeId !== runtimeId) return;
    const request = event.data.request;
    if (
      !request ||
      typeof request.requestId !== "string" ||
      typeof request.url !== "string" ||
      typeof request.method !== "string"
    )
      return;
    const receivedRuntime = runtimeId;
    emit("mapObjectWriteRequested", request, (result) => {
      if (disposed || runtimeId !== receivedRuntime) return;
      postMessageToMap({
        type: "mapObjectWriteResult",
        runtimeId,
        requestId: request.requestId,
        status: result.status,
        data: result.data,
      });
    });
    return;
  }
  if (event.data.type === "mapObjectChanged") {
    if (!runtimeId || event.data.runtimeId !== runtimeId) return;
    const change = event.data.change as MapObjectChange;
    if (
      !change ||
      typeof change.mutationId !== "string" ||
      !["marker", "shape"].includes(change.objectType) ||
      !["upsert", "delete"].includes(change.operation)
    )
      return;
    const receivedRuntime = runtimeId;
    const acknowledge = (success: boolean) => {
      if (receivedRuntime !== runtimeId || disposed) return;
      if (success) {
        receivedMutations.add(change.mutationId);
        if (receivedMutations.size > 512)
          receivedMutations.delete(receivedMutations.values().next().value!);
      }
      postMessageToMap({
        type: "mapObjectChangedResult",
        mutationId: change.mutationId,
        runtimeId,
        success,
      });
    };
    if (receivedMutations.has(change.mutationId)) acknowledge(true);
    else emit("mapObjectChanged", change, acknowledge);
    return;
  }
  if (event.data.type === "callParentReload") {
    emit("mapReloadRequested", event.data.layerId ?? null);
  } else if (event.data.type === "callParentLoginRedirect") {
    emit("loginRedirect");
  } else if (event.data.type === "callParentImagePreview") {
    emit("previewImage", event.data.message);
  } else if (
    event.data.type === "mapObjectsInitializeResult" ||
    event.data.type === "tileOverlaysUpdateResult" ||
    event.data.type === "mapObjectUpdateResult" ||
    event.data.type === "mapObjectDeleteResult"
  ) {
    const request = pendingMapObjectRequests.get(event.data.requestId);
    if (!request) return;
    window.clearTimeout(request.timer);
    pendingMapObjectRequests.delete(event.data.requestId);
    request.resolve(event.data.success === true);
  } else if (event.data.type === "userLocationUpdate" && event.data.position) {
    emit("userLocation", event.data.position);
  } else if (event.data.type === "userLocationError") {
    emit("userLocationError", Number(event.data.code));
  }
};

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener("message", handleMessage);
  cancelPending();
});

const updateTileOverlays = (tiles: unknown[]): Promise<boolean> =>
  requestMapObjectMutation("tileOverlaysUpdate", { tiles: JSON.parse(JSON.stringify(tiles)) });

defineExpose({
  initializeMapObjects,
  upsertMapObject,
  updateTileOverlays,
  deleteMapObject,
  focusObject,
  filterMapObjects,
  reloadMapFrame,
  updateMapObject,
});
</script>

<template>
  <div class="map-contents">
    <iframe
      v-if="srcUrl"
      :key="srcUrl"
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
