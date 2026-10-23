<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { AxiosError } from "axios";
import { useRouter } from "vue-router";
import type {
  MapObjectData,
  LayersData,
  ImageData,
  QueryForm,
  UploadProgressState,
  ShapeData,
  MapObjectUpdatePayload,
} from "@/interface";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useLayersStore } from "@/stores/layers";
import { useImageStore } from "@/stores/images";
import { authCheckUrl, getMasterLayerIdUrl, exportJsonUrl, disableTokenUrl } from "@/router/urls";
import { baseUrl, assetsUrl } from "@/setting";
import apiClient from "@/axiosClient";
import { useApplicationInitStore } from "@/stores/appInits";
import { useWindowSize } from "@/composables/useWindowSize";
import { isMP4 } from "@/composables/useFileTypeCheck";
import { getShapeCenter } from "@/composables/useShapeCenter";
import { useMapObjectTableVisibility } from "@/composables/useMapObjectTableVisibility";
import {
  getLastActiveLayerId,
  resolveInitialLayerId,
  saveLastActiveLayerId,
} from "@/composables/useLastActiveLayer";

// コンポーネント
import UserPrivacySetting from "@/components/UserPrivacySetting.vue";
import ProgressSpinner from "@/components/common/ProgressSpinner.vue";
import UploadProgressModal from "@/components/common/UploadProgressModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MapToolbar from "@/components/map/MapToolbar.vue";
import MapIframe from "@/components/map/MapIframe.vue";
import LiveLocationSharing from "@/components/location/LiveLocationSharing.vue";
import FullScreenMapModal from "@/components/map/FullScreenMapModal.vue";
import PrintMapModal from "@/components/map/PrintMapModal.vue";
import MapObjectTable from "@/components/map-object/MapObjectTable.vue";
import MapObjectEditModal from "@/components/map-object/MapObjectEditModal.vue";
import LayerCreateModal from "@/components/layer/LayerCreateModal.vue";
import LayerListModal from "@/components/layer/LayerListModal.vue";
import LayerRenameModal from "@/components/layer/LayerRenameModal.vue";
import ImageUploadModal from "@/components/image/ImageUploadModal.vue";
import ImageListModal from "@/components/image/ImageListModal.vue";
import ImagePreviewModal from "@/components/image/ImagePreviewModal.vue";
import QRCodeGeneratorModal from "@/components/qrcode/QRCodeGeneratorModal.vue";
import OnetimeSettingModal from "@/components/share/OnetimeSettingModal.vue";
import OnetimeUrlModal from "@/components/share/OnetimeUrlModal.vue";
import JsonImportModal from "@/components/json/JsonImportModal.vue";
import { fetchJsonExport } from "@/utils/json-transfer";

// --- アプリケーションの初期化 ---
const appInitStore = useApplicationInitStore();
const allowedOriginsRef = ref(appInitStore.appInitData.allowOrigins);
const router = useRouter();

// --- 通信プロトコルの判定 ---
const isHttpsProtocol = ref(false);
const currentUrl = window.location.href;
const url = new URL(currentUrl);
if (url.protocol === "https:" || url.hostname === "localhost") {
  isHttpsProtocol.value = true;
}

// --- ストア ---
const imageStore = useImageStore();
imageStore.initList();
const imageList = computed((): Map<string, ImageData> => imageStore.imageList);

const layersStore = useLayersStore();
const layersInitialization = layersStore.initList();
const layerList = computed((): Map<string, LayersData> => layersStore.layersList);
const layerInputPolicies = computed(() =>
  Object.fromEntries([...layerList.value].map(([id, value]) => [id, !!value.restrict_free_text])),
);

const mapobjStore = useMapObjectStore();
const markerList = computed((): Map<string, MapObjectData> => mapobjStore.mapObjectList);
const shapeStore = useShapeStore();
mapobjStore.clearMapObject();
shapeStore.clearShapeList();
const shapeList = computed((): Map<string, ShapeData> => shapeStore.shapeList);

// --- 画面サイズ ---
const { divHeight } = useWindowSize();
const { isMapObjectTableOpen, toggleMapObjectTable } = useMapObjectTableVisibility();

// --- 選択中レイヤの管理 ---
const activeLayer = ref("");
const masterLayerId = ref("");
const jsonImportAccountId = computed(
  () => layersStore.layersList.get(masterLayerId.value)?.user_id ?? "",
);
const srcUrl = ref("");
const pendingLayerMapUrl = ref<string | null>(null);
const isMapFrameLoading = ref(false);
const showProgressModal = ref(true);
const uploadProgressState = ref<UploadProgressState>({
  isOpen: false,
  phase: "preparing",
  percent: null,
  fileName: "",
  message: "",
});
const isReload = ref(true);

const isMasterLayer = computed((): boolean => activeLayer.value === masterLayerId.value);

let mapReloadSequence = 0;
let mapReloadController: AbortController | null = null;
let disposed = false;

onUnmounted(() => {
  disposed = true;
  ++mapReloadSequence;
  mapReloadController?.abort();
  mapobjStore.clearMapObject();
  shapeStore.clearShapeList();
});

const getMasterLayerId = async (): Promise<void> => {
  try {
    const [response, layersLoaded] = await Promise.all([
      apiClient.get(getMasterLayerIdUrl),
      layersInitialization,
    ]);
    if (disposed) return;
    if (!layersLoaded || !response.data.id) throw new Error("Failed to load initial layers");
    masterLayerId.value = response.data.id;
    activeLayer.value = resolveInitialLayerId(
      getLastActiveLayerId(),
      masterLayerId.value,
      new Set(layersStore.layersList.keys()),
    );
  } catch (error) {
    if (disposed) return;
    console.error(error);
    if (apiClient.isAxiosError(error) && error.response?.status === 401) {
      await loginRedirect();
    } else {
      showMessage("地図の初期情報を取得できませんでした。再読み込みしてください。");
    }
  } finally {
    if (!disposed && !activeLayer.value) showProgressModal.value = false;
  }
};

let suppressNextActiveLayerReload = false;
watch(activeLayer, async (): Promise<void> => {
  if (!activeLayer.value) return;
  if (suppressNextActiveLayerReload) {
    suppressNextActiveLayerReload = false;
    return;
  }
  const selectedLayerId = activeLayer.value;
  const isMaster = selectedLayerId === masterLayerId.value;
  const mapUrl =
    pendingLayerMapUrl.value ?? `${baseUrl}/map?layer=${selectedLayerId}&is_master=${isMaster}`;
  pendingLayerMapUrl.value = null;
  let synchronized = false;
  let requestSequence = 0;
  try {
    const request = reloadMap(mapUrl, true);
    requestSequence = mapReloadSequence;
    synchronized = await request;
  } catch (error) {
    console.error(error);
  }

  if (disposed || requestSequence !== mapReloadSequence || activeLayer.value !== selectedLayerId)
    return;
  if (synchronized) {
    saveLastActiveLayerId(selectedLayerId);
  } else if (selectedLayerId !== masterLayerId.value) {
    activeLayer.value = masterLayerId.value;
  } else {
    showMessage("地図データを取得できませんでした。再読み込みしてください。");
  }
});

// 読み込みごとに対象レイヤを保持し、最新の読み込みだけが現在の画面を更新できるようにする。
const reloadMap = async (
  mapUrl: string,
  absolute: boolean = false,
  forceIframeReload: boolean = false,
): Promise<boolean> => {
  const selectedLayerId = activeLayer.value;
  if (!selectedLayerId || disposed) return false;
  const isMaster = selectedLayerId === masterLayerId.value;
  const sequence = ++mapReloadSequence;
  mapReloadController?.abort();
  const controller = new AbortController();
  mapReloadController = controller;
  const isCurrent = () =>
    !disposed &&
    !controller.signal.aborted &&
    sequence === mapReloadSequence &&
    activeLayer.value === selectedLayerId;
  if (absolute) {
    showProgressModal.value = true;
    mapobjStore.clearMapObject();
    shapeStore.clearShapeList();
  }
  try {
    await apiClient.get(authCheckUrl, { signal: controller.signal });
    if (!isCurrent()) return false;
    if (absolute) {
      const [markersLoaded, shapesLoaded] = await Promise.all([
        mapobjStore.queryMapObject(selectedLayerId, isMaster, controller.signal),
        shapeStore.queryShapes(selectedLayerId, isMaster, controller.signal),
      ]);
      if (!isCurrent()) return false;
      if (!markersLoaded || !shapesLoaded) {
        mapobjStore.clearMapObject();
        shapeStore.clearShapeList();
        srcUrl.value = "";
        isMapFrameLoading.value = false;
        return false;
      }
      isReload.value = true;
      mapObjectQueryFormData.value = { query1: "", query2: "" };
      mapIframeRef.value?.filterMapObjects(null, null);
    }
    const shouldForceIframeReload = forceIframeReload && srcUrl.value === mapUrl;
    if (srcUrl.value !== mapUrl || shouldForceIframeReload) isMapFrameLoading.value = true;
    srcUrl.value = mapUrl;
    if (shouldForceIframeReload) {
      const reloaded = mapIframeRef.value?.reloadMapFrame() ?? false;
      if (!reloaded) isMapFrameLoading.value = false;
      return reloaded;
    }
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    if (absolute) {
      srcUrl.value = "";
      isMapFrameLoading.value = false;
    }
    throw error;
  } finally {
    if (isCurrent() && absolute) showProgressModal.value = false;
  }
};

const onMapLoaded = (loadedUrl: string): void => {
  if (loadedUrl === srcUrl.value) isMapFrameLoading.value = false;
};

void getMasterLayerId();

const handleUploadProgressChange = (progress: UploadProgressState): void => {
  uploadProgressState.value = progress;
};

const getMarker = (id: string): void => {
  const marker = mapobjStore.getById(id);
  const isMaster = activeLayer.value === masterLayerId.value;
  reloadMap(
    `${baseUrl}/map?marker_id=${marker.id}&latitude=${marker.latitude}&longitude=${marker.longitude}&layer=${activeLayer.value}&is_master=${isMaster}`,
  );
};

const mapIframeRef = ref<InstanceType<typeof MapIframe> | null>(null);
const liveLocationSharingRef = ref<InstanceType<typeof LiveLocationSharing> | null>(null);

const getMapObjectFocusPosition = (
  payload: MapObjectUpdatePayload,
): { latitude: number; longitude: number } | null => {
  if (payload.objectType === "marker") {
    return { latitude: payload.latitude, longitude: payload.longitude };
  }

  const shape = shapeStore.getById(payload.id);
  return shape ? getShapeCenter(shape) : null;
};

const getMapObjectMapUrl = (
  payload: MapObjectUpdatePayload,
  layerId: string,
  isMaster: boolean,
): string => {
  const focusPosition = getMapObjectFocusPosition(payload);
  const focusParams = focusPosition
    ? `&latitude=${focusPosition.latitude}&longitude=${focusPosition.longitude}`
    : "";
  const markerParams = payload.objectType === "marker" ? `&marker_id=${payload.id}` : "";
  return `${baseUrl}/map?layer=${layerId}&is_master=${isMaster}${markerParams}${focusParams}`;
};

const reloadMapObjectFallback = async (payload: MapObjectUpdatePayload): Promise<void> => {
  const isMaster = activeLayer.value === masterLayerId.value;
  await reloadMap(getMapObjectMapUrl(payload, activeLayer.value, isMaster));
};

const receiveAnswerUpdate = (event: Event) => {
  const object = (event as CustomEvent<MapObjectData | ShapeData>).detail;
  if (!object?.id) return;
  let payload: MapObjectUpdatePayload;
  if ("geojson" in object) {
    if (!shapeStore.shapeList.has(object.id)) return;
    shapeStore.shapeList.set(object.id, object);
    payload = {
      objectType: "shape",
      id: object.id,
      layerId: object.layer_id,
      shapeType: object.shape_type,
      name: object.name || "",
      geojson: object.geojson,
    };
  } else {
    if (!mapobjStore.mapObjectList.has(object.id)) return;
    mapobjStore.mapObjectList.set(object.id, object);
    payload = {
      objectType: "marker",
      id: object.id,
      layerId: object.layer_id,
      name: object.marker_name,
      detail: object.detail,
      latitude: object.latitude,
      longitude: object.longitude,
    };
  }
  void (async () => {
    const updated = (await mapIframeRef.value?.updateMapObject(payload)) ?? false;
    if (!updated) {
      await reloadMapObjectFallback(payload);
      return;
    }
    if (mapObjectQueryFormData.value.query1 || mapObjectQueryFormData.value.query2)
      await handleMapObjectSearch(mapObjectQueryFormData.value);
  })();
};
window.addEventListener("geocode-answer-updated", receiveAnswerUpdate);
onUnmounted(() => window.removeEventListener("geocode-answer-updated", receiveAnswerUpdate));

const handleMapObjectUpdated = async (
  payload: MapObjectUpdatePayload,
  previousLayerId: string,
): Promise<void> => {
  const isMaster = activeLayer.value === masterLayerId.value;
  if (payload.layerId !== previousLayerId && !isMaster) {
    pendingLayerMapUrl.value = getMapObjectMapUrl(payload, payload.layerId, false);
    activeLayer.value = payload.layerId;
    return;
  }

  const updated = (await mapIframeRef.value?.updateMapObject(payload)) ?? false;
  if (!updated) {
    await reloadMapObjectFallback(payload);
    return;
  }

  if (mapObjectQueryFormData.value.query1 || mapObjectQueryFormData.value.query2) {
    await handleMapObjectSearch(mapObjectQueryFormData.value);
  }

  const focusPosition = getMapObjectFocusPosition(payload);
  if (focusPosition) {
    mapIframeRef.value?.focusObject(
      payload.objectType,
      payload.id,
      focusPosition.latitude,
      focusPosition.longitude,
    );
  }
};

const removeMarkerFromMap = async (id: string): Promise<boolean> => {
  const removed = (await mapIframeRef.value?.deleteMapObject(id)) ?? false;
  if (removed) return true;

  const isMaster = activeLayer.value === masterLayerId.value;
  return reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`, false, true);
};

const handleMapObjectDeleted = async (id: string): Promise<void> => {
  try {
    const synchronized = await removeMarkerFromMap(id);
    showMessage(
      synchronized
        ? "削除しました。"
        : "マーカーは削除されましたが、地図の同期に失敗しました。再読み込みしてください。",
    );
  } catch (error) {
    console.error(error);
    showMessage("マーカーは削除されましたが、地図の同期に失敗しました。再読み込みしてください。");
  }
};

const focusObject = (type: "marker" | "shape", id: string, lat: number, lng: number): void => {
  mapIframeRef.value?.focusObject(type, id, lat, lng);
  if (isHttpsProtocol.value) {
    navigator.clipboard.writeText(`${lat},${lng}`);
  }
};

const filterMapObjects = (): void => {
  const markerIds = [...mapobjStore.mapObjectList.keys()];
  mapIframeRef.value?.filterMapObjects(markerIds, mapobjStore.filteredShapeIds);
};

const handleMapObjectSearch = async (query: QueryForm, reset: boolean = false): Promise<void> => {
  try {
    mapObjectQueryFormData.value = { ...query };
    if (reset) {
      await mapobjStore.queryWordMapObject("", "", activeLayer.value);
    } else {
      await mapobjStore.queryWordMapObject(query.query1, query.query2, activeLayer.value);
    }
    filterMapObjects();
  } catch (error) {
    console.error(error);
  }
};

// --- ログイン画面への遷移 ---
async function loginRedirect(): Promise<void> {
  try {
    await apiClient.post(disableTokenUrl);
  } catch (error) {
    console.error(error);
  }
  router.push("/account/login");
}

// --- メッセージ表示モーダル ---
const isMessageModal = ref(false);
const messageText = ref("");
const showMessage = (message: string): void => {
  messageText.value = message;
  isMessageModal.value = true;
};
const closeMessage = (): void => {
  isMessageModal.value = false;
  messageText.value = "";
};

// --- モーダルの状態 ---
const isOpenEditModal = ref(false);
const selectedObjectId = ref("");
const selectedObjectType = ref<"marker" | "shape">("marker");
const isNewLayerModal = ref(false);
const showImageUploadModal = ref(false);
const showImageListModal = ref(false);
const showJsonUploadModal = ref(false);
const jsonImportRequestBusy = ref(false);
const jsonImportSyncBusy = ref(false);
const jsonImportSyncRequired = ref(false);
const jsonExportBusy = ref(false);
const isQRCodeGenModal = ref(false);
const isOnetimeSettingModal = ref(false);
const isOnetimeUrlModal = ref(false);
const isOpenFullScreenMapModal = ref(false);
const isOpenPrintMapModal = ref(false);
const isLayerListModal = ref(false);
const isLayerRenameModal = ref(false);
const renameLayerId = ref("");
const renameLayerName = ref("");

// 画像プレビューの状態
const imagePreviewModal = ref(false);
const imagePreviewFilename = ref("");
const imagePreviewId = ref("");
const imagePreviewReadOnly = ref(false);

// アップロード先 URL の表示モーダル（HTTP）
const isUploadedMessageModal = ref(false);
const uploadedUrl = ref("");
const uploadedUniqueFileName = ref("");

// 一時 URL の状態
const oneTimeUrl = ref("");
const oneTimeUuid = ref("");
const oneTimeExpiration = ref("");

// --- 地図オブジェクトの編集 ---
const mapObjectEditRef = ref<InstanceType<typeof MapObjectEditModal> | null>(null);

const openEditModal = (type: "marker" | "shape", id: string): void => {
  selectedObjectType.value = type;
  selectedObjectId.value = id;
  isOpenEditModal.value = true;
};

const closeEditModal = (): void => {
  selectedObjectId.value = "";
  isOpenEditModal.value = false;
};

// --- レイヤ操作 ---
const layerListRef = ref<InstanceType<typeof LayerListModal> | null>(null);
const openLayerList = (): void => {
  isLayerListModal.value = true;
  layerListRef.value?.initSearch();
};

const onLayerRename = (id: string, name: string): void => {
  if (masterLayerId.value === id) {
    showMessage("masterレイヤは名前を変更できません。");
    return;
  }
  renameLayerId.value = id;
  renameLayerName.value = name;
  isLayerRenameModal.value = true;
};

// レイヤの削除
const isDeleteLayerCheckModal = ref(false);
const deleteLayerId = ref("");
const deleteLayerName = ref("");

const onLayerDelete = (id: string): void => {
  if (masterLayerId.value === id) {
    showMessage("masterレイヤは削除できません。");
    return;
  }
  deleteLayerId.value = id;
  const layer = layersStore.getById(id);
  deleteLayerName.value = layer.name;
  isDeleteLayerCheckModal.value = true;
};

const confirmLayerDelete = async (): Promise<void> => {
  if (deleteLayerId.value === "") return;
  const id = deleteLayerId.value;
  const name = deleteLayerName.value;
  isDeleteLayerCheckModal.value = false;
  deleteLayerId.value = "";
  deleteLayerName.value = "";
  showProgressModal.value = true;

  const deleted = await layersStore.deleteLayer(id);
  if (!deleted) {
    showProgressModal.value = false;
    showMessage(`${name} を削除できませんでした。`);
    return;
  }

  if (activeLayer.value !== masterLayerId.value) {
    suppressNextActiveLayerReload = true;
    activeLayer.value = masterLayerId.value;
  }

  let objectsSynchronized = false;
  let layersSynchronized = false;
  try {
    objectsSynchronized = await reloadMap(
      `${baseUrl}/map?layer=${masterLayerId.value}&is_master=true`,
      true,
      true,
    );
    if (objectsSynchronized) saveLastActiveLayerId(masterLayerId.value);
    if (objectsSynchronized) {
      layersSynchronized = await layersStore.initList();
    }
  } catch (error) {
    console.error(error);
  } finally {
    showProgressModal.value = false;
    isLayerListModal.value = false;
  }

  if (objectsSynchronized && layersSynchronized) {
    showMessage(`${name} を削除しました。`);
  } else {
    showMessage(`${name} は削除されましたが、画面の同期に失敗しました。再読み込みしてください。`);
  }
};

// --- 画像操作 ---
const openImagePreview = (filename: string, id: string): void => {
  if (filename.endsWith(".pdf")) {
    window.open(`${baseUrl}/static/images/${filename}`, "_blank", "noopener noreferrer");
    return;
  }
  imagePreviewFilename.value = filename;
  imagePreviewId.value = id;
  imagePreviewReadOnly.value = false;
  imagePreviewModal.value = true;
};

const openReadOnlyPreview = (filename: string): void => {
  imagePreviewFilename.value = filename;
  imagePreviewId.value = "";
  imagePreviewReadOnly.value = true;
  imagePreviewModal.value = true;
};

const onImageUploaded = (markdownLink: string): void => {
  if (isOpenEditModal.value) {
    mapObjectEditRef.value?.insertUploadedMarkdown(markdownLink);
  }
};

const showUploadedUrlModal = (urlStr: string, uniqueFileName: string): void => {
  uploadedUrl.value = urlStr;
  uploadedUniqueFileName.value = `${uniqueFileName}-uploaded`;
  isUploadedMessageModal.value = true;
};

function selectTextOrClipboardCopy(elementId: string) {
  let element = document.getElementById(elementId);
  if (!element || !element.textContent) return;
  if (isHttpsProtocol.value) {
    navigator.clipboard.writeText(element.textContent);
    showMessage("クリップボードにコピーしました。");
  } else {
    if (window.getSelection) {
      let selection = window.getSelection();
      let range = document.createRange();
      try {
        range.selectNodeContents(element);
      } catch (e) {
        console.error(e);
      }
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
}

// --- 一時 URL ---
const onetimeSettingRef = ref<InstanceType<typeof OnetimeSettingModal> | null>(null);
const openOnetimeSetting = (): void => {
  onetimeSettingRef.value?.initRows();
  onetimeSettingRef.value?.fetchCurrentSharedUrl();
  isOnetimeSettingModal.value = true;
};

const onOnetimeGenerated = (
  generatedUrl: string,
  uuid: string,
  _updateUrl: boolean,
  expiration: string,
): void => {
  oneTimeUrl.value = generatedUrl;
  oneTimeUuid.value = uuid;
  oneTimeExpiration.value = expiration;
  isOnetimeUrlModal.value = true;
};

const handleOnetimeInvalidated = async (): Promise<void> => {
  isOnetimeUrlModal.value = false;
  oneTimeUrl.value = "";
  oneTimeUuid.value = "";
  oneTimeExpiration.value = "";
  await onetimeSettingRef.value?.fetchCurrentSharedUrl();
};

// --- JSON の入出力 ---
const syncJsonImportView = async (): Promise<void> => {
  if (jsonImportSyncBusy.value || disposed) return;
  jsonImportSyncBusy.value = true;
  const selectedLayerId = activeLayer.value;
  const isMaster = selectedLayerId === masterLayerId.value;
  try {
    const results = await Promise.allSettled([
      layersStore.initList(),
      reloadMap(`${baseUrl}/map?layer=${selectedLayerId}&is_master=${isMaster}`, true, true),
    ]);
    if (disposed) return;
    const synchronized = results.every((result) => result.status === "fulfilled" && result.value);
    jsonImportSyncRequired.value = !synchronized;
    showMessage(
      synchronized
        ? "データのインポートが完了しました。"
        : "インポートは完了しましたが、画面の更新に失敗しました。再取り込みせずに表示を再更新してください。",
    );
  } finally {
    jsonImportSyncBusy.value = false;
  }
};

const handleJsonImported = (): void => {
  jsonImportSyncRequired.value = true;
  void syncJsonImportView();
};

const getLayerForId = (layer_id: string): string => {
  const layerObj = layersStore.getById(layer_id);
  return layerObj ? layerObj.name : "Layer Name Get Error";
};

const exportJsonData = async (): Promise<void> => {
  if (jsonExportBusy.value) return;
  jsonExportBusy.value = true;
  const layerId = activeLayer.value;
  const filename = `export_${getLayerForId(layerId)}_v3.json`;
  const requestUrl = `${exportJsonUrl}${layerId}`;
  try {
    const blob = await fetchJsonExport(requestUrl);
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 60000);
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        switch (axiosError.response.status) {
          case 400:
          case 413:
            showMessage(
              (axiosError.response.data as { error?: string })?.error ??
                "JSONを出力できませんでした。",
            );
            break;
          case 401:
            loginRedirect();
            break;
          default:
            showMessage("JSONを出力できませんでした。再試行してください。");
            console.error(`An error occurred: ${axiosError.response.status}`);
        }
      }
    } else {
      showMessage("JSONを出力できませんでした。再試行してください。");
    }
  } finally {
    jsonExportBusy.value = false;
  }
};

// --- ユーザーのプライバシー設定 ---
const userSettingModalRef = ref<{
  openCloseUserSettingModal: () => void;
  isUserPrivate: boolean;
  isInitialized: boolean;
} | null>(null);

const userPrivacySettingFunction = () => {
  userSettingModalRef.value?.openCloseUserSettingModal();
};

defineExpose({ openUserPrivacySettings: userPrivacySettingFunction });

watch(
  () => userSettingModalRef.value?.isUserPrivate,
  (newValue) => {
    if (!userSettingModalRef.value?.isInitialized) return;
    if (newValue) {
      showMessage(
        "プライバシーモードが ON になりました。他のユーザーはあなたのデータにアクセスできません。",
      );
    } else {
      showMessage(
        "プライバシーモードが OFF になりました。 他のユーザーにあなたの画像などをシェアすることができます。",
      );
    }
  },
);

// --- Map object search (MapToolbarからエクスポート) ---
const mapToolbarRef = ref<InstanceType<typeof MapToolbar> | null>(null);
const mapObjectQueryFormData = ref<QueryForm>({ query1: "", query2: "" });

// --- キーボードショートカット ---
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || document.querySelector(".answer-map-overlay")) return;
  if (isOpenPrintMapModal.value) return;
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.key.toLowerCase() === "p"
  ) {
    event.preventDefault();
    if (!event.repeat) isOpenPrintMapModal.value = true;
    return;
  }
  if (event.ctrlKey && event.key === "1") {
    event.preventDefault();
    isNewLayerModal.value = !isNewLayerModal.value;
  } else if (event.ctrlKey && event.key == "2") {
    event.preventDefault();
    showImageUploadModal.value = !showImageUploadModal.value;
  } else if (event.ctrlKey && event.key == "3") {
    event.preventDefault();
    showImageListModal.value = !showImageListModal.value;
  } else if (event.ctrlKey && event.key == "4") {
    event.preventDefault();
    isQRCodeGenModal.value = !isQRCodeGenModal.value;
  } else if (event.ctrlKey && event.key == "5") {
    event.preventDefault();
    openOnetimeSetting();
  } else if (event.ctrlKey && event.key == "6") {
    event.preventDefault();
    isOpenFullScreenMapModal.value = !isOpenFullScreenMapModal.value;
  } else if (event.ctrlKey && event.key == "m") {
    event.preventDefault();
    if (isOpenEditModal.value) {
      mapObjectEditRef.value?.updateMapObject();
    }
  } else if (event.altKey && event.key == "1") {
    event.preventDefault();
    document.getElementById("search-textbox1")?.focus();
  } else if (event.altKey && event.key == "2") {
    event.preventDefault();
    const searchTextbox2 = document.getElementById("search-textbox2");
    if (searchTextbox2 instanceof HTMLInputElement && searchTextbox2.offsetParent !== null) {
      searchTextbox2.focus();
    }
  } else if (event.altKey && event.key == "3") {
    event.preventDefault();
    mapToolbarRef.value?.onMapObjectSearch(true);
  } else if (event.altKey && event.key == "4") {
    event.preventDefault();
    openLayerList();
  } else if (event.altKey && event.key == "5") {
    event.preventDefault();
    document.getElementById("layer-select-elm")?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (isMessageModal.value) isMessageModal.value = false;
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
});

// --- iFrame からの地図再読み込み要求 ---
const onMapReloadRequested = async (layerId?: string | null): Promise<void> => {
  if (layerId && layerId !== activeLayer.value) {
    activeLayer.value = layerId;
    return;
  }

  const isMaster = activeLayer.value === masterLayerId.value;
  await reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`, true);
};

// --- 一覧からの画像削除 ---
const onImageDeleteRequest = (id: string): void => {
  imagePreviewId.value = id;
  imagePreviewFilename.value = "";
  imagePreviewReadOnly.value = false;
  imagePreviewModal.value = true;
};
async function syncTileOverlays(tiles: unknown[]): Promise<void> {
  const updated = await mapIframeRef.value?.updateTileOverlays(tiles);
  if (!updated) mapIframeRef.value?.reloadMapFrame();
}
</script>

<template>
  <MapToolbar
    :activeLayer="activeLayer"
    :masterLayerId="masterLayerId"
    :layerList="layerList"
    :isMasterLayer="isMasterLayer"
    :isHttpsProtocol="isHttpsProtocol"
    :mapObjectQueryFormData="mapObjectQueryFormData"
    ref="mapToolbarRef"
    @newLayer="isNewLayerModal = true"
    @imageUpload="showImageUploadModal = true"
    @imageList="showImageListModal = true"
    @qrCode="isQRCodeGenModal = true"
    @onetimeSetting="openOnetimeSetting()"
    @fullScreenMap="isOpenFullScreenMapModal = true"
    @printMap="isOpenPrintMapModal = true"
    @exportJson="exportJsonData"
    @importJson="showJsonUploadModal = true"
    @reloadMap="reloadMap"
    @layerList="openLayerList()"
    @mapObjectSearch="handleMapObjectSearch"
    @update:mapObjectQueryFormData="mapObjectQueryFormData = $event"
    @update:activeLayer="activeLayer = $event"
  />
  <LiveLocationSharing ref="liveLocationSharingRef" />

  <div class="map-contents">
    <div class="map-and-info-zone" :class="{ 'map-object-table-closed': !isMapObjectTableOpen }">
      <div class="map-draw">
        <MapIframe
          ref="mapIframeRef"
          :srcUrl="srcUrl"
          :inputPolicies="layerInputPolicies"
          :height="divHeight"
          :allowedOrigins="allowedOriginsRef"
          @mapReloadRequested="onMapReloadRequested"
          @mapLoaded="onMapLoaded"
          @printMap="isOpenPrintMapModal = true"
          @loginRedirect="loginRedirect()"
          @previewImage="openReadOnlyPreview"
          @userLocation="liveLocationSharingRef?.receivePosition($event)"
          @userLocationError="liveLocationSharingRef?.receiveError()"
        />
      </div>
      <div id="map-object-table-panel" v-show="isMapObjectTableOpen" class="info-draw">
        <MapObjectTable
          :markerList="markerList"
          :shapeList="shapeList"
          :filteredShapeIds="mapobjStore.filteredShapeIds"
          :height="divHeight"
          :activeLayer="activeLayer"
          @editObject="openEditModal"
          @focusObject="focusObject"
        />
      </div>
    </div>
  </div>

  <button
    type="button"
    class="map-object-table-toggle"
    :aria-expanded="isMapObjectTableOpen"
    aria-controls="map-object-table-panel"
    @click="toggleMapObjectTable"
  >
    {{ isMapObjectTableOpen ? "テーブルを閉じる" : "テーブルを開く" }}
  </button>

  <!-- モーダル -->
  <MapObjectEditModal
    ref="mapObjectEditRef"
    :isOpen="isOpenEditModal"
    :targetType="selectedObjectType"
    :targetId="selectedObjectId"
    :layerList="layerList"
    :isHttpsProtocol="isHttpsProtocol"
    @close="closeEditModal"
    @updated="handleMapObjectUpdated"
    @deleted="handleMapObjectDeleted"
    @message="showMessage"
    @openImageUpload="showImageUploadModal = true"
    @openImageList="showImageListModal = true"
  />

  <LayerCreateModal
    @tilesChanged="syncTileOverlays"
    :isOpen="isNewLayerModal"
    @close="isNewLayerModal = false"
    @message="showMessage"
    @loginRedirect="loginRedirect()"
  />

  <LayerListModal
    ref="layerListRef"
    :isOpen="isLayerListModal"
    @close="isLayerListModal = false"
    @changeActiveLayer="activeLayer = $event"
    @rename="onLayerRename"
    @deleteLayer="onLayerDelete"
  />

  <LayerRenameModal
    :isOpen="isLayerRenameModal"
    :layerId="renameLayerId"
    :currentName="renameLayerName"
    :masterLayerId="masterLayerId"
    @close="isLayerRenameModal = false"
    @message="showMessage"
  />

  <ConfirmModal
    :isOpen="isDeleteLayerCheckModal"
    title="削除の確認"
    :message="`本当に 『 ${deleteLayerName} 』を削除しますか？`"
    @confirm="confirmLayerDelete"
    @cancel="isDeleteLayerCheckModal = false"
  />

  <ImageUploadModal
    :isOpen="showImageUploadModal"
    :isEditingMapObject="isOpenEditModal"
    :isHttpsProtocol="isHttpsProtocol"
    @close="showImageUploadModal = false"
    @uploaded="onImageUploaded"
    @message="showMessage"
    @showUploadedUrl="showUploadedUrlModal"
    @uploadProgressChange="handleUploadProgressChange"
  />

  <ImageListModal
    :isOpen="showImageListModal"
    :isHttps="isHttpsProtocol"
    @close="showImageListModal = false"
    @preview="openImagePreview"
    @deleteRequest="onImageDeleteRequest"
    @message="showMessage"
  />

  <ImagePreviewModal
    :isOpen="imagePreviewModal"
    :imageFilename="imagePreviewFilename"
    :imageId="imagePreviewId"
    :readOnly="imagePreviewReadOnly"
    @close="imagePreviewModal = false"
    @message="showMessage"
    @loginRedirect="loginRedirect()"
  />

  <!-- アップロード先 URL の表示モーダル（HTTP） -->
  <div class="overlay-uploaded-message" v-show="isUploadedMessageModal">
    <div class="content-uploaded-message" @click.stop>
      <h2 class="modal-h2">メッセージ</h2>
      <div class="input-text-zone">
        <p>
          <strong>アップロード完了。次のテキストリンクをコピーして使用してください。</strong>
        </p>
        <pre><code :id="uploadedUniqueFileName" @click="selectTextOrClipboardCopy(uploadedUniqueFileName)">{{ uploadedUrl }}</code></pre>
      </div>
      <div class="btn-zone">
        <button
          @click="
            isUploadedMessageModal = false;
            uploadedUrl = '';
            uploadedUniqueFileName = '';
          "
        >
          閉じる
        </button>
      </div>
    </div>
  </div>

  <PrintMapModal
    v-if="isOpenPrintMapModal"
    :layerIds="isMasterLayer ? null : [activeLayer]"
    @close="isOpenPrintMapModal = false"
  />

  <FullScreenMapModal
    :isOpen="isOpenFullScreenMapModal"
    @close="isOpenFullScreenMapModal = false"
  />

  <QRCodeGeneratorModal
    :isOpen="isQRCodeGenModal"
    @close="isQRCodeGenModal = false"
    @message="showMessage"
  />

  <OnetimeSettingModal
    ref="onetimeSettingRef"
    :isOpen="isOnetimeSettingModal"
    :layerList="layerList"
    @close="isOnetimeSettingModal = false"
    @generated="onOnetimeGenerated"
    @message="showMessage"
  />

  <OnetimeUrlModal
    :isOpen="isOnetimeUrlModal"
    :url="oneTimeUrl"
    :uuid="oneTimeUuid"
    :isHttps="isHttpsProtocol"
    :expiration="oneTimeExpiration"
    @close="isOnetimeUrlModal = false"
    @invalidated="handleOnetimeInvalidated"
    @message="showMessage"
  />

  <JsonImportModal
    :isOpen="showJsonUploadModal"
    :accountScope="jsonImportAccountId"
    :syncBusy="jsonImportSyncBusy"
    :syncFailed="jsonImportSyncRequired && !jsonImportSyncBusy"
    @close="showJsonUploadModal = false"
    @message="showMessage"
    @showProgress="jsonImportRequestBusy = $event"
    @imported="handleJsonImported"
    @retrySync="syncJsonImportView"
  />

  <UserPrivacySetting ref="userSettingModalRef" />

  <MessageModal :isOpen="isMessageModal" :message="messageText" @close="closeMessage" />

  <ProgressSpinner
    :isOpen="showProgressModal || isMapFrameLoading || jsonImportRequestBusy || jsonImportSyncBusy"
  />
  <UploadProgressModal :isOpen="uploadProgressState.isOpen" :progress="uploadProgressState" />
</template>

<style>
iframe {
  width: 100%;
}

.map-contents {
  text-align: center;
  margin-top: 1%;
}

.map-contents h2 {
  margin-top: 1%;
}

.map-and-info-zone {
  display: flex;
}

.map-draw {
  width: 70%;
  transition: width 0.2s ease;
}

.info-draw {
  width: 30%;
}

.map-and-info-zone.map-object-table-closed .map-draw {
  width: 100%;
}

.info-draw {
  min-width: 0;
}

.map-object-table-toggle {
  position: fixed;
  right: 2%;
  bottom: 7%;
  z-index: 2;
  padding: 0.45em 0.8em;
  font-size: 0.85em;
}

table {
  padding: 0;
}
table tr {
  border-top: 1px solid #cccccc;
  background-color: rgb(255, 255, 255);
  margin: 0;
  padding: 0;
}
table tr:nth-child(2n) {
  background-color: rgb(238, 238, 238);
}
table tr th {
  font-weight: bold;
  border: 1px solid #cccccc;
  text-align: left;
  margin: 0;
  padding: 6px 13px;
  background-color: #a5cef7;
}
table tr td {
  border: 1px solid #cccccc;
  text-align: left;
  margin: 0;
  padding: 6px 13px;
  font-size: 12px;
}

th:nth-child(1) {
  width: 140px;
}
th:nth-child(2) {
  width: 260px;
}
th:nth-child(3) {
  width: 120px;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  transition: border-color 0.25s;
  background-color: #5f5f5f;
  color: #ffffff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  cursor: pointer;
}

button:hover {
  border-color: #396cd8;
}

button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}

/* アップロード先 URL の表示モーダル（HTTP） */
.overlay-uploaded-message {
  z-index: 3;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.content-uploaded-message {
  z-index: 4;
  width: 35%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.input-text-zone {
  text-align: center;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

pre code {
  margin: 0;
  padding: 0;
  white-space: pre;
  border: none;
  background: transparent;
}

pre {
  background-color: #e6e6e6;
  color: black;
  border: 1px solid #5e5e5e;
  font-size: 13px;
  line-height: 19px;
  overflow: auto;
  padding: 6px 10px;
  border-radius: 3px;
}

pre code,
pre tt {
  white-space: pre-wrap;
  background-color: transparent;
  border: none;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

@media (orientation: portrait) {
  .overlay-uploaded-message {
    box-sizing: border-box;
    padding: 16px;
  }

  .content-uploaded-message {
    box-sizing: border-box;
    width: min(calc(100vw - 32px), 680px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    overflow-wrap: anywhere;
  }

  .content-uploaded-message .btn-zone {
    flex-wrap: wrap;
    gap: 12px;
  }
}
</style>
