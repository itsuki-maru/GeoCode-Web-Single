<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import { mergeFreeText, type FormBody } from "@/utils/form-body";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import MapObjectFormInputModal from "./MapObjectFormInputModal.vue";
import type { MapObjectData, ShapeData } from "@/interface";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MapObjectFormSettingsModal from "@/components/map-object/MapObjectFormSettingsModal.vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import type { LayersData, MapObjectUpdatePayload, ShapeGeoJson } from "@/interface";
import { assetsUrl } from "@/setting";

const props = defineProps<{
  isOpen: boolean;
  targetType: "marker" | "shape";
  targetId: string;
  layerList: Map<string, LayersData>;
  isHttpsProtocol: boolean;
}>();

const emit = defineEmits<{
  close: [];
  updated: [payload: MapObjectUpdatePayload, previousLayerId: string];
  deleted: [id: string];
  openImageUpload: [];
  openImageList: [];
  message: [text: string];
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
const isFormInputOpen = ref(false),
  formAvailable = ref(false),
  confirmFormOpen = ref(false),
  updateBusy = ref(false);
const initialEditState = ref("");
const bodyInfo = ref<FormBody | null>(null),
  bodyLoading = ref(false),
  bodyError = ref("");
let bodySequence = 0;
const loadBody = async () => {
  const sequence = ++bodySequence,
    id = props.targetId,
    kind = props.targetType;
  bodyInfo.value = null;
  bodyError.value = "";
  if (!props.isOpen || !id) {
    bodyLoading.value = false;
    return;
  }
  bodyLoading.value = true;
  const original = activeObjectDetail.value;
  try {
    const info = (await apiClient.get<FormBody>(`/${kind}/${id}/form/body`)).data;
    if (
      sequence !== bodySequence ||
      !props.isOpen ||
      id !== props.targetId ||
      kind !== props.targetType
    )
      return;
    if (typeof info.free_text !== "string" || !Array.isArray(info.parts)) return;
    bodyInfo.value = info;
    if (!info.sync_required && activeObjectDetail.value === original) {
      activeObjectDetail.value = info.free_text;
      const initial = JSON.parse(initialEditState.value) as unknown[];
      initial[1] = info.free_text;
      initialEditState.value = JSON.stringify(initial);
      const protectedInitial = JSON.parse(initialProtectedState.value) as unknown[];
      protectedInitial[0] = info.free_text;
      initialProtectedState.value = JSON.stringify(protectedInitial);
    }
  } catch (error) {
    if (sequence !== bodySequence) return;
    if (!(apiClient.isAxiosError(error) && error.response?.status === 404))
      bodyError.value = "本文・メモを確認できませんでした。編集を開き直してください。";
  } finally {
    if (sequence === bodySequence) bodyLoading.value = false;
  }
};
const displayedBody = () =>
  bodyInfo.value && !bodyInfo.value.sync_required
    ? mergeFreeText(bodyInfo.value, activeObjectDetail.value)
    : activeObjectDetail.value;
const bodyEdit = () =>
  bodyInfo.value && !bodyInfo.value.sync_required
    ? { free_text: activeObjectDetail.value, body_token: bodyInfo.value.body_token }
    : undefined;

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
  ++bodySequence;
  availabilityController?.abort();
});
const detailTextarea = ref<HTMLTextAreaElement | null>(null);
const isShape = computed(() => props.targetType === "shape");
// Both the saved layer and destination apply until the move has been saved.
const originalLayerId = computed(() =>
  isShape.value
    ? shapeStore.getById(props.targetId)?.layer_id
    : mapobjStore.getById(props.targetId)?.layer_id,
);
const inputRestricted = computed(
  () =>
    !!(
      props.layerList.get(originalLayerId.value || "")?.restrict_free_text ||
      props.layerList.get(activeObjectLayer.value)?.restrict_free_text
    ),
);
const protectedState = () =>
  JSON.stringify([
    activeObjectDetail.value,
    activeShapeColor.value,
    activeShapeLineType.value,
    activeShapeArrowType.value,
    activeShapeWeight.value,
  ]);
const initialProtectedState = ref("");
const selectObjectLayer = (event: Event) => {
  const select = event.target as HTMLSelectElement;
  const next = select.value;
  if (
    props.layerList.get(next)?.restrict_free_text &&
    initialProtectedState.value &&
    protectedState() !== initialProtectedState.value
  ) {
    select.value = activeObjectLayer.value;
    emit(
      "message",
      "内容・メモ・図形スタイルの変更を保存するか、編集を開き直してから移動先を選択してください。",
    );
    return;
  }
  activeObjectLayer.value = next;
};

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
  initialProtectedState.value = "";
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
    initialProtectedState.value = protectedState();
    return;
  }
  const marker = mapobjStore.getById(props.targetId);
  activeObjectName.value = marker?.marker_name || "";
  activeObjectDetail.value = marker?.detail || "";
  activeObjectLayer.value = marker?.layer_id || "";
  initialProtectedState.value = protectedState();
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
    void loadBody();
  },
  { immediate: true },
);

watch(
  () =>
    isShape.value
      ? shapeStore.getById(props.targetId)?.geojson
      : mapobjStore.getById(props.targetId)?.detail,
  () => {
    if (!props.isOpen || updateBusy.value || editState() !== initialEditState.value) return;
    loadTarget();
    initialEditState.value = editState();
    void loadBody();
  },
);

const saveMapObject = async (keepOpen = false): Promise<boolean> => {
  if (bodyLoading.value || bodyError.value) return false;
  if (props.targetId === "" || activeObjectLayer.value === "") {
    emit("message", "所属レイヤを選択してください。");
    return false;
  }
  if (!isShape.value && activeObjectName.value.trim() === "") {
    emit("message", "マーカー名を入力してください。");
    return false;
  }

  if (inputRestricted.value && protectedState() !== initialProtectedState.value) {
    emit("message", "入力が制限されています。編集を開き直してください。");
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
      memo: displayedBody(),
      style: nextStyle,
    };
    const updatedShape = await shapeStore.updateShape(
      props.targetId,
      activeObjectName.value,
      activeObjectLayer.value,
      inputRestricted.value ? undefined : nextGeoJson,
      ...(bodyEdit() ? ([bodyEdit()] as const) : []),
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
      displayedBody(),
      activeObjectLayer.value,
      ...(bodyEdit() ? ([bodyEdit()] as const) : []),
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
    await loadBody();
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
    shapeStore.upsertRecord(object);
    mapobjStore.refreshSearchResults();
    payload = {
      objectType: "shape",
      id: object.id,
      layerId: object.layer_id,
      shapeType: object.shape_type,
      name: object.name || "",
      geojson: object.geojson,
    };
  } else {
    mapobjStore.upsertRecord(object);
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

const deleteMarker = async (): Promise<void> => {
  if (props.targetId === "" || isShape.value) {
    return;
  }
  const id = props.targetId;
  const deleted = await mapobjStore.deleteMapObject(id);
  isDeleteCheckModal.value = false;
  if (!deleted) {
    emit("message", "マーカーを削除できませんでした。");
    return;
  }
  emit("close");
  emit("deleted", id);
};

function insertMarkdown(text: string) {
  if (inputRestricted.value) return;
  const textareaElm = detailTextarea.value;
  if (!textareaElm || bodyLoading.value || bodyError.value || bodyInfo.value?.sync_required) return;
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
    <div
      class="content-map-object-edit"
      :inert="updateBusy || isFormInputOpen || isFormSettingsOpen || confirmFormOpen"
    >
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
          <select
            class="select-elm-editform"
            :value="activeObjectLayer"
            @change="selectObjectLayer"
          >
            <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
              {{ obj.name }}
            </option>
          </select>
        </div>
      </div>
      <div v-if="isShape" class="shape-style-row">
        <label>
          色
          <input
            :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
            v-model="activeShapeColor"
            type="color"
            aria-label="図形色"
          />
        </label>
        <label>
          線種
          <select
            :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
            v-model="activeShapeLineType"
            class="select-elm-editform shape-line-select"
          >
            <option v-for="option in lineTypeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label v-if="isPolyline">
          矢印
          <select
            :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
            v-model="activeShapeArrowType"
            class="select-elm-editform shape-line-select"
          >
            <option v-for="option in arrowTypeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="shape-weight-label">
          太さ
          <input
            :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
            v-model.number="activeShapeWeight"
            type="range"
            min="1"
            max="10"
            step="1"
          />
          <output>{{ activeShapeWeight }}px</output>
        </label>
      </div>
      <div class="textarea-row">
        <div class="input-select-row-group">
          <label class="row" for="detail">
            {{ isShape ? "メモ（Markdown）" : "マーカーの内容" }}
            <span class="free-input-label">{{ inputRestricted ? "入力制限中" : "自由入力" }}</span>
          </label>
          <div class="markdown-editor">
            <textarea
              ref="detailTextarea"
              class="input-detail-markdown"
              :class="{ 'shape-detail-markdown': isShape }"
              id="detail"
              name="detail"
              aria-describedby="detail-input-help"
              :readonly="inputRestricted || !!bodyInfo?.sync_required || !!bodyError"
              :disabled="bodyLoading"
              :placeholder="inputRestricted ? '入力が制限されています。' : '## マークダウンで記述'"
              :maxlength="isShape ? 10000 : undefined"
              v-model="activeObjectDetail"
            ></textarea>
            <button
              type="button"
              :disabled="updateBusy || bodyLoading || !!bodyError"
              @click="updateMapObject()"
              class="btn-update"
            >
              +更新
            </button>
          </div>
        </div>
      </div>
      <div class="map-object-edit-row">
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="!inputRestricted && emit('openImageUpload')"
          class="btn-function-image"
          title="ファイルの追加"
        >
          <img
            :src="`${assetsUrl}smartphone_line24.png`"
            class="function-img"
            alt="smartphone_line24.png"
          />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="!inputRestricted && emit('openImageList')"
          class="btn-function-image"
          title="ファイル一覧"
        >
          <img
            :src="`${assetsUrl}documents_line24.png`"
            class="function-img"
            alt="documents_line24.png"
          />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('## ')"
          class="btn-function-image"
          title="## を挿入"
        >
          <img :src="`${assetsUrl}format_h2_24.png`" class="function-img" alt="format_h2_24.png" />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('### ')"
          class="btn-function-image"
          title="### を挿入"
        >
          <img :src="`${assetsUrl}format_h3_24.png`" class="function-img" alt="format_h3_24.png" />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('- ')"
          class="btn-function-image"
          title="- を挿入"
        >
          <img
            :src="`${assetsUrl}format_list_bulleted_24.png`"
            class="function-img"
            alt="format_list_bulleted_24.png"
          />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('1. ')"
          class="btn-function-image"
          title="1. を挿入"
        >
          <img
            :src="`${assetsUrl}format_list_numbered_24.png`"
            class="function-img"
            alt="format_list_numbered_24.png"
          />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('**')"
          class="btn-function-image"
          title="** を挿入"
        >
          <img
            :src="`${assetsUrl}format_bold_24.png`"
            class="function-img"
            alt="format_bold_24.png"
          />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown('[ Title ]( URL )')"
          class="btn-function-image"
          title="[ Title ]( URL )を挿入"
        >
          <img :src="`${assetsUrl}link_24.png`" class="function-img" alt="link_24.png" />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown(':::details タイトル\n非表示にする内容\n:::')"
          class="btn-function-image"
          title=":::details を挿入"
        >
          <img :src="`${assetsUrl}more_24.png`" class="function-img" alt="more_24.png" />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
          @click="insertMarkdown(':::note タイトル\n内容\n:::')"
          class="btn-function-image"
          title=":::note を挿入"
        >
          <img :src="`${assetsUrl}info_24.png`" class="function-img" alt="info_24.png" />
        </button>
        <button
          :disabled="inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError"
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
      <div id="detail-input-help" class="input-help">
        <p v-if="bodyError" role="alert">{{ bodyError }}</p>
        <p v-if="bodyInfo?.sync_required">
          本文・メモと回答の対応確認が必要です。回答一覧の「編集」から確認してください。
        </p>
        <details
          v-if="bodyInfo && !bodyInfo.sync_required && bodyInfo.managed_markdown"
          class="managed-answers"
        >
          <summary>フォーム回答からの内容（回答一覧から編集）</summary>
          <pre>{{ bodyInfo.managed_markdown }}</pre>
        </details>
        <p v-if="inputRestricted">
          <strong>入力が制限されています。</strong
          >名前と所属レイヤを変更できます。内容・メモはフォームから登録してください。
          <span v-if="isShape">図形の頂点は地図上で編集できます。</span>
        </p>
        <p>ここに直接入力した内容は、<strong>フォーム回答の分析対象にはなりません</strong>。</p>
        <p v-if="!bodyInfo">
          フォーム回答から追記された文章を直接編集しても、分析用の回答データは変更されません。
        </p>
        <p v-if="formAvailable">
          分析するデータは「<strong>フォームで回答を登録</strong>」から入力してください。
        </p>
        <p v-else>
          分析するデータはフォームから登録します。未設定の場合は「<strong>入力フォーム設定</strong>」から設定してください。
        </p>
      </div>
      <div class="btn-commit-row">
        <button
          :disabled="updateBusy || bodyLoading || !!bodyError"
          @click="isFormSettingsOpen = true"
          class="btn-form-settings"
        >
          入力フォーム設定
        </button>
        <button
          v-if="formAvailable"
          type="button"
          class="btn-form-settings"
          :disabled="updateBusy || bodyLoading || !!bodyError"
          @click="openFormInput"
        >
          フォームで回答を登録
        </button>
      </div>
      <button
        type="button"
        class="close-button"
        :disabled="updateBusy || bodyLoading || !!bodyError"
        @click="emit('close')"
      >
        閉じる
      </button>
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
.managed-answers pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 16vh;
  overflow: auto;
}
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
.btn-commit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  max-width: calc(100% - 24px);
}
.btn-commit-row button:disabled {
  opacity: 0.5;
  cursor: default;
}

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
  margin: 16px auto;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
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

.markdown-editor {
  position: relative;
}

.input-detail-markdown {
  display: block;
  resize: vertical;
  font-size: 20px;
  width: 100%;
  border-radius: 8px;
  border: 1px solid #999999;
  padding: 0.6em 1.2em 76px;
  font-family: inherit;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
  height: 44vh;
}

.shape-detail-markdown {
  height: 36vh;
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
  margin-bottom: 1%;
}

.btn-commit-row {
  position: static;
  margin-top: 12px;
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
