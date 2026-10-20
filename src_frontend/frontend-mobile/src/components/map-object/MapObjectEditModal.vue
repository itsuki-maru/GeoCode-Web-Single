<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import MapObjectFormInputModal from "./MapObjectFormInputModal.vue";
import type { MapObjectData, ShapeData } from "@/interface";
import BaseModal from "@/components/common/BaseModal.vue";
import MapObjectFormSettingsModal from "@/components/map-object/MapObjectFormSettingsModal.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useLayersStore } from "@/stores/layers";
import type { MapObjectUpdatePayload, ShapeGeoJson } from "@/interface";
import { assetsUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  targetType: "marker" | "shape";
  targetId: string;
  isHttpsProtocol: boolean;
}>();

const emit = defineEmits<{
  close: [];
  updated: [payload: MapObjectUpdatePayload, previousLayerId: string];
  openImageUpload: [];
  openImageList: [];
  message: [text: string];
}>();

const mapobjStore = useMapObjectStore();
const shapeStore = useShapeStore();
const layersStore = useLayersStore();
const layerList = computed(() => layersStore.layersList);

const activeObjectName = ref("");
const activeObjectDetail = ref("");
const activeObjectLayer = ref("");
const activeShapeColor = ref("#d94841");
const activeShapeLineType = ref("solid");
const activeShapeArrowType = ref<"none" | "start" | "end" | "both">("none");
const activeShapeWeight = ref(5);
const isFormSettingsOpen = ref(false);
const isFormInputOpen = ref(false),
  formAvailable = ref(false),
  confirmFormOpen = ref(false),
  updateBusy = ref(false);
const initialEditState = ref("");
const editState = () =>
  JSON.stringify([
    activeObjectName.value,
    activeObjectDetail.value,
    activeObjectLayer.value,
    activeShapeColor.value,
    activeShapeLineType.value,
    activeShapeArrowType.value,
    activeShapeWeight.value,
  ]);
let availabilitySequence = 0;
let availabilityController: AbortController | undefined;
const refreshFormAvailability = async () => {
  const seq = ++availabilitySequence,
    id = props.targetId,
    type = props.targetType;
  availabilityController?.abort();
  availabilityController = new AbortController();
  formAvailable.value = false;
  if (!props.isOpen || !id) return;
  try {
    const config = (
      await apiClient.get<{ form_schema: { fields: unknown[] } }>(`/${type}/${id}/form`, {
        signal: availabilityController.signal,
      })
    ).data;
    if (
      seq === availabilitySequence &&
      props.isOpen &&
      id === props.targetId &&
      type === props.targetType
    )
      formAvailable.value = !!config.form_schema.fields.length;
  } catch {
    /* 通常編集はフォーム情報の通信失敗に左右されない。 */
  }
};
onBeforeUnmount(() => {
  ++availabilitySequence;
  availabilityController?.abort();
});
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
    isFormInputOpen.value = false;
    isFormSettingsOpen.value = false;
    confirmFormOpen.value = false;
    if (props.isOpen) {
      loadTarget();
      initialEditState.value = editState();
    }
    void refreshFormAvailability();
  },
  { immediate: true },
);

const saveMapObject = async (keepOpen = false): Promise<boolean> => {
  if (props.targetId === "" || activeObjectLayer.value === "") {
    emit("message", "所属レイヤを選択してください。");
    return false;
  }
  if (!isShape.value && (activeObjectName.value === "" || activeObjectDetail.value === "")) {
    emit("message", "マーカー名と内容の両方に入力が必要です。");
    return false;
  }
  let updatePayload: MapObjectUpdatePayload;
  let previousLayerId: string;

  if (isShape.value) {
    const shape = shapeStore.getById(props.targetId);
    if (!shape) return false;
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
      return false;
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
    if (!marker) return false;
    previousLayerId = marker.layer_id;
    const updatedMarker = await mapobjStore.updateMapObject(
      props.targetId,
      activeObjectName.value,
      activeObjectDetail.value,
      activeObjectLayer.value,
    );
    if (!updatedMarker) {
      emit("message", "マーカー情報を更新できませんでした。");
      return false;
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
  if (!keepOpen) {
    emit("close");
    emit("message", "更新しました。");
  } else {
    loadTarget();
    initialEditState.value = editState();
  }
  return true;
};
const updateMapObject = async (keepOpen = false): Promise<boolean> => {
  if (updateBusy.value) return false;
  updateBusy.value = true;
  try {
    return await saveMapObject(keepOpen);
  } finally {
    updateBusy.value = false;
  }
};
const openFormInput = () => {
  if (!formAvailable.value || updateBusy.value) return;
  if (editState() !== initialEditState.value) {
    confirmFormOpen.value = true;
    return;
  }
  isFormInputOpen.value = true;
};
const saveThenOpenForm = async () => {
  confirmFormOpen.value = false;
  const id = props.targetId,
    type = props.targetType;
  if (
    (await updateMapObject(true)) &&
    props.isOpen &&
    props.targetId === id &&
    props.targetType === type
  )
    isFormInputOpen.value = true;
};
const formSaved = (object: MapObjectData | ShapeData) => {
  if (object.id !== props.targetId) return;
  let payload: MapObjectUpdatePayload;
  const previousLayerId = activeObjectLayer.value;
  if ("geojson" in object) {
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
  loadTarget();
  initialEditState.value = editState();
  isFormInputOpen.value = false;
  emit("updated", payload, previousLayerId);
  emit("close");
  emit("message", "フォームの回答を保存しました。");
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

defineExpose({ insertUploadedMarkdown });
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div
      class="main-container"
      :inert="updateBusy || isFormInputOpen || isFormSettingsOpen || confirmFormOpen"
    >
      <h2 id="map-object-edit-h2">{{ isShape ? "図形情報の編集" : "マーカー情報の編集" }}</h2>
      <div class="input-text-row">
        <input
          class="input-text"
          type="text"
          :placeholder="isShape ? '図形名' : 'マーカー名'"
          :maxlength="isShape ? 80 : undefined"
          v-model="activeObjectName"
        />
        <select class="select-elm-editform" v-model="activeObjectLayer">
          <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
            {{ obj.name }}
          </option>
        </select>
      </div>
      <div v-if="isShape" class="shape-style-row">
        <label>
          色
          <input v-model="activeShapeColor" type="color" aria-label="図形色" />
        </label>
        <label>
          線種
          <select v-model="activeShapeLineType" class="shape-line-select">
            <option v-for="option in lineTypeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label v-if="isPolyline">
          矢印
          <select v-model="activeShapeArrowType" class="shape-line-select">
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
        <label class="detail-label" for="detail">
          {{ isShape ? "メモ（Markdown）" : "マーカーの内容" }}
          <span class="free-input-label">自由入力</span>
        </label>
        <div class="markdown-editor">
          <textarea
            ref="detailTextarea"
            class="input-detail-markdown"
            :class="{ 'shape-detail-markdown': isShape }"
            id="detail"
            name="detail"
            aria-describedby="detail-input-help"
            placeholder="## マークダウンで記述"
            :maxlength="isShape ? 10000 : undefined"
            v-model="activeObjectDetail"
          ></textarea>
          <button
            type="button"
            :disabled="updateBusy"
            @click="updateMapObject()"
            class="btn-update"
          >
            +更新
          </button>
          <div class="input-tools">
            <button
              @click="emit('openImageUpload')"
              class="btn-function-image-editor"
              title="ファイルの追加"
            >
              <img
                :src="`${assetsUrl}smartphone_line24.png`"
                class="input-tools-img"
                alt="smartphone_line24.png"
              />
            </button>
            <button
              @click="emit('openImageList')"
              class="btn-function-image-editor"
              title="ファイル一覧"
            >
              <img
                :src="`${assetsUrl}documents_line24.png`"
                class="input-tools-img"
                alt="documents_line24.png"
              />
            </button>
            <button
              @click="insertMarkdown('## ')"
              class="btn-function-image-editor"
              title="## を挿入"
            >
              <img
                :src="`${assetsUrl}format_h2_24.png`"
                class="input-tools-img"
                alt="format_h2_24.png"
              />
            </button>
            <button
              @click="insertMarkdown('### ')"
              class="btn-function-image-editor"
              title="### を挿入"
            >
              <img
                :src="`${assetsUrl}format_h3_24.png`"
                class="input-tools-img"
                alt="format_h3_24.png"
              />
            </button>
            <button
              @click="insertMarkdown('- ')"
              class="btn-function-image-editor"
              title="- を挿入"
            >
              <img
                :src="`${assetsUrl}format_list_bulleted_24.png`"
                class="input-tools-img"
                alt="format_list_bulleted_24.png"
              />
            </button>
            <button
              @click="insertMarkdown('1. ')"
              class="btn-function-image-editor"
              title="1. を挿入"
            >
              <img
                :src="`${assetsUrl}format_list_numbered_24.png`"
                class="input-tools-img"
                alt="format_list_numbered_24.png"
              />
            </button>
            <button
              @click="insertMarkdown('**')"
              class="btn-function-image-editor"
              title="** を挿入"
            >
              <img
                :src="`${assetsUrl}format_bold_24.png`"
                class="input-tools-img"
                alt="format_bold_24.png"
              />
            </button>
            <button
              @click="insertMarkdown('[ Title ]( URL )')"
              class="btn-function-image-editor"
              title="[ Title ]( URL )を挿入"
            >
              <img :src="`${assetsUrl}link_24.png`" class="input-tools-img" alt="link_24.png" />
            </button>
            <button
              @click="insertMarkdown(':::details タイトル\n非表示にする内容\n:::')"
              class="btn-function-image-editor"
              title=":::details を挿入"
            >
              <img :src="`${assetsUrl}more_24.png`" class="input-tools-img" alt="more_24.png" />
            </button>
            <button
              @click="insertMarkdown(':::note タイトル\n内容\n:::')"
              class="btn-function-image-editor"
              title=":::note を挿入"
            >
              <img :src="`${assetsUrl}info_24.png`" class="input-tools-img" alt="info_24.png" />
            </button>
            <button
              @click="insertMarkdown(':::warning タイトル\n内容\n:::')"
              class="btn-function-image-editor"
              title=":::warning を挿入"
            >
              <img
                :src="`${assetsUrl}warning_24.png`"
                class="input-tools-img"
                alt="warning_24.png"
              />
            </button>
          </div>
        </div>
        <div id="detail-input-help" class="input-help">
          <p>ここに直接入力した内容は、<strong>フォーム回答の分析対象にはなりません</strong>。</p>
          <p>
            フォーム回答から追記された文章を直接編集しても、分析用の回答データは変更されません。
          </p>
          <p v-if="formAvailable">
            分析するデータは「<strong>フォームで回答を登録</strong>」から入力してください。
          </p>
          <p v-else>
            分析するデータはフォームから登録します。未設定の場合は「<strong>入力フォーム設定</strong>」から設定してください。
          </p>
        </div>
      </div>
      <div class="btn-commit-row" :class="{ 'has-form-input': formAvailable }">
        <button
          :disabled="updateBusy"
          @click="isFormSettingsOpen = true"
          class="btn-standard btn-form-settings"
        >
          入力フォーム設定
        </button>
        <button
          v-if="formAvailable"
          type="button"
          class="btn-standard btn-form-settings btn-form-answer"
          :disabled="updateBusy"
          @click="openFormInput"
        >
          フォームで回答を登録
        </button>
      </div>
      <button type="button" class="close-button" :disabled="updateBusy" @click="emit('close')">
        閉じる
      </button>
    </div>
  </BaseModal>
  <MapObjectFormSettingsModal
    :isOpen="isFormSettingsOpen"
    :targetType="targetType"
    :targetId="targetId"
    @saved="refreshFormAvailability"
    @close="isFormSettingsOpen = false"
    @message="(text: string) => emit('message', text)"
  />
  <MapObjectFormInputModal
    v-if="isFormInputOpen"
    :isOpen="isFormInputOpen"
    :targetType="targetType"
    :targetId="targetId"
    @close="isFormInputOpen = false"
    @saved="formSaved"
  />
  <MessageModal
    :isOpen="confirmFormOpen"
    message="未保存の編集内容を保存して、フォーム入力を開きますか？"
    confirmLabel="保存してフォームを開く"
    @close="confirmFormOpen = false"
    @confirm="saveThenOpenForm"
  />
</template>

<style scoped>
.free-input-label {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #e9edf2;
  color: #425466;
  font-size: 0.8rem;
}
.input-help {
  color: #475569;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.input-help {
  margin-top: 8px;
  text-align: left;
}
.input-help p {
  margin: 4px 0;
}
.btn-commit-row.has-form-input > .btn-form-answer {
  height: auto;
  min-height: 40px;
  white-space: normal;
  line-height: 1.3;
  padding: 6px 4px;
}
.btn-commit-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
.btn-commit-row > button {
  flex: 0 1 auto;
  min-width: 0;
  height: 40px;
  margin: 0;
  padding: 8px 4px;
  border-radius: 16px;
  font-size: clamp(10px, 3.1vw, 13px);
  box-sizing: border-box;
}
.btn-commit-row.has-form-input {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.btn-commit-row.has-form-input > button {
  width: 100%;
}
.btn-commit-row button:disabled {
  opacity: 0.5;
  cursor: default;
}

.main-container {
  max-height: calc(100dvh - 64px);
  overflow-y: auto;
  box-sizing: border-box;
  display: flex;
  position: relative;
  flex-direction: column;
  gap: 5px;
  padding: 5px;
}

#map-object-edit-h2 {
  text-align: center;
}

.input-text-row {
  text-align: center;
  display: flex;
  width: 100%;
  margin-bottom: 2%;
}

.input-text {
  font-size: 20px;
  width: 70%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.textarea-row {
  text-align: center;
  margin-bottom: 10px;
}

.detail-label {
  display: block;
  text-align: left;
  margin-bottom: 4px;
}

.markdown-editor {
  position: relative;
}

.shape-style-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 16px;
  margin-bottom: 10px;
}

.shape-style-row label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shape-line-select {
  min-height: 36px;
  border-radius: 5px;
}

.shape-weight-label {
  grid-column: 1 / -1;
}

.shape-weight-label input {
  flex: 1;
}

.input-detail-markdown {
  display: block;
  width: 100%;
  height: clamp(160px, 32dvh, 280px);
  padding: 10px 80px 76px 12px;
  resize: vertical;
  margin: auto;
  box-sizing: border-box;
  font-size: 22px;
  color: #333;
  background-color: #f9f9f9;
  border: 1px solid #a9a9a9;
  border-radius: 6px;
  outline: none;
  transition:
    border-color 0.3s,
    box-shadow 0.3s;
  justify-content: center;
}

.shape-detail-markdown {
  height: clamp(144px, 26dvh, 240px);
}

.input-tools {
  position: absolute;
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
  top: 8px;
  right: 8px;
  bottom: 68px;
  width: 55px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
}

.input-tools::-webkit-scrollbar {
  display: none;
}

.btn-commit-row {
  position: static;
  margin-top: 12px;
}

.btn-function-image-editor {
  width: 55px;
  height: 45px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  margin: 0;
  text-align: center;
}

.input-tools-img {
  border: none;
  box-shadow: none;
  width: 28px;
}

.function-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.close-button {
  position: absolute;
  top: 1px;
  right: 0.5px;
  border: 0.5px solid transparent;
  border-radius: 8px;
  padding: 0.4em 0.8em;
  background-color: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.25s;
}

.close-button:hover {
  border-color: #396cd8;
}

.close-button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}

.select-elm-editform {
  width: 30%;
  height: auto;
  font-size: 18px;
  background: white;
  color: #000000;
  padding: 8px 8px;
  text-decoration: none;
  border: solid 1px #adadad;
  border-radius: 8px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.btn-standard {
  width: auto;
  height: 50px;
  margin: 5px;
  border-radius: 20px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  text-decoration: none;
  transition: background-color 0.3s;
}

.btn-update {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 1;
  min-width: 90px;
  height: 44px;
  margin: 0;
  padding: 0 14px;
  border: 1px solid rgb(23, 155, 126);
  border-radius: 16px;
  background: rgb(23, 155, 126);
  color: #fff;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.btn-update:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-form-settings {
  border: 1px solid #7890b6;
  background: #edf4ff;
  color: #183a70;
}
</style>
