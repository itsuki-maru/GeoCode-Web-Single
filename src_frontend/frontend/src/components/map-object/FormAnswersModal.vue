<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import MapObjectFormInputModal from "./MapObjectFormInputModal.vue";
import type { MapObjectData, ShapeData } from "@/interface";
import AnswerMapModal from "./AnswerMapModal.vue";
import apiClient from "@/axiosClient";
import { submitAuthenticatedForm } from "@/utils/authenticated-form";
import { baseUrl } from "@/setting";

interface Field {
  id: string;
  label: string;
  field_type: string;
  choices: string[];
}
interface Answer {
  id: string;
  target_type: "marker" | "shape";
  target_id: string;
  target_name: string;
  layer_id: string | null;
  layer_name: string | null;
  create_at: string;
  edited_at?: string | null;
  submitted_values: Record<string, unknown>;
  form_snapshot: {
    form_title: string;
    form_description: string;
    form_schema: { fields: { id: string; label: string; type: string }[] };
  } | null;
  source_form: { id: string; version: number } | null;
  common_form_name: string | null;
  common_form_deleted: boolean | null;
}
const canEdit = (answer: Answer): boolean => {
  const fields = answer.form_snapshot?.form_schema.fields;
  return (
    !!fields?.length &&
    Object.keys(answer.submitted_values).every((id) => fields.some((field) => field.id === id))
  );
};
interface Options {
  forms: { id: string; name: string; deleted: boolean }[];
  layers: { id: string; name: string }[];
  fields: Field[];
  versions: number[];
}
interface Cursor {
  at: string;
  id: string;
  target_type: string;
}
interface Page {
  editing_supported?: boolean;
  rows: Answer[];
  total: number;
  as_of: string;
  next_cursor: Cursor | null;
}
interface Condition {
  key: string;
  op: string;
  value: string;
  upper: string;
  choices: string[];
}
const props = defineProps<{
  isOpen: boolean;
  initialFormId?: string;
  targetId?: string;
  targetType?: "marker" | "shape";
}>();
const emit = defineEmits<{ close: [] }>();
const options = ref<Options>({ forms: [], layers: [], fields: [], versions: [] });
const filtersOpen = ref(false);
const usageHelpOpen = ref(false);
const mapHelpOpen = ref(false);
const mode = ref("history");
const form = ref("");
const version = ref("");
const kind = ref("");
const target = ref("");
const name = ref("");
const layer = ref("");
const from = ref("");
const until = ref("");
const conditions = ref<Condition[]>([]);
const displayFields = ref<string[]>([]);
const resultFields = ref<Field[]>([]);
const rows = ref<Answer[]>([]);
const total = ref(0);
const asOf = ref("");
const nextCursor = ref<Cursor | null>(null);
const cursors = ref<(Cursor | null)[]>([null]);
const page = ref(0);
const detail = ref<Answer | null>(null);
const editing = ref<Answer | null>(null),
  editingSupported = ref(false);
watch(
  () => [props.isOpen, props.targetId, props.targetType, props.initialFormId],
  () => {
    editing.value = null;
  },
);
const answerSaved = async (object: MapObjectData | ShapeData) => {
  const fromDetail = !!detail.value,
    answerId = editing.value?.id,
    answerKind = editing.value?.target_type;
  editing.value = null;
  window.dispatchEvent(new CustomEvent("geocode-answer-updated", { detail: object }));
  if (applied.value) {
    const request = { ...applied.value };
    delete request.as_of;
    applied.value = request;
  }
  cursors.value = [null];
  await search(null, 0, false);
  if (fromDetail)
    detail.value =
      rows.value.find((row) => row.id === answerId && row.target_type === answerKind) || null;
  mapOpen.value = false;
  message.value = "回答を更新しました。";
};
const loading = ref(false);
const optionsLoading = ref(false);
const exporting = ref(false);
const message = ref("");
const applied = ref<Record<string, unknown> | null>(null);
const exportForm = ref<HTMLFormElement | null>(null);
const exportFrame = ref<HTMLIFrameElement | null>(null);
let disposeDownload: (() => void) | undefined;
let exportSequence = 0;
const stopDownload = () => {
  exportSequence++;
  disposeDownload?.();
  disposeDownload = undefined;
};
onBeforeUnmount(stopDownload);
const exportQuery = ref("");
const mapOpen = ref(false);
const mapQuery = ref<Record<string, unknown> | null>(null);
const openMap = () => {
  if (busy.value || !applied.value || !total.value) return;
  mapQuery.value = { ...applied.value, cursor: null };
  mapOpen.value = true;
};
const downloadFrame = `answers-${Math.random().toString(36).slice(2)}`;
let initialising = false;
let searchSequence = 0;
let optionsSequence = 0;
const busy = computed(() => loading.value || optionsLoading.value || exporting.value);
const fieldKey = (field: Field) => `${field.id}|${field.field_type}`;
const visibleFields = computed(() =>
  resultFields.value.filter((field) => displayFields.value.includes(fieldKey(field))),
);
const scoped = computed(() => !!target.value || (!!form.value && form.value !== "individual"));
const apiUrl = (path: string) =>
  new URL(path, new URL(baseUrl || window.location.origin, window.location.origin)).href;
const dateLabel = (raw: string) =>
  new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`).toLocaleString();
const typeLabel = (type: string) =>
  ({
    text: "テキスト",
    textarea: "複数行",
    number: "数値",
    date: "日付",
    select: "選択",
    radio: "選択",
    checkbox: "真偽",
    image: "画像",
    unknown: "定義情報なし",
  })[type] || type;
const errorText = (error: unknown, fallback: string) => {
  if (apiClient.isAxiosError(error)) {
    const data = error.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error.replace(/^validation error:\s*/, "");
  }
  return fallback;
};
const scope = () => ({
  common_form_id: form.value && form.value !== "individual" ? form.value : null,
  individual_only: form.value === "individual",
  target_id: target.value || null,
  target_type: kind.value || null,
});

const operatorOptions = (condition: Condition) => {
  const type = options.value.fields.find((field) => fieldKey(field) === condition.key)?.field_type;
  const common = [
    { value: "filled", label: "回答あり" },
    { value: "empty", label: "未入力" },
    { value: "missing", label: "項目なし" },
  ];
  if (type === "number" || type === "date")
    return [
      { value: "eq", label: "等しい" },
      { value: "gte", label: type === "date" ? "以後" : "以上" },
      { value: "lte", label: type === "date" ? "以前" : "以下" },
      { value: "between", label: "範囲" },
      ...common,
    ];
  if (type === "select" || type === "radio")
    return [{ value: "in", label: "選択値のいずれか" }, ...common];
  if (type === "checkbox") return [{ value: "eq", label: "等しい" }, ...common];
  if (type === "image") return common;
  return [{ value: "contains", label: "部分一致" }, { value: "eq", label: "完全一致" }, ...common];
};
const selectedField = (condition: Condition) =>
  options.value.fields.find((field) => fieldKey(field) === condition.key);
const resetCondition = (condition: Condition) => {
  condition.op = operatorOptions(condition)[0]!.value;
  condition.value = selectedField(condition)?.field_type === "checkbox" ? "true" : "";
  condition.upper = "";
  condition.choices = [];
};
const addCondition = () => {
  const first = options.value.fields[0];
  if (!first || conditions.value.length >= 10) return;
  const condition = { key: fieldKey(first), op: "", value: "", upper: "", choices: [] };
  resetCondition(condition);
  conditions.value.push(condition);
};
const buildRequest = () => ({
  ...scope(),
  mode: mode.value,
  version: version.value ? Number(version.value) : null,
  target_name: name.value || null,
  layer_id: layer.value || null,
  from: from.value ? new Date(from.value).toISOString() : null,
  until: until.value ? new Date(until.value).toISOString() : null,
  conditions: conditions.value.map((condition) => {
    const field = selectedField(condition)!;
    return {
      field_id: field.id,
      field_type: field.field_type,
      op: condition.op,
      value:
        field.field_type === "checkbox"
          ? condition.value === "true"
          : condition.op === "in"
            ? condition.choices
            : condition.value,
      upper: condition.upper,
    };
  }),
  limit: 50,
});

const pending = computed(() => {
  if (!applied.value) return false;
  const { as_of: _asOf, ...request } = applied.value;
  return JSON.stringify(buildRequest()) !== JSON.stringify(request);
});
const filterCount = computed(
  () =>
    [
      form.value,
      version.value,
      props.targetId ? "" : kind.value,
      name.value,
      layer.value,
      from.value,
      until.value,
    ].filter(Boolean).length + conditions.value.length,
);
const clearFilters = () => {
  form.value = props.initialFormId || "";
  version.value = "";
  kind.value = props.targetType || "";
  name.value = "";
  layer.value = "";
  from.value = "";
  until.value = "";
  conditions.value = [];
};
const fieldLabel = (field: Field, fields = resultFields.value) => {
  const index = fields.findIndex((item) => fieldKey(item) === fieldKey(field));
  if (field.field_type === "unknown") return `項目名不明の項目 ${index + 1}`;
  const same = fields.filter((item) => item.label === field.label);
  if (same.length < 2) return field.label;
  const number = same.findIndex((item) => fieldKey(item) === fieldKey(field)) + 1;
  return `${field.label}（${typeLabel(field.field_type)}・${number}）`;
};

const search = async (cursor: Cursor | null = null, index = 0, fresh = true) => {
  const sequence = ++searchSequence;
  loading.value = true;
  message.value = "";
  detail.value = null;
  try {
    const request = fresh ? buildRequest() : { ...applied.value };
    const result = (await apiClient.post<Page>("/form-answers/search", { ...request, cursor }))
      .data;
    if (sequence !== searchSequence) return;
    rows.value = result.rows;
    editingSupported.value = result.editing_supported === true;
    if (fresh) {
      const fieldsChanged =
        JSON.stringify(resultFields.value.map(fieldKey)) !==
        JSON.stringify(options.value.fields.map(fieldKey));
      resultFields.value = [...options.value.fields];
      if (fieldsChanged) displayFields.value = resultFields.value.slice(0, 5).map(fieldKey);
    }
    total.value = result.total;
    asOf.value = result.as_of;
    nextCursor.value = result.next_cursor;
    page.value = index;
    applied.value = { ...request, as_of: result.as_of };
    if (fresh) cursors.value = [null];
    else cursors.value[index] = cursor;
  } catch (error) {
    if (sequence === searchSequence) {
      rows.value = [];
      total.value = 0;
      nextCursor.value = null;
      asOf.value = "";
      applied.value = null;
      message.value = errorText(error, "回答を読み込めませんでした。");
    }
  } finally {
    if (sequence === searchSequence) loading.value = false;
  }
};
const loadOptions = async () => {
  const sequence = ++optionsSequence;
  optionsLoading.value = true;
  try {
    const data = (await apiClient.post<Options>("/form-answers/options", scope())).data;
    if (sequence !== optionsSequence) return false;
    options.value = data;
    return true;
  } catch (error) {
    if (sequence === optionsSequence) {
      options.value.fields = [];
      message.value = errorText(error, "検索項目を読み込めませんでした。");
    }
    return false;
  } finally {
    if (sequence === optionsSequence) optionsLoading.value = false;
  }
};
watch(
  () => props.isOpen,
  async (open) => {
    if (!open) {
      stopDownload();
      exporting.value = false;
      mapOpen.value = false;
      searchSequence++;
      optionsSequence++;
      loading.value = false;
      optionsLoading.value = false;
      detail.value = null;
      return;
    }
    initialising = true;
    filtersOpen.value = false;
    usageHelpOpen.value = false;
    mapHelpOpen.value = false;
    mode.value = "history";
    form.value = props.initialFormId || "";
    version.value = "";
    kind.value = props.targetType || "";
    target.value = props.targetId || "";
    name.value = "";
    layer.value = "";
    from.value = "";
    until.value = "";
    conditions.value = [];
    message.value = "";
    rows.value = [];
    resultFields.value = [];
    applied.value = null;
    total.value = 0;
    const success = await loadOptions();
    initialising = false;
    if (success && props.isOpen) await search();
  },
  { immediate: true },
);
watch([form, target, kind], async () => {
  if (!props.isOpen || initialising) return;
  conditions.value = [];
  version.value = "";
  await loadOptions();
});

const exportCsv = async () => {
  if (!applied.value || busy.value) return;
  exporting.value = true;
  stopDownload();
  const sequence = exportSequence;
  message.value = "";
  try {
    const request = { ...applied.value, cursor: null };
    await apiClient.post("/form-answers/csv-check", request);
    if (!props.isOpen || sequence !== exportSequence) return;
    exportQuery.value = JSON.stringify(request);
    // ネイティブのダウンロードに任せ、ブラウザ内に全CSVを蓄積しない。
    const input = exportForm.value?.querySelector<HTMLInputElement>('input[name="query"]');
    if (input) input.value = exportQuery.value;
    if (!exportForm.value || !exportFrame.value) throw new Error("Download frame unavailable");
    disposeDownload = submitAuthenticatedForm(exportForm.value, exportFrame.value, (error) => {
      if (props.isOpen && sequence === exportSequence) message.value = error;
    });
  } catch (error) {
    if (props.isOpen && sequence === exportSequence)
      message.value = errorText(error, "CSVを出力できませんでした。");
  } finally {
    if (sequence === exportSequence) exporting.value = false;
  }
};
const exists = (row: Answer, field: Field) =>
  row.form_snapshot
    ? row.form_snapshot.form_schema.fields.some(
        (item) => item.id === field.id && item.type === field.field_type,
      )
    : field.field_type === "unknown" &&
      Object.prototype.hasOwnProperty.call(row.submitted_values, field.id);
const formatValue = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? "未入力"
    : typeof value === "boolean"
      ? value
        ? "はい"
        : "いいえ"
      : typeof value === "object" && value && "filename" in value
        ? String(value.filename)
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
const rowFields = (row: Answer): Field[] =>
  row.form_snapshot
    ? row.form_snapshot.form_schema.fields.map((field) => ({
        id: field.id,
        label: field.label,
        field_type: field.type,
        choices: [],
      }))
    : Object.keys(row.submitted_values).map((id) => ({
        id,
        label: id,
        field_type: "unknown",
        choices: [],
      }));
const imageUrl = (row: Answer, field: Field) => {
  if (field.field_type !== "image") return "";
  const value = row.submitted_values[field.id];
  const url = typeof value === "object" && value && "url" in value ? String(value.url) : "";
  return /^\/static\/images\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(url) ? apiUrl(url) : "";
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="24" :closeOnOverlayClick="false" @close="emit('close')">
    <div :inert="!!editing" class="answers-modal">
      <header>
        <h2 class="modal-h2">回答一覧</h2>
        <button class="close-button" @click="emit('close')">閉じる</button>
      </header>
      <div class="answers-scroll">
        <p class="analysis-scope">
          フォームから登録された回答を分析します（内部入力・外部公開フォームの両方）。本文・メモへの直接入力は含みません。
        </p>
        <div class="list-toolbar">
          <label
            >表示モード<select v-model="mode" :disabled="busy">
              <option value="history">すべての回答</option>
              <option value="latest">対象ごとの最新回答</option>
            </select></label
          >
          <div class="toolbar-actions">
            <button type="button" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
              絞り込み{{ filterCount ? `（${filterCount}）` : "" }}
            </button>
            <button type="button" :disabled="busy" @click="search()">
              {{ pending ? "変更を反映" : "更新" }}
            </button>
          </div>
          <div class="result-actions">
            <strong>{{ total }}件</strong>
            <span class="result-action">
              <button :disabled="busy || !applied" @click="exportCsv">CSV出力</button>
              <button
                type="button"
                class="help-button"
                aria-label="一覧とCSVについて"
                :aria-expanded="usageHelpOpen"
                @click="usageHelpOpen = !usageHelpOpen"
              >
                ?
              </button>
            </span>
            <span class="result-action">
              <button :disabled="busy || !applied || !total" @click="openMap">地図で確認</button>
              <button
                type="button"
                class="help-button"
                aria-label="地図で確認について"
                :aria-expanded="mapHelpOpen"
                @click="mapHelpOpen = !mapHelpOpen"
              >
                ?
              </button>
            </span>
          </div>
        </div>
        <p v-if="target" class="scope-note">
          この対象の回答を表示しています：{{ rows[0]?.target_name || "選択中の地図オブジェクト" }}
        </p>
        <p v-if="pending" role="status">
          条件が変更されています。「絞り込む」または「変更を反映」で一覧に反映します。
        </p>
        <form v-show="filtersOpen" class="search-form" @submit.prevent="search()">
          <fieldset :disabled="busy">
            <div class="search-grid">
              <label
                >共通フォーム<select v-model="form">
                  <option value="">すべて</option>
                  <option value="individual">個別フォームのみ</option>
                  <option v-for="item in options.forms" :key="item.id" :value="item.id">
                    {{ item.name }}{{ item.deleted ? "（削除済み）" : "" }}
                  </option>
                </select></label
              >
              <label
                >対象名<input v-model="name" type="text" maxlength="100" placeholder="部分一致"
              /></label>
              <label>回答日時・開始<input v-model="from" type="datetime-local" /></label>
              <label>回答日時・終了<input v-model="until" type="datetime-local" /></label>
            </div>
            <details class="advanced-filters">
              <summary>詳しい条件</summary>
              <div class="search-grid">
                <label
                  >適用元の版<select v-model="version" :disabled="!form || form === 'individual'">
                    <option value="">すべて</option>
                    <option v-for="item in options.versions" :key="item" :value="String(item)">
                      第{{ item }}版
                    </option>
                  </select></label
                >
                <label
                  >対象種別<select v-model="kind" :disabled="!!target">
                    <option value="">すべて</option>
                    <option value="marker">マーカー</option>
                    <option value="shape">図形</option>
                  </select></label
                >
                <label
                  >レイヤ<select v-model="layer">
                    <option value="">すべて</option>
                    <option v-for="item in options.layers" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select></label
                >
              </div>
            </details>
            <div class="condition-heading">
              <strong>回答条件（すべてに一致）</strong>
            </div>
            <p v-if="!scoped">回答内容で絞り込むには、共通フォームを選んでください。</p>
            <div v-for="(condition, index) in conditions" :key="index" class="condition-row">
              <label
                >項目<select v-model="condition.key" @change="resetCondition(condition)">
                  <option
                    v-for="field in options.fields"
                    :key="fieldKey(field)"
                    :value="fieldKey(field)"
                  >
                    {{ fieldLabel(field, options.fields) }}
                  </option>
                </select></label
              >
              <label
                >条件<select v-model="condition.op">
                  <option
                    v-for="op in operatorOptions(condition)"
                    :key="op.value"
                    :value="op.value"
                  >
                    {{ op.label }}
                  </option>
                </select></label
              >
              <template v-if="!['filled', 'empty', 'missing'].includes(condition.op)">
                <fieldset v-if="condition.op === 'in'" class="choice-options">
                  <legend>一致させる選択肢（複数可）</legend>
                  <label v-for="choice in selectedField(condition)?.choices || []" :key="choice">
                    <input v-model="condition.choices" type="checkbox" :value="choice" />{{
                      choice
                    }}
                  </label>
                </fieldset>
                <label v-else-if="selectedField(condition)?.field_type === 'checkbox'"
                  >値<select v-model="condition.value">
                    <option value="true">はい</option>
                    <option value="false">いいえ</option>
                  </select></label
                >
                <label v-else
                  >値<input
                    :value="condition.value"
                    @input="condition.value = ($event.target as HTMLInputElement).value"
                    :type="
                      selectedField(condition)?.field_type === 'date'
                        ? 'date'
                        : selectedField(condition)?.field_type === 'number'
                          ? 'number'
                          : 'text'
                    "
                    step="any"
                    required
                    maxlength="5000"
                /></label>
                <label v-if="condition.op === 'between'"
                  >上限<input
                    :value="condition.upper"
                    @input="condition.upper = ($event.target as HTMLInputElement).value"
                    :type="selectedField(condition)?.field_type === 'date' ? 'date' : 'number'"
                    step="any"
                    required
                /></label>
              </template>
              <button type="button" @click="conditions.splice(index, 1)">条件を削除</button>
            </div>
            <div class="filter-actions">
              <button
                type="button"
                :disabled="!scoped || !options.fields.length || conditions.length >= 10"
                @click="addCondition"
              >
                条件を追加
              </button>
              <button type="button" @click="clearFilters">条件をクリア</button>
              <button type="submit">{{ loading ? "検索中…" : "絞り込む" }}</button>
            </div>
          </fieldset>
        </form>
        <p v-if="message" role="status">{{ message }}</p>
        <div v-if="mapHelpOpen" class="usage-help">
          <p>
            一覧の全ページの該当対象を地図に表示します（重複を除き最大10,000件）。位置・名前などは現在の情報です。
          </p>
          <p>
            共通フォームの回答は、地図内でも回答値で絞り込めます。個別フォームの回答条件は、一覧で指定してください。名前検索・レイヤ切替はどちらも利用できます。
          </p>
        </div>
        <div v-if="usageHelpOpen" class="usage-help">
          <p>
            「対象ごとの最新回答」は、対象・フォームごとの最新1件を選んでから条件で絞り込みます。
          </p>
          <p>
            CSVは一覧に反映済みの条件で全ページを出力します（最大10,000件）。対象名・レイヤ名は現在の情報です。
          </p>
          <p v-if="asOf">検索基準：{{ dateLabel(asOf) }}</p>
        </div>
        <details v-if="resultFields.length">
          <summary>表示する項目</summary>
          <div class="column-options">
            <label v-for="field in resultFields" :key="fieldKey(field)"
              ><input v-model="displayFields" type="checkbox" :value="fieldKey(field)" />{{
                fieldLabel(field)
              }}</label
            >
          </div>
        </details>
        <p v-if="loading">回答を読み込んでいます…</p>
        <p v-else-if="!rows.length">該当する回答はありません。</p>
        <div v-if="rows.length" class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>投稿日時</th>
                <th>対象</th>
                <th>フォーム</th>
                <th v-for="field in visibleFields" :key="fieldKey(field)">
                  {{ fieldLabel(field) }}
                </th>
                <th>詳細</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="`${row.target_type}-${row.id}`">
                <td data-label="投稿日時">{{ dateLabel(row.create_at) }}</td>
                <td data-label="対象">
                  {{ row.target_type === "marker" ? "マーカー" : "図形" }}：{{ row.target_name
                  }}<small>{{ row.layer_name || "レイヤなし" }}</small>
                </td>
                <td data-label="フォーム">
                  {{ row.common_form_name || row.form_snapshot?.form_title || "個別フォーム"
                  }}{{ row.common_form_deleted ? "（削除済み）" : ""
                  }}<small v-if="row.source_form">適用元：第{{ row.source_form.version }}版</small
                  ><small v-if="!row.form_snapshot">投稿時の定義情報なし</small>
                </td>
                <td
                  v-for="field in visibleFields"
                  :key="fieldKey(field)"
                  :data-label="fieldLabel(field)"
                  class="answer-value"
                >
                  {{
                    exists(row, field) ? formatValue(row.submitted_values[field.id]) : "項目なし"
                  }}
                </td>
                <td>
                  <div class="row-actions">
                    <button @click="detail = row">詳細を見る</button>
                    <button
                      v-if="editingSupported"
                      :disabled="!canEdit(row)"
                      :title="
                        row.form_snapshot
                          ? '回答を編集'
                          : '投稿時のフォーム定義がないため編集できません'
                      "
                      @click="editing = row"
                    >
                      編集
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav v-if="rows.length" class="pagination" aria-label="回答のページ">
          <button
            :disabled="busy || !applied || page === 0"
            @click="search(cursors[page - 1], page - 1, false)"
          >
            前へ</button
          ><span>{{ page + 1 }}ページ</span
          ><button
            :disabled="busy || !applied || !nextCursor"
            @click="search(nextCursor, page + 1, false)"
          >
            次へ
          </button>
        </nav>
      </div>
    </div>
  </BaseModal>
  <BaseModal :isOpen="isOpen && !!detail" :zIndex="26" @close="detail = null">
    <div v-if="detail" :inert="!!editing" class="answer-detail">
      <header>
        <h2 class="modal-h2">回答の詳細</h2>
        <button class="close-button" @click="detail = null">閉じる</button>
        <button v-if="editingSupported" :disabled="!canEdit(detail)" @click="editing = detail">
          回答を編集
        </button>
      </header>
      <div class="answer-detail-scroll">
        <p>{{ detail.target_name }} / {{ dateLabel(detail.create_at) }}</p>
        <p v-if="detail.edited_at">編集日時：{{ dateLabel(detail.edited_at) }}</p>
        <details class="management-info">
          <summary>管理用情報</summary>
          <p>対象ID：{{ detail.target_id }}</p>
          <p>回答ID：{{ detail.id }}</p>
          <ul>
            <li v-for="field in rowFields(detail)" :key="field.id">
              {{ fieldLabel(field, rowFields(detail)) }}：{{ field.id }}
            </li>
          </ul>
        </details>
        <h3>{{ detail.form_snapshot?.form_title || "投稿時の定義情報なし" }}</h3>
        <p class="preserve-lines">{{ detail.form_snapshot?.form_description }}</p>
        <dl>
          <template v-for="field in rowFields(detail)" :key="field.id"
            ><dt>
              {{ fieldLabel(field, rowFields(detail)) }}
            </dt>
            <dd>
              <a
                v-if="imageUrl(detail, field)"
                :href="imageUrl(detail, field)"
                target="_blank"
                rel="noopener noreferrer"
                ><img :src="imageUrl(detail, field)" :alt="field.label" loading="lazy" /></a
              ><span v-else class="preserve-lines">{{
                formatValue(detail.submitted_values[field.id])
              }}</span>
            </dd></template
          >
        </dl>
      </div>
    </div>
  </BaseModal>
  <MapObjectFormInputModal
    v-if="editing"
    :isOpen="isOpen && !!editing"
    :targetType="editing.target_type"
    :targetId="editing.target_id"
    :answerId="editing.id"
    @close="editing = null"
    @saved="answerSaved"
  />
  <iframe ref="exportFrame" :name="downloadFrame" title="回答CSVダウンロード" hidden />
  <AnswerMapModal
    :printEnabled="true"
    :isOpen="isOpen && mapOpen"
    :query="mapQuery"
    :action="apiUrl('/form-answers/map')"
    @close="mapOpen = false"
  />
  <form
    ref="exportForm"
    :action="apiUrl('/form-answers/download')"
    :target="downloadFrame"
    method="post"
    hidden
  >
    <input name="query" type="hidden" :value="exportQuery" />
  </form>
</template>

<style scoped>
.answers-modal {
  position: relative;
  box-sizing: border-box;
  width: min(1200px, calc(100vw - 64px));
  height: min(86dvh, 1000px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: #172033;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
h2 {
  margin: 8px 0 12px;
}
.analysis-scope {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-left: 3px solid #7890b6;
  background: #edf4ff;
  color: #334155;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.answers-scroll {
  overflow: auto;
  min-height: 0;
  overscroll-behavior: contain;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.search-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
input,
select {
  font: inherit;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid #aeb9c8;
  border-radius: 6px;
  background: white;
  color: #172033;
}
button {
  border: 1px solid #aeb9c8;
  border-radius: 8px;
  padding: 8px 12px;
  background: white;
  color: #172033;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.close-button {
  background: #5f5f5f;
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 2px #0003;
}
.condition-heading,
.pagination {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 16px 0;
}
.pagination {
  justify-content: center;
}
.condition-row {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
  border-bottom: 1px solid #ccd5e1;
  padding-bottom: 12px;
}
.condition-row > label {
  flex: 1 1 150px;
}
.column-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
  max-height: 160px;
  overflow: auto;
}
.column-options label {
  flex-direction: row;
  align-items: center;
}
.table-scroll {
  overflow: auto;
  margin-top: 12px;
}
table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
  min-width: max(100%, 720px);
  font-size: 14px;
}
th,
td {
  border: 1px solid #ccc;
  padding: 6px 13px;
  text-align: left;
  min-width: 120px;
  max-width: 300px;
  overflow-wrap: anywhere;
  vertical-align: top;
  white-space: pre-wrap;
}
th {
  background: rgb(44, 52, 78);
  color: whitesmoke;
}
tbody tr {
  background: #fff;
}
tbody tr:nth-child(2n) {
  background: #eee;
}
tbody tr:hover {
  background: #69a5b8;
}
small {
  display: block;
  color: #5c6778;
  margin-top: 4px;
  font-size: 12px;
}
.answer-detail {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100vw - 64px));
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  max-height: 80dvh;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.answer-detail header {
  display: block;
  min-width: 0;
}
.answer-detail .modal-h2 {
  width: auto;
  min-width: 0;
}
.answer-detail .close-button {
  position: absolute;
  top: 0;
  right: 0;
  margin: 0;
  z-index: 2;
  flex-shrink: 0;
}
.answers-modal > header {
  display: block;
}
.answers-modal > header .close-button {
  position: absolute;
  top: 0;
  right: 0;
  margin: 0;
  z-index: 2;
}
.answer-detail :is(p, h3, dl, dt, dd, ul, li, .preserve-lines) {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.answer-detail-scroll {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.answer-detail img {
  max-width: 100%;
  max-height: 400px;
}
dt {
  font-weight: bold;
  margin-top: 16px;
}
dd {
  margin: 8px 0;
}
.preserve-lines {
  white-space: pre-wrap;
}
@media (max-width: 700px) {
  .search-grid {
    grid-template-columns: 1fr;
  }
  table,
  tbody,
  tr,
  td {
    display: block;
    width: auto;
  }
  table {
    min-width: 0;
  }
  thead {
    display: none;
  }
  tr {
    border: 1px solid #ccd5e1;
    border-radius: 8px;
    margin-bottom: 12px;
    padding: 8px;
  }
  td {
    border: 0;
    min-width: 0;
    max-width: none;
    padding: 6px;
  }
  td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-weight: bold;
    color: #5c6778;
    margin-bottom: 4px;
  }
  .condition-row > label {
    flex-basis: 100%;
  }
}

.filter-actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 12px;
}
.filter-actions > button {
  flex: 0 1 auto;
  min-width: 0;
}
.list-toolbar {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin: 8px 0 16px;
}
.list-toolbar > label {
  flex: 0 1 auto;
  max-width: 100%;
}
.list-toolbar button {
  white-space: nowrap;
}
.toolbar-actions,
.result-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.result-actions strong {
  white-space: nowrap;
}
.result-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
}
.search-form {
  background: #eef1f5;
  padding: 16px;
  border-radius: 8px;
}
.advanced-filters {
  margin: 12px 0;
}
summary {
  cursor: pointer;
  padding: 8px 0;
}
.advanced-filters .search-grid {
  margin-top: 12px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.scope-note {
  font-size: 13px;
  color: #5c6778;
}
.choice-options {
  flex: 1 1 200px;
  max-height: 180px;
  overflow: auto;
}
.choice-options label {
  flex-direction: row;
  align-items: center;
  padding: 6px 0;
}
.answer-value {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}
.row-actions > button {
  flex: 0 0 auto;
  white-space: nowrap;
}
.table-scroll {
  max-height: 48dvh;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
}
.modal-h2 {
  flex: 1;
  text-align: center;
  border-bottom: 2px solid #acacac;
  padding-bottom: 10px;
}
button {
  background: #5f5f5f;
  color: #fff;
  border-color: transparent;
}
.help-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: 0;
  padding: 0;
  border: 1px solid #5f5f5f;
  border-radius: 50%;
  background: #fff;
  color: #333;
  font-size: 13px;
  flex-shrink: 0;
}
.help-button:focus-visible {
  outline: 2px solid #396cd8;
  outline-offset: 2px;
}
.usage-help {
  margin: 12px 0;
  padding: 12px;
  border-radius: 8px;
  background: #eef1f5;
}
@media (min-width: 701px) and (max-width: 1000px) {
  .search-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .filter-actions {
    gap: 6px;
  }
  .filter-actions > button {
    flex: 1 1 0;
    padding: 8px 4px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .advanced-filters .search-grid {
    grid-template-columns: 1fr;
  }
  .list-toolbar,
  .toolbar-actions,
  .result-actions {
    gap: 8px;
  }
  .search-form {
    padding: 12px;
  }
  .table-scroll {
    max-height: none;
    overflow: visible;
  }
  td.answer-value {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  td.answer-value:nth-of-type(n + 7) {
    display: none;
  }
  button:not(.help-button),
  summary {
    min-height: 40px;
  }
}
</style>
