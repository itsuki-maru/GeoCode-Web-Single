<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { AxiosError } from "axios";
import { useRouter } from "vue-router";
import type { MapObjectData, LayersData, ImageData, QueryForm, UploadProgressState } from "@/interface";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useImageStore } from "@/stores/images";
import { authCheckUrl, getMasterLayerIdUrl, exportJsonUrl, disableTokenUrl } from "@/router/urls";
import { baseUrl, assetsUrl } from "@/setting";
import apiClient from "@/axiosClient";
import { useApplicationInitStore } from "@/stores/appInits";
import { useWindowSize } from "@/composables/useWindowSize";
import { isMP4 } from "@/composables/useFileTypeCheck";

// Components
import UserPrivacySetting from "@/components/UserPrivacySetting.vue";
import ProgressSpinner from "@/components/common/ProgressSpinner.vue";
import UploadProgressModal from "@/components/common/UploadProgressModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MapToolbar from "@/components/map/MapToolbar.vue";
import MapIframe from "@/components/map/MapIframe.vue";
import FullScreenMapModal from "@/components/map/FullScreenMapModal.vue";
import MarkerTable from "@/components/marker/MarkerTable.vue";
import MarkerEditModal from "@/components/marker/MarkerEditModal.vue";
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

// --- App init ---
const appInitStore = useApplicationInitStore();
const allowedOriginsRef = ref(appInitStore.appInitData.allowOrigins);
const router = useRouter();

// --- Protocol detection ---
const isHttpsProtocol = ref(false);
const currentUrl = window.location.href;
const url = new URL(currentUrl);
if (url.protocol === "https:" || url.hostname === "localhost") {
  isHttpsProtocol.value = true;
}

// --- Stores ---
const imageStore = useImageStore();
imageStore.initList();
const imageList = computed((): Map<string, ImageData> => imageStore.imageList);

const layersStore = useLayersStore();
layersStore.initList();
const layerList = computed((): Map<string, LayersData> => layersStore.layersList);

const mapobjStore = useMapObjectStore();
mapobjStore.initList();
const mapobjList = computed((): Map<string, MapObjectData> => mapobjStore.mapObjectList);

// --- Window size ---
const { divHeight } = useWindowSize();

// --- Active layer management ---
const activeLayer = ref("");
const masterLayerId = ref("");
const srcUrl = ref("");
const showProgressModal = ref(false);
const uploadProgressState = ref<UploadProgressState>({
  isOpen: false,
  phase: "preparing",
  percent: null,
  fileName: "",
  message: "",
});
const isReload = ref(true);

const isMasterLayer = computed((): boolean => activeLayer.value === masterLayerId.value);

const getMasterLayerId = async (): Promise<void> => {
  try {
    const response = await apiClient.get(getMasterLayerIdUrl);
    activeLayer.value = response.data["id"];
    masterLayerId.value = response.data["id"];
    srcUrl.value = `${baseUrl}/map?layer=${activeLayer.value}&is_master=true`;
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        switch (axiosError.response.status) {
          case 400:
            showMessage(`${axiosError.response.data}`);
            break;
          case 401:
            loginRedirect();
            break;
          default:
            console.error(`An error occurred: ${axiosError.response.status}`);
        }
      }
    }
  }
};
getMasterLayerId();

let loadedOnceFlag = false;
watch(activeLayer, async (): Promise<void> => {
  if (loadedOnceFlag) showProgressModal.value = true;
  const isMaster = activeLayer.value === masterLayerId.value;
  await reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`, true);
  showProgressModal.value = false;
  loadedOnceFlag = true;
});

// --- Map operations ---
const reloadMap = async (mapUrl: string, absolute: boolean = false): Promise<void> => {
  await apiClient.get(authCheckUrl);
  srcUrl.value = mapUrl;
  if (absolute) {
    isReload.value = true;
    const isMaster = activeLayer.value === masterLayerId.value;
    await mapobjStore.queryMapObject(activeLayer.value, isMaster);
    showProgressModal.value = false;
  }
};

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
const focusMarker = (id: string, lat: number, lng: number): void => {
  mapIframeRef.value?.focusMarker(id, lat, lng);
  if (isHttpsProtocol.value) {
    navigator.clipboard.writeText(`${lat},${lng}`);
  }
};

// --- Login redirect ---
async function loginRedirect(): Promise<void> {
  try {
    await apiClient.get(disableTokenUrl);
  } catch (error) {
    console.error(error);
  }
  router.push("/account/login");
}

// --- Message modal ---
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

// --- Modal states ---
const isOpenEditModal = ref(false);
const selectedMarkerId = ref("");
const isNewLayerModal = ref(false);
const showImageUploadModal = ref(false);
const showImageListModal = ref(false);
const showJsonUploadModal = ref(false);
const isQRCodeGenModal = ref(false);
const isOnetimeSettingModal = ref(false);
const isOnetimeUrlModal = ref(false);
const isOpenFullScreenMapModal = ref(false);
const isLayerListModal = ref(false);
const isLayerRenameModal = ref(false);
const renameLayerId = ref("");
const renameLayerName = ref("");

// Image preview state
const imagePreviewModal = ref(false);
const imagePreviewFilename = ref("");
const imagePreviewId = ref("");
const imagePreviewReadOnly = ref(false);

// Uploaded URL modal (HTTP)
const isUploadedMessageModal = ref(false);
const uploadedUrl = ref("");
const uploadedUniqueFileName = ref("");

// Onetime URL state
const oneTimeUrl = ref("");
const oneTimeUuid = ref("");
const oneTimeExpiration = ref("");

// --- Marker edit ---
const markerEditRef = ref<InstanceType<typeof MarkerEditModal> | null>(null);

const openEditModal = (id: string): void => {
  selectedMarkerId.value = id;
  isOpenEditModal.value = true;
};

const closeEditModal = (): void => {
  selectedMarkerId.value = "";
  isOpenEditModal.value = false;
};

// --- Layer operations ---
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

// Layer delete
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

const confirmLayerDelete = (): void => {
  if (deleteLayerId.value === "") return;
  const name = deleteLayerName.value;
  layersStore.deleteLayer(deleteLayerId.value);
  isDeleteLayerCheckModal.value = false;
  deleteLayerId.value = "";
  activeLayer.value = masterLayerId.value;
  showMessage(`${name} を削除しました。`);
  isLayerListModal.value = false;
};

// --- Image operations ---
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
    markerEditRef.value?.insertUploadedMarkdown(markdownLink);
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

// --- Onetime URL ---
const onetimeSettingRef = ref<InstanceType<typeof OnetimeSettingModal> | null>(null);
const openOnetimeSetting = (): void => {
  onetimeSettingRef.value?.initRows();
  onetimeSettingRef.value?.fetchCurrentSharedUrl();
  isOnetimeSettingModal.value = true;
};

const onOnetimeGenerated = (generatedUrl: string, uuid: string, _updateUrl: boolean, expiration: string): void => {
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

// --- JSON export ---
const getLayerForId = (layer_id: string): string => {
  const layerObj = layersStore.getById(layer_id);
  return layerObj ? layerObj.name : "Layer Name Get Error";
};

const exportJsonData = async (): Promise<void> => {
  let requestUrl = `${exportJsonUrl}${activeLayer.value}`;
  if (isMasterLayer.value) {
    requestUrl = `${exportJsonUrl}${activeLayer.value}?is_master=true`;
  }
  try {
    const response = await apiClient.get(requestUrl);
    const jsonData = JSON.stringify(response.data, null, 2);
    let blob = new Blob([jsonData], { type: "text/plain" });
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.setAttribute("download", `export_${getLayerForId(activeLayer.value)}.json`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        switch (axiosError.response.status) {
          case 400:
            showMessage(`${axiosError.response.data}`);
            break;
          case 401:
            loginRedirect();
            break;
          default:
            console.error(`An error occurred: ${axiosError.response.status}`);
        }
      }
    }
  }
};

// --- User privacy setting ---
const userSettingModalRef = ref<{
  openCloseUserSettingModal: () => void;
  isUserPrivate: boolean;
  isInitialized: boolean;
} | null>(null);

const userPrivacySettingFunction = () => {
  userSettingModalRef.value?.openCloseUserSettingModal();
};

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

// --- Marker search (MapToolbarからエクスポート) ---
const mapToolbarRef = ref<InstanceType<typeof MapToolbar> | null>(null);
const markerQueryFormData = ref<QueryForm>({ query1: "", query2: "" });

// --- Keyboard shortcuts ---
const handleKeyDown = (event: KeyboardEvent) => {
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
      markerEditRef.value?.updateMakerNameDetail();
    }
  } else if (event.altKey && event.key == "1") {
    event.preventDefault();
    document.getElementById("search-textbox1")?.focus();
  } else if (event.altKey && event.key == "2") {
    event.preventDefault();
    document.getElementById("search-textbox2")?.focus();
  } else if (event.altKey && event.key == "3") {
    event.preventDefault();
    mapToolbarRef.value?.onMarkerSearch(true);
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

// --- Image delete from list ---
const onImageDeleteRequest = (id: string): void => {
  imagePreviewId.value = id;
  imagePreviewFilename.value = "";
  imagePreviewReadOnly.value = false;
  imagePreviewModal.value = true;
};
</script>

<template>
  <MapToolbar
    :activeLayer="activeLayer"
    :masterLayerId="masterLayerId"
    :layerList="layerList"
    :isMasterLayer="isMasterLayer"
    :isHttpsProtocol="isHttpsProtocol"
    :markerQueryFormData="markerQueryFormData"
    ref="mapToolbarRef"
    @newLayer="isNewLayerModal = true"
    @imageUpload="showImageUploadModal = true"
    @imageList="showImageListModal = true"
    @qrCode="isQRCodeGenModal = true"
    @onetimeSetting="openOnetimeSetting()"
    @fullScreenMap="isOpenFullScreenMapModal = true"
    @exportJson="exportJsonData()"
    @importJson="showJsonUploadModal = true"
    @userSetting="userPrivacySettingFunction()"
    @reloadMap="reloadMap"
    @layerList="openLayerList()"
    @update:activeLayer="activeLayer = $event"
  />

  <div class="map-contents">
    <div class="map-and-info-zone">
      <div class="map-draw">
        <MapIframe
          ref="mapIframeRef"
          :srcUrl="srcUrl"
          :height="divHeight"
          :allowedOrigins="allowedOriginsRef"
          @mapReloadRequested="onMapReloadRequested"
          @loginRedirect="loginRedirect()"
          @previewImage="openReadOnlyPreview"
        />
      </div>
      <div class="info-draw">
        <MarkerTable
          :mapobjList="mapobjList"
          :height="divHeight"
          :activeLayer="activeLayer"
          @editMarker="openEditModal"
          @focusMarker="focusMarker"
        />
      </div>
    </div>
  </div>

  <!-- Modals -->
  <MarkerEditModal
    ref="markerEditRef"
    :isOpen="isOpenEditModal"
    :markerId="selectedMarkerId"
    :layerList="layerList"
    :isHttpsProtocol="isHttpsProtocol"
    :activeLayer="activeLayer"
    :masterLayerId="masterLayerId"
    @close="closeEditModal"
    @message="showMessage"
    @reloadMap="reloadMap"
    @changeActiveLayer="activeLayer = $event"
    @openImageUpload="showImageUploadModal = true"
    @openImageList="showImageListModal = true"
  />

  <LayerCreateModal
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
    :isEditingMarker="isOpenEditModal"
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

  <!-- Uploaded URL modal (HTTP) -->
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
    @close="showJsonUploadModal = false"
    @message="showMessage"
    @showProgress="showProgressModal = $event"
  />

  <UserPrivacySetting ref="userSettingModalRef" />

  <MessageModal :isOpen="isMessageModal" :message="messageText" @close="closeMessage" />

  <ProgressSpinner
    :isOpen="showProgressModal"
  />
  <UploadProgressModal
    :isOpen="uploadProgressState.isOpen"
    :progress="uploadProgressState"
  />
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
  width: 72%;
}

.info-draw {
  width: 28%;
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

/* Uploaded URL modal (HTTP) */
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
</style>
