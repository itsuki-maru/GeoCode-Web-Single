<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import "./mobile-data-modal.css";
import { useMobileModalViewport } from "@/composables/useMobileModalViewport";
import { mergeFreeText, type FormBody } from "@/utils/form-body";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import MapObjectFormInputModal from "./MapObjectFormInputModal.vue";
import FormAnswersModal from "./FormAnswersModal.vue";
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
const modalViewportStyle = useMobileModalViewport();

const activeObjectName = ref("");
const activeObjectDetail = ref("");
const activeObjectLayer = ref("");
const activeShapeColor = ref("#d94841");
const activeShapeLineType = ref("solid");
const activeShapeArrowType = ref<"none" | "start" | "end" | "both">("none");
const activeShapeWeight = ref(5);
const isFormSettingsOpen = ref(false);
const isFormInputOpen = ref(false),
  isFormAnswersOpen = ref(false),
  formAvailable = ref(false),
  confirmFormOpen = ref(false),
  updateBusy = ref(false);
const formDestination = ref<"input" | "answers">("input");
const initialEditState = ref("");
const shapeSettingsOpen = ref(false),
  toolsOpen = ref(false),
  helpOpen = ref(false),
  managedOpen = ref(false);
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
// 移動が保存されるまでは、保存済みのレイヤと移動先の両方の制約を適用する。
const originalLayerId = computed(() =>
  isShape.value
    ? shapeStore.getById(props.targetId)?.layer_id
    : mapobjStore.getById(props.targetId)?.layer_id,
);
const inputRestricted = computed(
  () =>
    !!(
      layerList.value.get(originalLayerId.value || "")?.restrict_free_text ||
      layerList.value.get(activeObjectLayer.value)?.restrict_free_text
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
    layerList.value.get(next)?.restrict_free_text &&
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
    isFormAnswersOpen.value = false;
    isFormSettingsOpen.value = false;
    confirmFormOpen.value = false;
    formDestination.value = "input";
    shapeSettingsOpen.value = toolsOpen.value = helpOpen.value = managedOpen.value = false;
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
const openFormDestination = (destination: "input" | "answers") => {
  if (destination === "input") isFormInputOpen.value = true;
  else isFormAnswersOpen.value = true;
};
const openForm = (destination: "input" | "answers") => {
  if (!props.targetId || updateBusy.value || bodyLoading.value || bodyError.value) return;
  if (destination === "input" && !formAvailable.value) return;
  formDestination.value = destination;
  if (editState() !== initialEditState.value) {
    confirmFormOpen.value = true;
    return;
  }
  openFormDestination(destination);
};
const saveThenOpenForm = async () => {
  confirmFormOpen.value = false;
  const id = props.targetId,
    type = props.targetType,
    destination = formDestination.value;
  if (
    (await updateMapObject(true)) &&
    props.isOpen &&
    props.targetId === id &&
    props.targetType === type
  )
    openFormDestination(destination);
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
  emit("message", "フォームの登録内容を保存しました。");
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

const editorTools = [
  {
    label: "ファイル追加",
    title: "ファイルの追加",
    icon: "smartphone_line24.png",
    action: "upload",
  },
  { label: "ファイル一覧", title: "ファイル一覧", icon: "documents_line24.png", action: "files" },
  { label: "見出し", title: "## を挿入", icon: "format_h2_24.png", markdown: "## " },
  { label: "小見出し", title: "### を挿入", icon: "format_h3_24.png", markdown: "### " },
  { label: "箇条書き", title: "- を挿入", icon: "format_list_bulleted_24.png", markdown: "- " },
  { label: "番号付き", title: "1. を挿入", icon: "format_list_numbered_24.png", markdown: "1. " },
  { label: "太字", title: "** を挿入", icon: "format_bold_24.png", markdown: "**" },
  {
    label: "リンク",
    title: "[ Title ]( URL )を挿入",
    icon: "link_24.png",
    markdown: "[ Title ]( URL )",
  },
  {
    label: "折りたたみ",
    title: ":::details を挿入",
    icon: "more_24.png",
    markdown: ":::details タイトル\n非表示にする内容\n:::",
  },
  {
    label: "補足",
    title: ":::note を挿入",
    icon: "info_24.png",
    markdown: ":::note タイトル\n内容\n:::",
  },
  {
    label: "注意",
    title: ":::warning を挿入",
    icon: "warning_24.png",
    markdown: ":::warning タイトル\n内容\n:::",
  },
];
const textEditingDisabled = computed(
  () =>
    inputRestricted.value ||
    bodyLoading.value ||
    !!bodyInfo.value?.sync_required ||
    !!bodyError.value,
);
const runEditorTool = (tool: (typeof editorTools)[number]) => {
  if (textEditingDisabled.value || updateBusy.value) return;
  if (tool.action === "upload") emit("openImageUpload");
  else if (tool.action === "files") emit("openImageList");
  else if (tool.markdown) insertMarkdown(tool.markdown);
};

defineExpose({ insertUploadedMarkdown });
</script>

<template>
  <BaseModal
    class="mobile-data-modal mobile-object-edit"
    :style="modalViewportStyle"
    :isOpen="isOpen"
    :closeOnOverlayClick="!updateBusy"
    @close="emit('close')"
  >
    <div
      class="mobile-data-panel main-container"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-object-edit-h2"
      :inert="
        updateBusy ||
        isFormInputOpen ||
        isFormAnswersOpen ||
        isFormSettingsOpen ||
        confirmFormOpen ||
        undefined
      "
    >
      <header class="mobile-data-header">
        <h2 id="map-object-edit-h2">{{ isShape ? "図形情報の編集" : "マーカー情報の編集" }}</h2>
        <button type="button" class="close-button" :disabled="updateBusy" @click="emit('close')">
          閉じる
        </button>
      </header>
      <div class="mobile-data-body">
        <section class="edit-section basic-information" aria-labelledby="object-basic-heading">
          <h3 id="object-basic-heading">基本情報</h3>
          <div class="input-text-row">
            <label :for="`object-name-${targetType}`"
              >{{ isShape ? "図形名" : "マーカー名" }}
              <input
                :id="`object-name-${targetType}`"
                class="input-text"
                type="text"
                :placeholder="isShape ? '図形名' : 'マーカー名'"
                :maxlength="isShape ? 80 : undefined"
                v-model="activeObjectName"
              />
            </label>
            <label :for="`object-layer-${targetType}`"
              >所属レイヤ
              <select
                :id="`object-layer-${targetType}`"
                class="select-elm-editform"
                :value="activeObjectLayer"
                @change="selectObjectLayer"
              >
                <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
                  {{ obj.name }}
                </option>
              </select>
            </label>
          </div>
        </section>
        <details
          v-if="isShape"
          class="edit-section shape-settings"
          :open="shapeSettingsOpen"
          @toggle="shapeSettingsOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>図形の表示設定</summary>
          <div class="shape-style-row">
            <label>
              色
              <input
                :disabled="
                  inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError
                "
                v-model="activeShapeColor"
                type="color"
                aria-label="図形色"
              />
            </label>
            <label>
              線種
              <select
                :disabled="
                  inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError
                "
                v-model="activeShapeLineType"
                class="shape-line-select"
              >
                <option v-for="option in lineTypeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label v-if="isPolyline">
              矢印
              <select
                :disabled="
                  inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError
                "
                v-model="activeShapeArrowType"
                class="shape-line-select"
              >
                <option
                  v-for="option in arrowTypeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label class="shape-weight-label">
              太さ
              <input
                :disabled="
                  inputRestricted || bodyLoading || !!bodyInfo?.sync_required || !!bodyError
                "
                v-model.number="activeShapeWeight"
                type="range"
                min="1"
                max="10"
                step="1"
              />
              <output>{{ activeShapeWeight }}px</output>
            </label>
          </div>
        </details>
        <section class="edit-section textarea-row">
          <label class="detail-label" for="detail">
            {{ isShape ? "メモ（Markdown）" : "マーカーの内容" }}
            <span class="free-input-label">{{ inputRestricted ? "入力制限中" : "自由入力" }}</span>
          </label>
          <p v-if="bodyLoading" class="input-help" role="status">本文・メモを読み込んでいます…</p>
          <p v-if="bodyError" class="input-warning" role="alert">{{ bodyError }}</p>
          <p v-if="bodyInfo?.sync_required" class="input-warning" role="alert">
            本文・メモと登録の対応確認が必要です。登録一覧の「編集」から確認してください。
          </p>
          <p v-if="inputRestricted" class="input-warning" role="status">
            <strong>入力が制限されています。</strong
            >名前と所属レイヤを変更できます。内容・メモはフォームから登録してください。<span
              v-if="isShape"
              >図形の頂点は地図上で編集できます。</span
            >
          </p>
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
          <details
            class="editor-tools"
            :open="toolsOpen"
            @toggle="toolsOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>書式・ファイル</summary>
            <div class="input-tools">
              <button
                v-for="tool in editorTools"
                :key="tool.title"
                type="button"
                :disabled="textEditingDisabled || updateBusy"
                @click="runEditorTool(tool)"
                class="btn-function-image-editor"
                :title="tool.title"
              >
                <img :src="`${assetsUrl}${tool.icon}`" class="input-tools-img" alt="" /><span>{{
                  tool.label
                }}</span>
              </button>
            </div>
          </details>
          <div id="detail-input-help" class="input-help">
            <p>自由入力は、フォーム登録の分析対象にはなりません。</p>
            <details
              class="input-help-details"
              :open="helpOpen"
              @toggle="helpOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary>自由入力とフォーム登録について</summary>
              <p>
                分析するデータは「新しい登録を追加」から入力してください。フォーム未設定の場合は「入力フォーム設定」から設定できます。
              </p>
              <p>
                フォーム経由で追記された文章を直接編集しても、分析用の登録データは変更されません。既存の登録は「登録内容を確認・更新」から修正できます。
              </p>
            </details>
          </div>
        </section>
        <section class="edit-section form-registration" aria-labelledby="object-form-heading">
          <h3 id="object-form-heading">フォーム登録</h3>
          <p v-if="!formAvailable" class="input-help">
            新しく登録するには、入力フォームを設定してください。
          </p>
          <div class="btn-commit-row" :class="{ 'has-form-input': formAvailable }">
            <button
              v-if="formAvailable"
              type="button"
              class="btn-form-new"
              :disabled="updateBusy || bodyLoading || !!bodyError"
              @click="openForm('input')"
            >
              新しい登録を追加
            </button>
            <button
              type="button"
              class="btn-form-history"
              :disabled="updateBusy || bodyLoading || !!bodyError || !targetId"
              @click="openForm('answers')"
            >
              登録内容を確認・更新
            </button>
          </div>
          <button
            type="button"
            :disabled="updateBusy || bodyLoading || !!bodyError"
            @click="isFormSettingsOpen = true"
            class="btn-form-settings"
          >
            入力フォーム設定
          </button>
          <details
            v-if="bodyInfo && !bodyInfo.sync_required && bodyInfo.managed_markdown"
            class="managed-answers"
            :open="managedOpen"
            @toggle="managedOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>本文・メモに反映された登録内容</summary>
            <pre>{{ bodyInfo.managed_markdown }}</pre>
          </details>
        </section>
      </div>
      <footer class="mobile-data-footer">
        <button
          type="button"
          :disabled="updateBusy || bodyLoading || !!bodyError"
          @click="updateMapObject()"
          class="btn-update"
        >
          {{ updateBusy ? "保存中…" : "変更を保存" }}
        </button>
      </footer>
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
    :message="
      formDestination === 'answers'
        ? '未保存の編集内容を保存して、登録一覧を開きますか？'
        : '未保存の編集内容を保存して、フォーム入力を開きますか？'
    "
    :confirmLabel="
      formDestination === 'answers' ? '保存して登録一覧を開く' : '保存してフォームを開く'
    "
    @close="confirmFormOpen = false"
    @confirm="saveThenOpenForm"
  />
  <FormAnswersModal
    v-if="isOpen && isFormAnswersOpen"
    :isOpen="isFormAnswersOpen"
    :targetType="targetType"
    :targetId="targetId"
    @close="isFormAnswersOpen = false"
  />
</template>

<style scoped>
.main-container {
  color: #243248;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.edit-section + .edit-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #dce3eb;
}
h3 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 700;
}
.input-text-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.input-text-row label,
.shape-style-row label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}
.input-text,
.select-elm-editform,
.shape-line-select {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  padding: 9px 10px;
  border: 1px solid #b7c3d1;
  border-radius: 8px;
  box-sizing: border-box;
  background: #fff;
  color: #243248;
  font: inherit;
  font-size: 16px;
  font-weight: 400;
}
summary {
  min-height: 28px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.shape-settings > summary {
  font-weight: 700;
}
.shape-style-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 14px;
}
.shape-style-row input[type="color"] {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 44px;
  border: 1px solid #b7c3d1;
  border-radius: 8px;
  background: #fff;
}
.shape-weight-label {
  grid-column: 1 / -1;
}
.shape-weight-label input {
  width: 100%;
  min-width: 0;
  margin: 6px 0;
}
.shape-weight-label output {
  color: #52647b;
  font-size: 13px;
}
.detail-label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  font-weight: 700;
}
.free-input-label {
  display: inline-block;
  padding: 3px 7px;
  border-radius: 5px;
  background: #e9eef4;
  color: #52647b;
  font-size: 12px;
  font-weight: 500;
}
.input-detail-markdown {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: clamp(180px, 28dvh, 280px);
  padding: 12px;
  resize: vertical;
  box-sizing: border-box;
  font: inherit;
  font-size: 16px;
  line-height: 1.6;
  color: #243248;
  background: #fff;
  border: 1px solid #b7c3d1;
  border-radius: 8px;
}
.input-detail-markdown:focus {
  outline: 2px solid #4b78bd;
  outline-offset: 1px;
}
.editor-tools {
  margin-top: 12px;
  border: 1px solid #dce3eb;
  border-radius: 8px;
  background: #f8fafc;
  padding: 10px;
}
.input-tools {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.btn-function-image-editor {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 64px;
  margin: 0;
  padding: 8px 2px;
  border: 1px solid #d3deeb;
  border-radius: 8px;
  box-shadow: none;
  background: #fff;
  color: #33465f;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.input-tools-img {
  display: block;
  width: 24px;
  height: 24px;
  margin-bottom: 5px;
  border: 0;
  box-shadow: none;
}
.input-help {
  color: #52647b;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.input-help p {
  margin: 10px 0 0;
}
.input-help-details {
  margin-top: 8px;
}
.input-warning {
  margin: 0 0 10px;
  padding: 10px;
  border: 1px solid #e3c78b;
  border-radius: 8px;
  background: #fff9eb;
  color: #704d15;
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.btn-commit-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  margin-top: 12px;
}
.btn-commit-row button {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  padding: 10px 12px;
  box-sizing: border-box;
  border: 1px solid #718db4;
  border-radius: 8px;
  box-shadow: none;
  font: inherit;
  font-size: 15px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.btn-form-new {
  background: #edf4ff;
  color: #183e75;
}
.btn-form-history {
  background: #fff;
  color: #183e75;
}
.btn-form-settings {
  display: block;
  width: fit-content;
  max-width: 100%;
  min-height: 44px;
  margin: 4px 0 0;
  padding: 10px 0;
  background: transparent;
  color: #335d96;
  border: 0;
  box-shadow: none;
  font: inherit;
  font-size: 14px;
  text-decoration: underline;
  white-space: normal;
  overflow-wrap: anywhere;
}
.managed-answers {
  margin-top: 6px;
  color: #52647b;
  font-size: 13px;
}
.managed-answers pre {
  margin: 8px 0 0;
  padding: 10px;
  border: 1px solid #dce3eb;
  border-radius: 6px;
  background: #f8fafc;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.btn-update {
  width: 100%;
  min-width: 0;
  min-height: 46px;
  margin: 0;
  padding: 10px 14px;
  border: 1px solid #137b67;
  border-radius: 8px;
  background: #15806b;
  color: #fff;
  box-shadow: none;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (min-width: 600px) {
  .input-text-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .btn-commit-row.has-form-input {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
