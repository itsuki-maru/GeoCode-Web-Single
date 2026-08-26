<script setup lang="ts">
import { ref, watch, computed } from "vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MapObjectFormSettingsModal from "@/components/map-object/MapObjectFormSettingsModal.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import type { LayersData, MapObjectUpdatePayload, ShapeGeoJson } from "@/interface";
import { baseUrl, assetsUrl } from "@/setting";

const props = defineProps<{
  isOpen: boolean;
  targetType: "marker" | "shape";
  targetId: string;
  layerList: Map<string, LayersData>;
  isHttpsProtocol: boolean;
  activeLayer: string;
  masterLayerId: string;
}>();

const emit = defineEmits<{
  close: [];
  updated: [payload: MapObjectUpdatePayload, previousLayerId: string];
  deleted: [];
  openImageUpload: [];
  openImageList: [];
  message: [text: string];
  reloadMap: [url: string];
}>();

const mapobjStore = useMapObjectStore();
const shapeStore = useShapeStore();

const activeObjectName = ref("");
const activeObjectDetail = ref("");
const activeObjectLayer = ref("");
const activeShapeColor = ref("#d94841");
const activeShapeLineType = ref("solid");
const activeShapeArrowType = ref<"none" | "start" | "end" | "both">("none");
const activeShapeWeight = ref(5);
const isDeleteCheckModal = ref(false);
const isFormSettingsOpen = ref(false);
const detailTextarea = ref<HTMLTextAreaElement | null>(null);
const isShape = computed(() => props.targetType === "shape");
const isPolyline = computed(
  () => isShape.value && shapeStore.getById(props.targetId)?.shape_type === "polyline",
);

const lineTypeOptions = [
  { value: "solid", label: "実線", dashArray: null },
  { value: "dashed", label: "破線", dashArray: "12,8" },
  { value: "dotted", label: "点線", dashArray: "1,6" },
  { value: "dash-dot", label: "一点鎖線", dashArray: "12,6,1,6" },
] as const;

const arrowTypeOptions = [
  { value: "none", label: "なし" },
  { value: "start", label: "始点" },
  { value: "end", label: "終点" },
  { value: "both", label: "両端" },
] as const;

const lineTypeFromDashArray = (dashArray: string | null | undefined): string => {
  const normalized = typeof dashArray === "string" ? dashArray.replace(/\s+/g, "") : null;
  return lineTypeOptions.find((option) => option.dashArray === normalized)?.value || "solid";
};

const loadTarget = (): void => {
  if (!props.targetId) return;
  if (isShape.value) {
    const shape = shapeStore.getById(props.targetId);
    activeObjectName.value = shape?.name || "";
    activeObjectDetail.value =
      typeof shape?.geojson.properties.memo === "string" ? shape.geojson.properties.memo : "";
    activeObjectLayer.value = shape?.layer_id || "";
    activeShapeColor.value = shape?.geojson.properties.style?.color || "#d94841";
    activeShapeLineType.value = lineTypeFromDashArray(shape?.geojson.properties.style?.dashArray);
    activeShapeArrowType.value = shape?.geojson.properties.style?.arrowType || "none";
    activeShapeWeight.value = shape?.geojson.properties.style?.weight || 5;
    return;
  }
  const marker = mapobjStore.getById(props.targetId);
  activeObjectName.value = marker?.marker_name || "";
  activeObjectDetail.value = marker?.detail || "";
  activeObjectLayer.value = marker?.layer_id || "";
};

watch(
  () => [props.targetId, props.targetType, props.isOpen] as const,
  () => {
    if (props.isOpen) loadTarget();
  },
);

const updateMapObject = async (): Promise<void> => {
  if (props.targetId === "" || activeObjectLayer.value === "") {
    emit("message", "所属レイヤを選択してください。");
    return;
  }
  if (!isShape.value && (activeObjectName.value === "" || activeObjectDetail.value === "")) {
    emit("message", "マーカー名と内容の両方に入力が必要です。");
    return;
  }

  let updatePayload: MapObjectUpdatePayload;
  let previousLayerId: string;

  if (isShape.value) {
    const shape = shapeStore.getById(props.targetId);
    if (!shape) return;
    previousLayerId = shape.layer_id;
    const nextGeoJson = JSON.parse(JSON.stringify(shape.geojson)) as ShapeGeoJson;
    const dashArray =
      lineTypeOptions.find((option) => option.value === activeShapeLineType.value)?.dashArray ||
      null;
    const nextStyle = {
      ...nextGeoJson.properties.style,
      color: activeShapeColor.value,
      weight: activeShapeWeight.value,
      dashArray,
    };
    if (shape.shape_type === "polyline") {
      nextStyle.arrowType = activeShapeArrowType.value;
    } else {
      nextStyle.fillColor = activeShapeColor.value;
      delete nextStyle.arrowType;
    }
    nextGeoJson.properties = {
      ...nextGeoJson.properties,
      memo: activeObjectDetail.value,
      style: nextStyle,
    };
    const updatedShape = await shapeStore.updateShape(
      props.targetId,
      activeObjectName.value,
      activeObjectLayer.value,
      nextGeoJson,
    );
    if (!updatedShape) {
      emit("message", "図形情報を更新できませんでした。");
      return;
    }
    updatePayload = {
      objectType: "shape",
      id: updatedShape.id,
      layerId: updatedShape.layer_id,
      shapeType: updatedShape.shape_type,
      name: updatedShape.name || "",
      geojson: updatedShape.geojson,
    };
  } else {
    const marker = mapobjStore.getById(props.targetId);
    if (!marker) return;
    previousLayerId = marker.layer_id;
    const updatedMarker = await mapobjStore.updateMapObject(
      props.targetId,
      activeObjectName.value,
      activeObjectDetail.value,
      activeObjectLayer.value,
    );
    if (!updatedMarker) {
      emit("message", "マーカー情報を更新できませんでした。");
      return;
    }
    updatePayload = {
      objectType: "marker",
      id: updatedMarker.id,
      layerId: updatedMarker.layer_id,
      name: updatedMarker.marker_name,
      detail: updatedMarker.detail,
      latitude: updatedMarker.latitude,
      longitude: updatedMarker.longitude,
    };
  }

  emit("updated", updatePayload, previousLayerId);
  emit("close");
  emit("message", "更新しました。");
  activeObjectName.value = "";
  activeObjectDetail.value = "";
  activeObjectLayer.value = "";
};

const deleteMarker = (): void => {
  if (props.targetId === "" || isShape.value) {
    return;
  }
  mapobjStore.deleteMapObject(props.targetId);
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
  const textareaElm = detailTextarea.value;
  if (!textareaElm) return;
  textareaElm.focus();

  const startPos = textareaElm.selectionStart;
  const endPos = textareaElm.selectionEnd;

  const beforeText = textareaElm.value.substring(0, startPos);
  const afterText = textareaElm.value.substring(endPos);

  activeObjectDetail.value = beforeText + text + afterText;
  textareaElm.value = beforeText + text + afterText;

  const newCursorPos = startPos + text.length;
  textareaElm.setSelectionRange(newCursorPos, newCursorPos);
  textareaElm.focus();
}

const insertUploadedMarkdown = (markdownLink: string) => {
  insertMarkdown(markdownLink);
};

defineExpose({ insertUploadedMarkdown, updateMapObject });
</script>

<template>
  <div class="overlay-map-object-edit" v-show="isOpen">
    <div class="content-map-object-edit">
      <h2 class="modal-h2">{{ isShape ? "図形情報の編集" : "マーカー情報の編集" }}</h2>
      <div class="title-select-row">
        <div class="input-select-row-group title-input">
          <label class="row">{{ isShape ? "図形名" : "マーカー名" }}</label>
          <input
            class="input-text input-text-title"
            type="text"
            :placeholder="isShape ? '図形名' : 'マーカー名'"
            :maxlength="isShape ? 80 : undefined"
            v-model="activeObjectName"
          />
        </div>
        <div class="input-select-row-group group-select">
          <label class="row">レイヤ選択</label>
          <select class="select-elm-editform" v-model="activeObjectLayer">
            <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
              {{ obj.name }}
            </option>
          </select>
        </div>
      </div>
      <div v-if="isShape" class="shape-style-row">
        <label>
          色
          <input v-model="activeShapeColor" type="color" aria-label="図形色" />
        </label>
        <label>
          線種
          <select v-model="activeShapeLineType" class="select-elm-editform shape-line-select">
            <option v-for="option in lineTypeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label v-if="isPolyline">
          矢印
          <select v-model="activeShapeArrowType" class="select-elm-editform shape-line-select">
            <option v-for="option in arrowTypeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="shape-weight-label">
          太さ
          <input v-model.number="activeShapeWeight" type="range" min="1" max="10" step="1" />
          <output>{{ activeShapeWeight }}px</output>
        </label>
      </div>
      <div class="textarea-row">
        <div class="input-select-row-group">
          <label class="row">{{ isShape ? "メモ（Markdown）" : "マーカーの内容" }}</label>
          <textarea
            ref="detailTextarea"
            class="input-detail-markdown"
            :class="{ 'shape-detail-markdown': isShape }"
            id="detail"
            name="detail"
            placeholder="## マークダウンで記述"
            :maxlength="isShape ? 10000 : undefined"
            v-model="activeObjectDetail"
          ></textarea>
        </div>
      </div>
      <div class="map-object-edit-row">
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
          v-if="!isShape"
          @click="isDeleteCheckModal = true"
          class="btn-function-image"
          title="マーカーを削除"
        >
          <img :src="`${assetsUrl}delete_24.png`" class="function-img" alt="delete24.png" />
        </button>
      </div>
      <div class="btn-commit-row">
        <button @click="isFormSettingsOpen = true" class="btn-form-settings">入力フォーム</button>
        <button @click="updateMapObject()" class="btn-update">+更新</button>
      </div>
      <button type="button" class="close-button" @click="emit('close')">閉じる</button>
    </div>
  </div>

  <ConfirmModal
    :isOpen="isDeleteCheckModal"
    title="削除の確認"
    message="本当にこのマーカーを削除しますか？"
    @confirm="deleteMarker"
    @cancel="isDeleteCheckModal = false"
  />
  <MapObjectFormSettingsModal
    :isOpen="isFormSettingsOpen"
    :targetType="targetType"
    :targetId="targetId"
    @close="isFormSettingsOpen = false"
    @message="(text: string) => emit('message', text)"
  />
</template>

<style scoped>
.overlay-map-object-edit {
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

.content-map-object-edit {
  position: relative;
  z-index: 2;
  width: 65%;
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

.shape-style-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
  margin: 12px 0;
  text-align: left;
}

.shape-style-row label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shape-line-select {
  width: 180px;
  margin: 0;
}

.shape-weight-label {
  flex: 1;
}

.shape-weight-label input {
  flex: 1;
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

.shape-detail-markdown {
  height: 42vh;
}

.input-detail-markdown:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.map-object-edit-row {
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

.close-button {
  position: absolute;
  top: 10px;
  right: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0.6em 1.2em;
  background-color: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.25s;
}

.close-button:hover {
  border-color: #396cd8;
}

.close-button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}

.btn-update {
  min-width: 90px;
  height: 44px;
  padding: 0 14px;
  background: rgb(23, 155, 126);
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  color: #fff;
  font-size: 16px;
  text-decoration: none;
  border: 1px;
  border-radius: 16px;
  transition: background-color 0.3s;
  margin: 5px;
}
.btn-form-settings {
  min-width: 112px;
  height: 44px;
  padding: 0 14px;
  border: 1px solid #7890b6;
  border-radius: 16px;
  background: #edf4ff;
  color: #183a70;
  font-weight: 700;
  cursor: pointer;
}

@media (orientation: portrait) {
  .content-map-object-edit {
    width: calc(100vw - 32px);
    max-width: 960px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    margin: 16px auto;
    overflow-y: auto;
  }

  .map-object-edit-row {
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }

  .btn-function-image {
    flex: 0 0 55px;
    margin: 0;
  }

  .btn-commit-row {
    position: static;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 12px;
  }

  .btn-update {
    margin: 0;
  }
}
</style>
