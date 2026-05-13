<script setup lang="ts">
import { ref, computed, watch, inject } from "vue";
import type { Ref } from "vue";
import { AxiosError } from "axios";
import { useRouter } from "vue-router";
import type { UploadProgressState } from "@/interface";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useImageStore } from "@/stores/images";
import { authCheckUrl, getMasterLayerIdUrl, imageDeleteUrl, disableTokenUrl } from "@/router/urls";
import { baseUrl, assetsUrl } from "@/settingMobile";
import apiClient from "@/axiosClient";
import { useApplicationInitStore } from "@/stores/appInits";
import { isPDF } from "@/composables/useFileTypeCheck";

// コンポーネント
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

// --- 初期化 ---
const appInitStore = useApplicationInitStore();
const allowedOriginsRef = ref(appInitStore.appInitData.allowOrigins);

const isShowAppHeader = inject("isShowAppHeader") as Ref<boolean>;
isShowAppHeader.value = false;

const isHttpsProtocol = ref(false);
const currentUrl = window.location.href;
const url = new URL(currentUrl);
if (url.protocol === "https:" || url.hostname === "localhost") {
  isHttpsProtocol.value = true;
}

const router = useRouter();

async function loginRedirect(): Promise<void> {
  try {
    await apiClient.get(disableTokenUrl);
  } catch (error) {
    console.error(error);
  }
  router.push("/account/login");
}

// --- ストア初期化 ---
const imageStore = useImageStore();
imageStore.initList();
const layersStore = useLayersStore();
layersStore.initList();
const mapobjStore = useMapObjectStore();
mapobjStore.initList();

const layerList = computed(() => layersStore.layersList);

// --- レイヤ管理 ---
const activeLayer = ref("");
const masterLayerId = ref("");
const srcUrl = ref("");

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
        const status = axiosError.response.status;
        switch (status) {
          case 400:
            showMessage(`${axiosError.response.data}`);
            break;
          case 401:
            loginRedirect();
            break;
          default:
            console.error(`An error occurred: ${status}`, axiosError.response.data);
        }
      }
    }
  }
};
getMasterLayerId();

const isMasterLayer = computed(() => activeLayer.value === masterLayerId.value);

let loadedOnceFlag = false;
watch(activeLayer, async () => {
  if (loadedOnceFlag) showProgressModal.value = true;
  const isMaster = activeLayer.value === masterLayerId.value;
  await reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`, true);
  showProgressModal.value = false;
  loadedOnceFlag = true;
});

// --- 地図操作 ---
const reloadMap = async (mapUrl: string, absolute: boolean = false): Promise<void> => {
  await apiClient.get(authCheckUrl);
  srcUrl.value = mapUrl;
  if (absolute) {
    const isMaster = activeLayer.value === masterLayerId.value;
    await mapobjStore.queryMapObject(activeLayer.value, isMaster);
  }
};

const mapIframeRef = ref<InstanceType<typeof MapIframe> | null>(null);

const getMarker = (id: string): void => {
  const marker = mapobjStore.getById(id);
  const isMaster = activeLayer.value === masterLayerId.value;
  reloadMap(
    `${baseUrl}/map?marker_id=${marker.id}&latitude=${marker.latitude}&longitude=${marker.longitude}&layer=${activeLayer.value}&is_master=${isMaster}`,
  );
};

const focusMarker = (id: string, lat: number, lng: number): void => {
  mapIframeRef.value?.focusMarker(id, lat, lng);
  if (isHttpsProtocol.value) {
    navigator.clipboard.writeText(`${lat},${lng}`);
  }
};

// --- iFrame からの地図再読み込み要求 ---
const onMapReloadRequested = async (layerId?: string | null): Promise<void> => {
  if (layerId && layerId !== activeLayer.value) {
    activeLayer.value = layerId;
    return;
  }

  const isMaster = activeLayer.value === masterLayerId.value;
  await reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`, true);
};

// --- モーダル状態管理 ---
const showProgressModal = ref(false);
const uploadProgressState = ref<UploadProgressState>({
  isOpen: false,
  phase: "preparing",
  percent: null,
  fileName: "",
  message: "",
});
const isMessageModal = ref(false);
const messageText = ref("");
const showFunctionContent = ref(false);
const isOpenToolbar = ref(false);
const isOpenEditModal = ref(false);
const selectedMarkerId = ref("");
const showImageUploadModal = ref(false);
const showImageListModal = ref(false);
const imagePreviewModal = ref(false);
const imagePreviewFilename = ref("");
const previewSelectedImageId = ref("");
const showImageDeleteCheckModal = ref(false);
const isNewLayerSetUpModal = ref(false);
const showLayerListModal = ref(false);
const isLayerNameSettingModal = ref(false);
const editActiveLayerName = ref("");
const editActiveLayerId = ref("");
const isDeleteLayerCheckModal = ref(false);
const deleteLayerNameRef = ref("");
const deleteActiveLayerId = ref("");
const isQRCodeGenModal = ref(false);
const isOnetimeSettingModal = ref(false);
const isOnetimeUrlModal = ref(false);
const oneTimeUrl = ref("");
const oneTimeUuid = ref("");
const oneTimeExpiration = ref("");
const showPreviewImageFromIframe = ref(false);
const previewImageFromIframeSrc = ref("");

// アップロード完了モーダル
const isUploadedMessageModal = ref(false);
const uploadedUrl = ref("");
const uploadedUniqueFileName = ref("");

// --- メッセージ表示 ---
const showMessage = (message: string): void => {
  messageText.value = message;
  isMessageModal.value = true;
};

const closeMessage = (): void => {
  isMessageModal.value = false;
  messageText.value = "";
};

// --- 機能画面 ---
const onOpenCloseFunctionModal = async (): Promise<void> => {
  if (showFunctionContent.value) {
    showFunctionContent.value = false;
  } else {
    showFunctionContent.value = true;
    const isMaster = activeLayer.value === masterLayerId.value;
    await mapobjStore.queryMapObject(activeLayer.value, isMaster);
  }
};

// --- マーカー編集 ---
const markerEditModalRef = ref<InstanceType<typeof MarkerEditModal> | null>(null);

const openEditModal = (id: string): void => {
  selectedMarkerId.value = id;
  isOpenEditModal.value = true;
};

const closeEditModal = (): void => {
  selectedMarkerId.value = "";
  isOpenEditModal.value = false;
};

const handleMarkerUpdated = (id: string, name: string, detail: string, layerId: string): void => {
  mapobjStore.updateMapObject(id, name, detail, layerId);
  const marker = mapobjStore.getById(id);
  const isMaster = activeLayer.value === masterLayerId.value;
  reloadMap(
    `${baseUrl}/map?marker_id=${marker.id}&latitude=${marker.latitude}&longitude=${marker.longitude}&layer=${layerId}&is_master=${isMaster}`,
  );
  activeLayer.value = layerId;
  isOpenEditModal.value = false;
  showMessage("更新しました。");
};

const handleDeleteMarker = (id: string): void => {
  mapobjStore.deleteMapObject(id);
  showMessage("削除しました。");
  const isMaster = activeLayer.value === masterLayerId.value;
  reloadMap(`${baseUrl}/map?layer=${activeLayer.value}&is_master=${isMaster}`);
};

// --- 画像管理 ---
const handleImageUploaded = (markdownLink: string, uniqueFileName: string): void => {
  if (isOpenEditModal.value) {
    markerEditModalRef.value?.insertUploadedMarkdown(markdownLink);
    showMessage("アップロード完了。画像を挿入しました。");
  } else {
    uploadedUrl.value = markdownLink;
    uploadedUniqueFileName.value = `${uniqueFileName}-uploaded`;
    isUploadedMessageModal.value = true;
  }
};

const handleUploadProgressChange = (progress: UploadProgressState): void => {
  uploadProgressState.value = progress;
};

const handleImagePreview = (filename: string, id: string): void => {
  if (isPDF(filename)) {
    window.open(`${baseUrl}/static/images/${filename}`, "_blank", "noopener noreferrer");
    return;
  }
  imagePreviewFilename.value = filename;
  previewSelectedImageId.value = id;
  imagePreviewModal.value = true;
};

const handleImageDeleteRequest = (id: string): void => {
  previewSelectedImageId.value = id;
  showImageDeleteCheckModal.value = true;
};

const handleImageDeleteConfirm = async (): Promise<void> => {
  if (previewSelectedImageId.value === "") {
    showImageDeleteCheckModal.value = false;
    return;
  }
  try {
    await apiClient.delete(imageDeleteUrl + `/${previewSelectedImageId.value}`);
    imageStore.deleteImage(previewSelectedImageId.value);
    showMessage("削除しました。");
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const status = axiosError.response.status;
        switch (status) {
          case 400:
            showMessage(`${axiosError.response.data}`);
            break;
          case 401:
            loginRedirect();
            break;
          default:
            console.error(`An error occurred: ${status}`, axiosError.response.data);
        }
      }
    }
  }
  showImageDeleteCheckModal.value = false;
  imagePreviewModal.value = false;
  previewSelectedImageId.value = "";
};

const handleImageDeleteCancel = (): void => {
  showImageDeleteCheckModal.value = false;
  previewSelectedImageId.value = "";
};

function selectTextOrClipboardCopy(elementId: string) {
  const element = document.getElementById(elementId);
  if (!element || !element.textContent) return;

  if (isHttpsProtocol.value) {
    navigator.clipboard.writeText(element.textContent);
    showMessage("クリップボードにコピーしました。");
  } else {
    if (window.getSelection) {
      const selection = window.getSelection();
      const range = document.createRange();
      try {
        range.selectNodeContents(element);
      } catch (e) {
        console.error(`Error selecting contents of element: ${e}`);
      }
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
}

// --- レイヤ管理 ---
const layerListModalRef = ref<InstanceType<typeof LayerListModal> | null>(null);
const onetimeSettingRef = ref<InstanceType<typeof OnetimeSettingModal> | null>(null);

const openLayerListModal = (): void => {
  showLayerListModal.value = true;
  layerListModalRef.value?.handleOpen();
};

const handleLayerRename = (id: string, name: string): void => {
  editActiveLayerId.value = id;
  editActiveLayerName.value = name;
  isLayerNameSettingModal.value = true;
};

const handleLayerDelete = (id: string, name: string): void => {
  deleteActiveLayerId.value = id;
  deleteLayerNameRef.value = name;
  isDeleteLayerCheckModal.value = true;
};

const handleLayerDeleteConfirm = (): void => {
  if (deleteActiveLayerId.value === "") {
    showMessage("レイヤが選択されていません。");
    isDeleteLayerCheckModal.value = false;
    return;
  }
  layersStore.deleteLayer(deleteActiveLayerId.value);
  isDeleteLayerCheckModal.value = false;
  activeLayer.value = masterLayerId.value;
  showMessage(`${deleteLayerNameRef.value} を削除しました。`);
  showLayerListModal.value = false;
  deleteActiveLayerId.value = "";
  deleteLayerNameRef.value = "";
};

const handleLayerDeleteCancel = (): void => {
  isDeleteLayerCheckModal.value = false;
  deleteActiveLayerId.value = "";
  deleteLayerNameRef.value = "";
};

// --- ワンタイムURL ---
const openOnetimeSetting = (): void => {
  onetimeSettingRef.value?.copiedLayer();
  onetimeSettingRef.value?.fetchCurrentSharedUrl();
  isOnetimeSettingModal.value = true;
};

const handleOnetimeGenerated = (
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

const handleOnetimeInvalidated = (): void => {
  isOnetimeUrlModal.value = false;
  oneTimeUrl.value = "";
  oneTimeUuid.value = "";
  oneTimeExpiration.value = "";
  onetimeSettingRef.value?.fetchCurrentSharedUrl();
};

// --- iFrameプレビュー ---
const handlePreviewImageFromIframe = (imageSrc: string): void => {
  if (showPreviewImageFromIframe.value) {
    showPreviewImageFromIframe.value = false;
    previewImageFromIframeSrc.value = imageSrc;
  } else {
    showPreviewImageFromIframe.value = true;
    previewImageFromIframeSrc.value = imageSrc;
  }
};

// --- ユーザー設定 ---
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
</script>

<template>
  <!-- ツールバー -->
  <MapToolbar
    :activeLayer="activeLayer"
    :masterLayerId="masterLayerId"
    :layerList="layerList"
    :isMasterLayer="isMasterLayer"
    :isHttpsProtocol="isHttpsProtocol"
    @update:activeLayer="activeLayer = $event"
    @openFunction="onOpenCloseFunctionModal"
    @openToolbar="isOpenToolbar = !isOpenToolbar"
  />

  <!-- ツールバーボタン群 -->
  <transition>
    <div class="toolbar-area">
      <div id="function-btn-row" v-show="isOpenToolbar">
        <button
          @click="showImageUploadModal = true"
          class="btn-function-image"
          title="ファイルの追加"
        >
          <img
            :src="`${assetsUrl}smartphone_line24.png`"
            class="function-img"
            alt="smartphone_line24.png"
          />
        </button>
        <button @click="showImageListModal = true" class="btn-function-image" title="ファイル一覧">
          <img
            :src="`${assetsUrl}documents_line24.png`"
            class="function-img"
            alt="documents_line24.png"
          />
        </button>
        <button @click="isQRCodeGenModal = true" class="btn-function-image" title="QRコード生成">
          <img
            :src="`${assetsUrl}code_reader_line24.png`"
            class="function-img"
            alt="code_reader_line24.png"
          />
        </button>
        <button
          @click="openOnetimeSetting()"
          class="btn-function-image"
          title="レイヤーの共有URLを作成"
        >
          <img
            :src="`${assetsUrl}family_line24.png`"
            class="function-img"
            alt="family_line24.png"
          />
        </button>
        <button
          @click="isNewLayerSetUpModal = true"
          class="btn-function-image"
          title="新規レイヤの追加"
        >
          <img :src="`${assetsUrl}layer_add_24.png`" class="function-img" alt="layer_add_24.png" />
        </button>
        <button @click="openLayerListModal()" class="btn-function-image" title="レイヤ一覧">
          <img :src="`${assetsUrl}list_24.png`" class="function-img" alt="list_24.png" />
        </button>
      </div>
    </div>
  </transition>

  <!-- 機能画面 (マーカー一覧) -->
  <transition>
    <div
      id="overlay-function"
      v-show="showFunctionContent"
      @click.self="showFunctionContent = false"
    >
      <div id="content-function" @click.stop>
        <div class="function-content">
          <div id="row-search-elm">
            <select class="select-elm" id="function-select-elm" v-model="activeLayer">
              <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
                {{ obj.name }}
              </option>
            </select>
            <div id="row-search-btn">
              <button
                @click="
                  reloadMap(`${baseUrl}/map?layer=${activeLayer}&is_master=${isMasterLayer}`, true)
                "
                class="btn-search-image"
                title="リロード"
              >
                <img
                  :src="`${assetsUrl}update_fill24.png`"
                  class="function-img"
                  alt="update_fill24.png"
                />
              </button>
              <button @click="loginRedirect()" class="btn-search-image" title="ログアウト">
                <img :src="`${assetsUrl}exit_24.png`" class="function-img" alt="exit_24.png" />
              </button>
              <button
                v-if="userSettingModalRef?.isUserPrivate"
                @click="userPrivacySettingFunction()"
                class="btn-search-image"
                title="ユーザー設定"
              >
                <img :src="`${assetsUrl}lock_24.png`" class="function-img" alt="lock_24.png" />
              </button>
              <button
                v-if="!userSettingModalRef?.isUserPrivate"
                @click="userPrivacySettingFunction()"
                class="btn-search-image"
                title="ユーザー設定"
              >
                <img
                  :src="`${assetsUrl}lock_open_24.png`"
                  class="function-img"
                  alt="lock_open_24.png"
                />
              </button>
            </div>
          </div>

          <MarkerTable
            :activeLayer="activeLayer"
            @editMarker="openEditModal"
            @focusMarker="focusMarker"
            @deleteMarker="handleDeleteMarker"
            @message="showMessage"
          />
        </div>
        <button id="function-close-elm" @click="onOpenCloseFunctionModal">閉じる</button>
      </div>
    </div>
  </transition>

  <!-- 地図 -->
  <MapIframe
    ref="mapIframeRef"
    :srcUrl="srcUrl"
    :allowedOrigins="allowedOriginsRef"
    @mapReloadRequested="onMapReloadRequested"
    @loginRedirect="loginRedirect"
    @previewImage="handlePreviewImageFromIframe"
  />

  <!-- マーカー編集モーダル -->
  <MarkerEditModal
    ref="markerEditModalRef"
    :isOpen="isOpenEditModal"
    :markerId="selectedMarkerId"
    :isHttpsProtocol="isHttpsProtocol"
    @close="closeEditModal"
    @updated="handleMarkerUpdated"
    @openImageUpload="showImageUploadModal = true"
    @openImageList="showImageListModal = true"
    @message="showMessage"
  />

  <!-- レイヤ作成モーダル -->
  <LayerCreateModal
    :isOpen="isNewLayerSetUpModal"
    @close="isNewLayerSetUpModal = false"
    @created="() => {}"
    @message="showMessage"
    @loginRedirect="loginRedirect"
  />

  <!-- レイヤ一覧モーダル -->
  <LayerListModal
    ref="layerListModalRef"
    :isOpen="showLayerListModal"
    :masterLayerId="masterLayerId"
    @close="showLayerListModal = false"
    @changeActiveLayer="(id) => (activeLayer = id)"
    @rename="handleLayerRename"
    @delete="handleLayerDelete"
    @message="showMessage"
  />

  <!-- レイヤ名変更モーダル -->
  <LayerRenameModal
    :isOpen="isLayerNameSettingModal"
    :layerId="editActiveLayerId"
    :currentName="editActiveLayerName"
    @close="isLayerNameSettingModal = false"
    @renamed="() => {}"
    @message="showMessage"
  />

  <!-- レイヤ削除確認モーダル -->
  <ConfirmModal
    :isOpen="isDeleteLayerCheckModal"
    title="削除の確認"
    :message="`本当に 『 ${deleteLayerNameRef} 』を削除しますか？`"
    @confirm="handleLayerDeleteConfirm"
    @cancel="handleLayerDeleteCancel"
  />

  <!-- 画像アップロードモーダル -->
  <ImageUploadModal
    :isOpen="showImageUploadModal"
    :isEditingMarker="isOpenEditModal"
    @close="showImageUploadModal = false"
    @uploaded="handleImageUploaded"
    @message="showMessage"
    @uploadProgressChange="handleUploadProgressChange"
  />

  <!-- アップロード完了モーダル -->
  <div id="overlay-uploaded-message" v-show="isUploadedMessageModal">
    <div id="content-uploaded-message">
      <h2 class="modal-h2">メッセージ</h2>
      <div class="input-text-zone" v-if="isHttpsProtocol">
        <p><strong>アップロード完了。</strong></p>
        <pre
          :id="uploadedUniqueFileName"
          class="hidden-code-text"
        ><code :id="uploadedUniqueFileName">{{ uploadedUrl }}</code></pre>
        <button id="link-copy-btn" @click="selectTextOrClipboardCopy(`${uploadedUniqueFileName}`)">
          画像のリンクを取得
        </button>
      </div>
      <div class="input-text-zone" v-else>
        <p>
          <strong>アップロード完了。<br />次のテキストリンクをコピーして使用してください。</strong>
        </p>
        <pre><code :id="uploadedUniqueFileName" @click="selectTextOrClipboardCopy(`${uploadedUniqueFileName}`)">{{ uploadedUrl }}</code></pre>
      </div>
      <div class="btn-close">
        <button
          id="message-close-btn"
          @click="
            isUploadedMessageModal = false;
            uploadedUrl = '';
            uploadedUniqueFileName = '';
          "
          class="btn-standard"
        >
          閉じる
        </button>
      </div>
    </div>
  </div>

  <!-- 画像一覧モーダル -->
  <ImageListModal
    :isOpen="showImageListModal"
    :isHttps="isHttpsProtocol"
    @close="showImageListModal = false"
    @preview="handleImagePreview"
    @delete="handleImageDeleteRequest"
    @copyPath="() => {}"
    @message="showMessage"
  />

  <!-- 画像プレビューモーダル -->
  <ImagePreviewModal
    :isOpen="imagePreviewModal"
    :imageSrc="imagePreviewFilename"
    :imageId="previewSelectedImageId"
    @close="imagePreviewModal = false"
    @deleteRequest="handleImageDeleteRequest"
  />

  <!-- 画像削除確認モーダル -->
  <ConfirmModal
    :isOpen="showImageDeleteCheckModal"
    title="削除の確認"
    message="本当にこのデータを削除しますか？"
    @confirm="handleImageDeleteConfirm"
    @cancel="handleImageDeleteCancel"
  />

  <!-- QRコード生成モーダル -->
  <QRCodeGeneratorModal
    :isOpen="isQRCodeGenModal"
    @close="isQRCodeGenModal = false"
    @message="showMessage"
  />

  <!-- ワンタイムURL設定モーダル -->
  <OnetimeSettingModal
    ref="onetimeSettingRef"
    :isOpen="isOnetimeSettingModal"
    :layerList="layerList"
    @close="isOnetimeSettingModal = false"
    @generated="handleOnetimeGenerated"
    @message="showMessage"
  />

  <!-- ワンタイムURL表示モーダル -->
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

  <!-- ユーザー設定変更モーダル -->
  <UserPrivacySetting ref="userSettingModalRef" />

  <!-- メッセージモーダル -->
  <MessageModal :isOpen="isMessageModal" :message="messageText" @close="closeMessage" />

  <!-- プログレスモーダル -->
  <ProgressSpinner
    :isOpen="showProgressModal"
  />
  <UploadProgressModal
    :isOpen="uploadProgressState.isOpen"
    :progress="uploadProgressState"
  />

  <!-- iFrameからの画像プレビュー -->
  <FullScreenMapModal
    :isOpen="showPreviewImageFromIframe"
    :imageSrc="previewImageFromIframeSrc"
    @close="
      showPreviewImageFromIframe = false;
      previewImageFromIframeSrc = '';
    "
  />
</template>

<style>
.v-enter-active,
.v-leave-active {
  transition: all 0.3s ease-in-out;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
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

.btn-standard {
  min-width: 90px;
}

.btn-primary {
  background-color: #173e92;
}

.btn-delete {
  background-color: #961414a6;
}

.toolbar-area {
  z-index: 1;
  position: fixed;
  text-align: center;
  top: 7px;
  right: 2%;
}

#function-btn-row {
  display: flex;
  gap: 30px;
  text-align: center;
  justify-content: center;
  position: fixed;
  bottom: 14%;
  left: 50%;
  width: 96%;
  transform: translateX(-50%);
  background-color: transparent;
  padding-top: 20px;
  padding-bottom: 20px;
  border-radius: 50px;
}

.btn-function-image {
  width: 55px;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  text-align: center;
  box-shadow: 0 5px 3px rgba(0, 0, 0, 0.2);
}

.function-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

/* 機能モーダル */
#overlay-function {
  z-index: 2;
  position: fixed;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

#content-function {
  z-index: 3;
  height: 100%;
  width: 100%;
  padding: 1em;
  background: #ebebeb;
  overflow-y: scroll;
}

#function-close-elm {
  position: fixed;
  bottom: 3%;
  right: 3%;
  color: #fff;
  margin: 5px 5px 10px 5px;
}

#row-search-elm {
  display: flex;
  margin-bottom: 15px;
  width: 100%;
  justify-content: flex-start;
}

/* iPad mini（縦）~ 小型タブレット縦 */
@media (min-width: 768px) {
  #content-function {
    margin-left: 40%;
  }

  #row-search-elm {
    margin-top: 60px;
  }

  #form-area {
    max-width: 500px;
  }

  #content-message {
    width: 40%;
  }
}

/* スマートフォン */
@media (max-width: 767px) {
  #content-message {
    width: 70%;
  }

  #form-area {
    max-width: 100%; /* 画面幅にフィットさせる */
    padding: 15px; /* 余白を調整 */
  }

  input,
  textarea {
    font-size: 16px; /* モバイルでの操作性向上 */
  }

  #content-function {
    margin-left: 14px;
  }

  #row-search-elm {
    margin-top: 35px;
  }
}

#row-search-btn {
  margin-top: 10px;
  margin-right: 10px;
  margin-left: 5px;
}

#function-select-elm {
  border: #000000 solid 1px;
  margin-top: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.select-elm {
  width: auto;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.btn-search-image {
  width: 45px;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  box-shadow: 0 5px 3px rgba(0, 0, 0, 0.2);
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.input-text-zone {
  text-align: center;
}

.btn-close {
  margin-top: 20px;
  text-align: center;
  align-items: center;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

/* アップロード完了モーダル */
#overlay-uploaded-message {
  z-index: 15;
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

#content-uploaded-message {
  z-index: 16;
  width: 85%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
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

#link-copy-btn {
  width: 200px;
  background: rgb(27, 168, 161);
  height: 45px;
  font-size: 16px;
  color: #fff;
  padding: 10px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 8px;
  margin: 5px 5px 10px 5px;
}

.hidden-code-text {
  display: none;
}

table {
  width: 100%;
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
  font-size: 14px;
}
</style>
