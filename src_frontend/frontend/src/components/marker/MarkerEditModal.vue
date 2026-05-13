<script setup lang="ts">
import { ref, watch, computed } from "vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import type { LayersData } from "@/interface";
import { baseUrl, assetsUrl } from "@/setting";

const props = defineProps<{
  isOpen: boolean;
  markerId: string;
  layerList: Map<string, LayersData>;
  isHttpsProtocol: boolean;
  activeLayer: string;
  masterLayerId: string;
}>();

const emit = defineEmits<{
  close: [];
  updated: [];
  deleted: [];
  openImageUpload: [];
  openImageList: [];
  message: [text: string];
  reloadMap: [url: string];
  changeActiveLayer: [id: string];
}>();

const mapobjStore = useMapObjectStore();

const activeMarkerName = ref("");
const activeMarkerDetail = ref("");
const activaMarkerLayer = ref("");
const isDeleteCheckModal = ref(false);

watch(
  () => props.markerId,
  (id) => {
    if (!id) return;
    const marker = mapobjStore.getById(id);
    activeMarkerName.value = marker?.marker_name || "";
    activeMarkerDetail.value = marker?.detail || "";
    activaMarkerLayer.value = marker?.layer_id || "";
  },
);

const updateMakerNameDetail = (): void => {
  if (
    props.markerId === "" ||
    activeMarkerName.value === "" ||
    activeMarkerDetail.value === "" ||
    activaMarkerLayer.value === ""
  ) {
    emit("message", "マーカー名と内容の両方に入力が必要です。");
    return;
  }
  mapobjStore.updateMapObject(
    props.markerId,
    activeMarkerName.value,
    activeMarkerDetail.value,
    activaMarkerLayer.value,
  );

  const marker = mapobjStore.getById(props.markerId);
  const isMaster = activaMarkerLayer.value === props.masterLayerId;
  emit(
    "reloadMap",
    `${baseUrl}/map?marker_id=${marker.id}&latitude=${marker.latitude}&longitude=${marker.longitude}&layer=${activaMarkerLayer.value}&is_master=${isMaster}`,
  );

  emit("changeActiveLayer", activaMarkerLayer.value);
  emit("close");
  emit("message", "更新しました。");
  activeMarkerName.value = "";
  activeMarkerDetail.value = "";
  activaMarkerLayer.value = "";
};

const deleteMaker = (): void => {
  if (props.markerId === "") {
    return;
  }
  mapobjStore.deleteMapObject(props.markerId);
  isDeleteCheckModal.value = false;
  emit("close");
  emit("message", "削除しました。");
  const isMaster = props.activeLayer === props.masterLayerId;
  if (isMaster) {
    emit("reloadMap", `${baseUrl}/map?layer=${props.activeLayer}&is_master=true`);
  } else {
    emit("reloadMap", `${baseUrl}/map?layer=${props.activeLayer}`);
  }
  emit("deleted");
};

function insertMarkdown(text: string) {
  const textareaElm = document.getElementById("detail")! as HTMLTextAreaElement;
  textareaElm.focus();

  const startPos = textareaElm.selectionStart;
  const endPos = textareaElm.selectionEnd;

  const beforeText = textareaElm.value.substring(0, startPos);
  const afterText = textareaElm.value.substring(endPos);

  activeMarkerDetail.value = beforeText + text + afterText;
  textareaElm.value = beforeText + text + afterText;

  const newCursorPos = startPos + text.length;
  textareaElm.setSelectionRange(newCursorPos, newCursorPos);
  textareaElm.focus();
}

const insertUploadedMarkdown = (markdownLink: string) => {
  insertMarkdown(markdownLink);
};

defineExpose({ insertUploadedMarkdown, updateMakerNameDetail });
</script>

<template>
  <div class="overlay-marker-edit" v-show="isOpen">
    <div class="content-marker-edit">
      <h2 class="modal-h2">マーカー情報の編集</h2>
      <div class="title-select-row">
        <div class="input-select-row-group title-input">
          <label class="row">マーカー名</label>
          <input
            class="input-text input-text-title"
            type="text"
            placeholder="マーカー名"
            v-model="activeMarkerName"
          />
        </div>
        <div class="input-select-row-group group-select">
          <label class="row">レイヤ選択</label>
          <select class="select-elm-editform" v-model="activaMarkerLayer">
            <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
              {{ obj.name }}
            </option>
          </select>
        </div>
      </div>
      <div class="textarea-row">
        <div class="input-select-row-group">
          <label class="row">マーカーの内容</label>
          <textarea
            class="input-detail-markdown"
            id="detail"
            name="detail"
            placeholder="## マークダウンで記述"
            v-model="activeMarkerDetail"
          ></textarea>
        </div>
      </div>
      <div class="marker-edit-row">
        <button @click="emit('openImageUpload')" class="btn-function-image" title="ファイルの追加">
          <img
            :src="`${assetsUrl}smartphone_line24.png`"
            class="function-img"
            alt="smartphone_line24.png"
          />
        </button>
        <button @click="emit('openImageList')" class="btn-function-image" title="ファイル一覧">
          <img
            :src="`${assetsUrl}documents_line24.png`"
            class="function-img"
            alt="documents_line24.png"
          />
        </button>
        <button @click="insertMarkdown('## ')" class="btn-function-image" title="## を挿入">
          <img :src="`${assetsUrl}format_h2_24.png`" class="function-img" alt="format_h2_24.png" />
        </button>
        <button @click="insertMarkdown('### ')" class="btn-function-image" title="### を挿入">
          <img :src="`${assetsUrl}format_h3_24.png`" class="function-img" alt="format_h3_24.png" />
        </button>
        <button @click="insertMarkdown('- ')" class="btn-function-image" title="- を挿入">
          <img
            :src="`${assetsUrl}format_list_bulleted_24.png`"
            class="function-img"
            alt="format_list_bulleted_24.png"
          />
        </button>
        <button @click="insertMarkdown('1. ')" class="btn-function-image" title="1. を挿入">
          <img
            :src="`${assetsUrl}format_list_numbered_24.png`"
            class="function-img"
            alt="format_list_numbered_24.png"
          />
        </button>
        <button @click="insertMarkdown('**')" class="btn-function-image" title="** を挿入">
          <img
            :src="`${assetsUrl}format_bold_24.png`"
            class="function-img"
            alt="format_bold_24.png"
          />
        </button>
        <button
          @click="insertMarkdown('[ Title ]( URL )')"
          class="btn-function-image"
          title="[ Title ]( URL )を挿入"
        >
          <img :src="`${assetsUrl}link_24.png`" class="function-img" alt="link_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::details タイトル\n非表示にする内容\n:::')"
          class="btn-function-image"
          title=":::details を挿入"
        >
          <img :src="`${assetsUrl}more_24.png`" class="function-img" alt="more_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::note タイトル\n内容\n:::')"
          class="btn-function-image"
          title=":::note を挿入"
        >
          <img :src="`${assetsUrl}info_24.png`" class="function-img" alt="info_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::warning タイトル\n内容\n:::')"
          class="btn-function-image"
          title=":::warning を挿入"
        >
          <img :src="`${assetsUrl}warning_24.png`" class="function-img" alt="warning_24.png" />
        </button>
        <button
          @click="isDeleteCheckModal = true"
          class="btn-function-image"
          title="マーカーを削除"
        >
          <img :src="`${assetsUrl}delete_24.png`" class="function-img" alt="delete24.png" />
        </button>
      </div>
      <div class="btn-commit-row">
        <button @click="updateMakerNameDetail()" class="btn-update">+更新</button>
      </div>
      <div class="close-btn-img">
        <img
          @click="emit('close')"
          :src="`${assetsUrl}close_24.png`"
          class="function-img"
          alt="close_24.png"
        />
      </div>
    </div>
  </div>

  <ConfirmModal
    :isOpen="isDeleteCheckModal"
    title="削除の確認"
    message="本当にこのマーカーを削除しますか？"
    @confirm="deleteMaker"
    @cancel="isDeleteCheckModal = false"
  />
</template>

<style scoped>
.overlay-marker-edit {
  z-index: 1;
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

.content-marker-edit {
  position: relative;
  z-index: 2;
  width: 70%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
  margin: 20px auto;
  margin-top: -20px;
  padding: 20px;
  box-sizing: border-box;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.title-select-row {
  display: flex;
  width: 100%;
  gap: 20px;
}

.input-select-row-group {
  text-align: left;
}

.title-input {
  width: 80%;
}

.group-select {
  width: 20%;
}

.input-text {
  font-size: 20px;
  width: 100%;
  padding: 0.6em 1.2em;
  display: flex;
  margin-bottom: 2%;
  border-radius: 5px;
}

.input-text:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.input-text-title {
  border-radius: 8px;
  border: 1px solid #999999;
  padding: 0.6em 1.2em;
  font-family: inherit;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
}

.select-elm-editform {
  font-size: 20px;
  width: 100%;
  margin-bottom: 2%;
  border-radius: 5px;
  padding: 0.6em 1.2em;
  font-family: inherit;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  background-color: #ffffff;
  border-color: #555;
  border: 1px solid #ccc;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-repeat: no-repeat;
  background-position: right 1em center;
  text-align: center;
}

.select-elm-editform:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.select-elm-editform:hover {
  border-color: #888;
}

.textarea-row {
  text-align: center;
  margin-bottom: 10px;
}

.input-detail-markdown {
  font-size: 20px;
  width: 100%;
  border-radius: 8px;
  border: 1px solid #999999;
  padding: 0.6em 1.2em;
  font-family: inherit;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
  height: 50vh;
}

.input-detail-markdown:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.marker-edit-row {
  display: flex;
  width: 100%;
  gap: 20px;
  justify-content: center;
  margin-bottom: 3%;
}

.btn-commit-row {
  position: absolute;
  bottom: 15%;
  right: 3%;
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
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.function-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.close-btn-img {
  position: absolute;
  top: 10px;
  right: 10px;
  color: #fff;
  cursor: pointer;
}

.btn-update {
  width: 90px;
  height: 50px;
  background: rgb(23, 155, 126);
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  color: #fff;
  font-size: 16px;
  text-decoration: none;
  border: 1px;
  border-radius: 20px;
  transition: background-color 0.3s;
  margin: 5px;
}
</style>
