<script setup lang="ts">
import {
  classifyMapTargets,
  mapOperationMessages,
} from "../../../../template-scripts/src/map/common/map-analysis";
import {
  createAiConditionEditor,
  validateAiDefinitionFields,
} from "../../../../template-scripts/src/map/common/ai-condition-editor";
import { answerMapPresetInputs } from "../../../../template-scripts/src/map/common/answer-map-preset-inputs";
import {
  LocalPresetData,
  presetReferences,
} from "../../../../template-scripts/src/map/common/local-preset";
import {
  prepareAnswerPresetPage,
  type AnswerPresetPage,
} from "../../../../template-scripts/src/map/common/answer-preset-page";
import { PresetPageReads } from "../../../../template-scripts/src/map/common/preset-page-reads";
import { awaitWithAbort } from "../../../../template-scripts/src/map/common/progress-spinner";
import { readAnswerPresetScope } from "../../../../template-scripts/src/map/common/answer-preset-scope";
import { observeAiSuggestionDataChanges } from "../../../../template-scripts/src/ai/suggestion-events";
import type { AiDefinition } from "../../../../template-scripts/src/ai/types";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  triggerRef,
  watch,
} from "vue";
import apiClient from "@/axiosClient";
import { submitAuthenticatedForm } from "@/utils/authenticated-form";
import { requestCurrentMapView } from "@/utils/map-view";
import { PRINT_REQUEST_TIMEOUT_MS } from "../../../../template-scripts/src/map/common/map-timeouts";
import PrintMapModal from "../map/PrintMapModal.vue";
import ProgressSpinner from "../common/ProgressSpinner.vue";
import MessageModal from "../common/MessageModal.vue";
import AnswerColoringPanel from "./AnswerColoringPanel.vue";
import SaveMapPresetModal from "./SaveMapPresetModal.vue";
import SavedMapPresetsModal from "./SavedMapPresetsModal.vue";
import {
  toV2PresetDraft,
  deserializePresetConditions,
  type V2MapPresetDraft,
  type SavedMapPreset,
} from "@/utils/answer-map-presets";
import {
  createColorRuleRequest,
  serializeAnswerConditions,
  validateColorTargets,
  type AnswerColorSpecification,
  type AnswerColoring,
} from "@/utils/answer-coloring";

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  isOpen: boolean;
  query: Record<string, unknown> | null;
  action: string;
  printEnabled?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const printSnapshot = shallowRef<Record<string, unknown> | null>(null);
const preparingPrint = ref(false);
let printRequest = "";
let printTimer: ReturnType<typeof setTimeout> | undefined;
const printAction = computed(() => {
  const url = new URL(props.action, location.href);
  url.pathname = url.pathname.replace(/\/map\/?$/, "/map-print");
  url.search = "";
  return url.href;
});
interface Field {
  id: string;
  label: string;
  field_type: string;
  choices: string[];
}
interface Row {
  id: number;
  key: string;
  op: string;
  value: string;
  upper: string;
  selected: string[];
}
interface Result {
  forms: { id: string; label: string }[];
  forms_overflow: boolean;
  fields: Field[];
  targets: string[];
  target_count: number;
  answer_count: number;
}
const frame = ref<HTMLIFrameElement | null>(null),
  form = ref<HTMLFormElement | null>(null);
const frameName = `answer-map-${Math.random().toString(36).slice(2)}`;
const filtersOpen = ref(true);
const completionMessage = ref("");
const completionModal = ref<InstanceType<typeof MessageModal> | null>(null);
let completionFocus: HTMLElement | null = null;
const closeCompletion = async () => {
  completionMessage.value = "";
  await nextTick();
  if (completionFocus?.isConnected) completionFocus.focus();
};
watch(completionMessage, async (message) => {
  if (!message) return;
  await nextTick();
  completionModal.value?.$el.querySelector("button")?.focus();
});
const filtersPanelId = `${frameName}-filters`;
const parentOrigin = window.location.origin;
const requestId = ref("");
const initialView = ref("");
let viewController: AbortController | undefined;
const loading = ref(false),
  error = ref(""),
  filterError = ref(""),
  busy = ref(false),
  scopeReady = ref(false);
const optionsOnlyPhase = ref(true);
const updatingMap = computed(() => props.isOpen && busy.value && !optionsOnlyPhase.value);
const initialCount = ref(0),
  matchedCount = ref(0),
  visibleCount = ref(0),
  renderableCount = ref(0),
  answerCount = ref(0);
const forms = ref<Result["forms"]>([]),
  fields = ref<Field[]>([]),
  selectedForm = ref(""),
  rows = ref<Row[]>([]);
const overflow = ref(false),
  applied = ref("一覧と同じ範囲");
const baseQuery = ref<Record<string, unknown>>({}),
  initialTargets = ref<string[]>([]);
const summary = computed(
  () =>
    `初期対象${initialCount.value.toLocaleString()}件／一致${matchedCount.value.toLocaleString()}件／表示中${visibleCount.value.toLocaleString()}件`,
);
const skipped = computed(() => Math.max(0, matchedCount.value - renderableCount.value));
let epoch = 0,
  sequence = 0,
  nextId = 0;
let timeout: ReturnType<typeof setTimeout> | undefined,
  ackTimeout: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
interface AppliedMapFilter {
  expression?: unknown;
  common_form_id: string | null;
  conditions: Record<string, unknown>[];
}
let pending:
  | {
      id: string;
      result: Result;
      summary: string;
      filter: AppliedMapFilter;
      colorSpecification: AnswerColorSpecification | null;
      coloring: AnswerColoring | null;
      completion: keyof typeof mapOperationMessages | null;
      fromPreset: boolean;
    }
  | undefined;
let appliedId = "";
let appliedFilter: AppliedMapFilter = { common_form_id: null, conditions: [] };
let appliedResult: Result | undefined;
let appliedColorSpecification: AnswerColorSpecification | null = null;
let appliedColoring: AnswerColoring | null = null;
const coloringActive = ref(false),
  appliedForm = ref(""),
  preserveColorDraftAfterPreset = ref(false);
const colorFormConstraint = computed(() =>
  typeof baseQuery.value.common_form_id === "string"
    ? baseQuery.value.common_form_id
    : appliedForm.value,
);
const coloringPanel = ref<InstanceType<typeof AnswerColoringPanel> | null>(null);
const filterPanel = ref<HTMLDetailsElement | null>(null);
const presetDraft = shallowRef<V2MapPresetDraft | null>(null);
const expressionHost = ref<HTMLDivElement | null>(null);
const expressionDraft = shallowRef<{
  name: string;
  editor: ReturnType<typeof createAiConditionEditor>;
} | null>(null);
const clearExpressionDraft = () => {
  expressionDraft.value?.editor.dispose();
  expressionDraft.value = null;
};
const presetsOpen = ref(false),
  restoringPreset = ref(false),
  presetRestoreError = ref(""),
  applyingPreset = ref(false),
  presetApplyError = ref(""),
  presetApplyComplete = ref(""),
  presetNotice = ref("");
const presetModalOpen = computed(() => presetDraft.value !== null || presetsOpen.value);
const childModalOpen = computed(() => presetModalOpen.value || !!completionMessage.value);
let presetSequence = 0,
  presetController: AbortController | undefined;
const closePresets = () => {
  clearPresetPage();
  presetSequence++;
  presetController?.abort();
  if (pending?.fromPreset) {
    clearTimeout(ackTimeout);
    pending = undefined;
    busy.value = false;
  }
  presetsOpen.value = false;
  restoringPreset.value = false;
  presetRestoreError.value = "";
  applyingPreset.value = false;
  presetApplyError.value = "";
  presetApplyComplete.value = "";
};
const stopPresets = () => {
  closePresets();
  presetDraft.value = null;
  presetNotice.value = "";
};
const csvPreparing = ref(false),
  csvQuery = ref("");
const csvForm = ref<HTMLFormElement | null>(null),
  csvFrame = ref<HTMLIFrameElement | null>(null);
const csvFrameName = `${frameName}-csv`;
let csvSequence = 0,
  csvController: AbortController | undefined,
  disposeCsv: (() => void) | undefined;
let csvTimer: ReturnType<typeof setTimeout> | undefined;
let csvCapture: { id: string; updateId: string; request: Record<string, unknown> } | undefined;
const stopCsv = () => {
  csvSequence++;
  csvController?.abort();
  disposeCsv?.();
  disposeCsv = undefined;
  csvCapture = undefined;
  clearTimeout(csvTimer);
  csvPreparing.value = false;
};
const fieldKey = (f: Field) => `${f.id}:${f.field_type}`;
const selected = (row: Row) => fields.value.find((f) => fieldKey(f) === row.key);
const noValue = (row: Row) => ["empty", "filled", "missing"].includes(row.op);
const operations = (row: Row) => {
  const kind = selected(row)?.field_type;
  const values =
    kind === "number" || kind === "date"
      ? [
          { value: "eq", label: kind === "date" ? "指定日" : "等しい" },
          { value: "gte", label: kind === "date" ? "以降" : "以上" },
          { value: "lte", label: kind === "date" ? "以前" : "以下" },
          { value: "between", label: kind === "date" ? "期間内" : "範囲内" },
        ]
      : kind === "select" || kind === "radio"
        ? [{ value: "in", label: "いずれか" }]
        : kind === "checkbox"
          ? [{ value: "eq", label: "等しい" }]
          : [
              { value: "contains", label: "含む" },
              { value: "eq", label: "等しい" },
            ];
  return [
    ...values,
    { value: "filled", label: "入力あり" },
    { value: "empty", label: "未入力" },
    { value: "missing", label: "項目なし" },
  ];
};
const resetRow = (row: Row) => {
  const kind = selected(row)?.field_type;
  row.op =
    kind === "number" || kind === "date"
      ? "gte"
      : kind === "select" || kind === "radio"
        ? "in"
        : kind === "checkbox"
          ? "eq"
          : "contains";
  row.value = kind === "checkbox" ? "true" : "";
  row.upper = "";
  row.selected = [];
};
const addRow = () => {
  if (!fields.value.length || rows.value.length >= 10) return;
  const row: Row = {
    id: ++nextId,
    key: fieldKey(fields.value[0]!),
    op: "",
    value: "",
    upper: "",
    selected: [],
  };
  resetRow(row);
  rows.value.push(row);
};
const endpoint = computed(() => {
  const u = new URL(props.action, window.location.href);
  u.pathname = u.pathname.replace(/\/map\/?$/, "/map-filter");
  u.search = "";
  return u.href;
});
let disposeNativeRequest: (() => void) | undefined;
const csvAction = computed(() => endpoint.value.replace(/\/map-filter$/, "/map-csv-download"));
const csvCheckAction = computed(() => endpoint.value.replace(/\/map-filter$/, "/map-csv-check"));
const presetEndpoint = computed(() => endpoint.value.replace(/\/map-filter$/, "/map-presets"));
const localPresets = ref(false);
const preparingData = ref(false);
const preparationError = ref("");
const scopeChanged = ref(false);
const presetOptions = new Map<string, Result>();
const optionReads = new PresetPageReads<Result>();
let scopeAccountId = "";
let optionsGeneration = 0;
let refreshFields = false;
let stopFormUpdates: (() => void) | undefined;
let presetData: LocalPresetData | undefined;
const scopeReads = new PresetPageReads<LocalPresetData>();
type PreparedPage = AnswerPresetPage<Result>;
let presetPage: PreparedPage | undefined;
let draftPage: PreparedPage | undefined;
const pageFailures = shallowRef<Set<string>>(new Set());
const clearPresetPage = () => {
  presetPage?.optionsJob.abort();
  if (presetPage !== draftPage) presetPage?.job.abort();
  presetPage = undefined;
  pageFailures.value = new Set();
};
const releaseDraftPage = () => {
  if (draftPage !== presetPage) draftPage?.job.abort();
  draftPage = undefined;
};
let editPreparation: AbortController | undefined;
const stopPreparation = () => {
  editPreparation?.abort();
  editPreparation = undefined;
  preparingData.value = false;
  preparationError.value = "";
};
const filterDefinition = (filter: AppliedMapFilter): AiDefinition => ({
  type: "filter",
  expression:
    filter.expression ??
    (filter.common_form_id
      ? { op: "attribute", common_form_id: filter.common_form_id, conditions: filter.conditions }
      : { op: "all" }),
});
const colorDefinition = (color: AnswerColorSpecification): AiDefinition => ({
  type: "color",
  ...color,
});
const appliedDefinitions = () => [
  filterDefinition(appliedFilter),
  ...(appliedColorSpecification ? [colorDefinition(appliedColorSpecification)] : []),
];
const filterDraftDefinition = () =>
  expressionDraft.value?.editor.getDraftDefinition() ??
  filterDefinition({
    common_form_id: selectedForm.value || null,
    conditions: rows.value.flatMap((row) => {
      const field = selected(row);
      return field ? [{ field_id: field.id, field_type: field.field_type }] : [];
    }),
  });
const draftDefinitions = () => {
  const color = coloringPanel.value?.getDraft();
  return [
    filterDraftDefinition(),
    ...(color?.common_form_id && color.rules.length ? [colorDefinition(color)] : []),
    ...appliedDefinitions(),
  ];
};
const loadPresetScope = async (signal: AbortSignal) => {
  const currentFrame = frame.value?.contentWindow;
  if (!currentFrame) throw Error("地図の読み込み完了後に再試行してください。");
  const targets = await readAnswerPresetScope(
    currentFrame,
    new URL(props.action, location.href).origin,
    requestId.value,
    new Set(initialTargets.value),
    signal,
  );
  signal.throwIfAborted();
  return new LocalPresetData(
    async (path, body, requestSignal) =>
      (
        await apiClient.post(
          new URL(path.slice(path.lastIndexOf("/") + 1), `${presetEndpoint.value}/`).href,
          body,
          {
            signal: requestSignal,
            timeout: 60000,
          },
        )
      ).data,
    { query: { ...baseQuery.value } },
    targets,
  );
};
const prepareData = async (definitions: AiDefinition[], signal: AbortSignal) => {
  if (!presetData) {
    const data = await scopeReads.get(requestId.value, signal, loadPresetScope);
    signal.throwIfAborted();
    presetData = data;
  }
  await presetData.prepare(definitions, signal);
};
const prepareEdits = async () => {
  if (!localPresets.value || restoringPreset.value || applyingPreset.value || editPreparation)
    return;
  let definitions = draftDefinitions();
  if (!refreshFields && presetData?.ready(definitions)) {
    preparationError.value = "";
    return;
  }
  const job = new AbortController();
  editPreparation = job;
  preparingData.value = true;
  preparationError.value = "";
  try {
    if (refreshFields) {
      const data = await readPresetOptions(selectedForm.value || null, job.signal);
      job.signal.throwIfAborted();
      meta(data);
      await expressionDraft.value?.editor.refreshMetadata(job.signal);
      const colorForm = coloringPanel.value?.getDraft()?.common_form_id;
      if (colorForm) {
        const color = await readPresetOptions(colorForm, job.signal);
        job.signal.throwIfAborted();
        coloringPanel.value?.setFields(colorForm, color.fields);
      }
      job.signal.throwIfAborted();
      refreshFields = false;
      definitions = draftDefinitions();
    }
    do {
      await prepareData(definitions, job.signal);
      job.signal.throwIfAborted();
      definitions = draftDefinitions();
    } while (!presetData?.ready(definitions));
  } catch (cause) {
    if (!job.signal.aborted)
      preparationError.value = messageError(cause, "判定用データを取得できませんでした。");
  } finally {
    if (editPreparation === job) {
      editPreparation = undefined;
      preparingData.value = false;
    }
  }
};
watch(
  () => [selectedForm.value, ...rows.value.map((row) => row.key)],
  () => void prepareEdits(),
);
const stop = () => {
  stopPreparation();
  releaseDraftPage();
  clearPresetPage();
  scopeReads.clear();
  presetData = undefined;
  localPresets.value = false;
  scopeChanged.value = false;
  presetOptions.clear();
  optionReads.clear();
  scopeAccountId = "";
  optionsGeneration++;
  refreshFields = false;
  viewController?.abort();
  completionMessage.value = "";
  completionFocus = null;
  stopPresets();
  clearExpressionDraft();
  stopCsv();
  printSnapshot.value = null;
  preparingPrint.value = false;
  printRequest = "";
  clearTimeout(printTimer);
  disposeNativeRequest?.();
  disposeNativeRequest = undefined;
  controller?.abort();
  clearTimeout(timeout);
  clearTimeout(ackTimeout);
  pending = undefined;
  busy.value = false;
  sequence++;
};
const submit = async () => {
  if (!props.isOpen || !props.query) return;
  stop();
  const current = ++epoch;
  appliedResult = undefined;
  scopeReady.value = false;
  loading.value = true;
  error.value = "";
  filterError.value = "";
  busy.value = false;
  requestId.value = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  initialView.value = "";
  viewController = new AbortController();
  const view = await requestCurrentMapView(viewController.signal);
  if (!props.isOpen || current !== epoch) return;
  initialView.value = view ? JSON.stringify(view) : "";
  await nextTick();
  if (!props.isOpen || current !== epoch) return;
  try {
    if (!form.value || !frame.value) throw new Error("Map frame unavailable");
    disposeNativeRequest = submitAuthenticatedForm(form.value, frame.value, (message) => {
      clearTimeout(timeout);
      loading.value = false;
      error.value = message;
    });
  } catch {
    loading.value = false;
    error.value = "地図を読み込めませんでした。再試行してください。";
    return;
  }
  timeout = setTimeout(() => {
    disposeNativeRequest?.();
    loading.value = false;
    error.value = "地図を読み込めませんでした。再試行してください。";
  }, 60000);
};
const meta = (data: Result) => {
  forms.value = data.forms;
  fields.value = data.fields;
  overflow.value = data.forms_overflow;
};
const messageError = (
  e: unknown,
  fallback = "絞り込み結果を取得できませんでした。直前の表示を維持しています。再試行してください。",
) => {
  if (apiClient.isAxiosError(e)) {
    const data = e.response?.data;
    if (typeof data === "string" && data.length < 500 && !data.includes("<")) return data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string")
      return data.message;
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string")
      return data.error;
  }
  if (e instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(e.message)) return e.message;
  return fallback;
};
const canOpenPresets = () =>
  props.isOpen &&
  scopeReady.value &&
  !loading.value &&
  !error.value &&
  !busy.value &&
  !preparingPrint.value &&
  !csvPreparing.value &&
  !printSnapshot.value &&
  !childModalOpen.value;
const saveFilter = () => {
  if (!canOpenPresets()) return;
  filterError.value = "";
  try {
    if (expressionDraft.value) {
      presetDraft.value = toV2PresetDraft({
        schema_version: 2,
        kind: "filter",
        definition: expressionDraft.value.editor.getDefinition(),
      });
      return;
    }
    presetDraft.value = toV2PresetDraft({
      kind: "filter",
      definition: {
        common_form_id: selectedForm.value || null,
        conditions: serializeAnswerConditions(rows.value, fields.value),
      },
    });
  } catch (cause) {
    filterError.value = messageError(cause, "保存する条件を確認してください。");
  }
};
const saveColoring = (specification: AnswerColorSpecification) => {
  if (!canOpenPresets()) return;
  filterError.value = "";
  try {
    presetDraft.value = toV2PresetDraft({ kind: "coloring", definition: specification });
  } catch (cause) {
    filterError.value = messageError(cause, "保存する条件を確認してください。");
  }
};
const openPresets = () => {
  if (!canOpenPresets()) return;
  presetRestoreError.value = "";
  presetsOpen.value = true;
};
const presetSaved = () => {
  presetDraft.value = null;
  presetNotice.value = "検索条件を保存しました。";
};
const fetchPresetOptions = async (formId: string | null, signal: AbortSignal) => {
  const generation = optionsGeneration;
  // 編集候補には元の一覧内の過去の項目定義も含める。判定用の回答値は iframe の選択レイヤーに限定する。
  const { data } = await apiClient.post<Result>(
    endpoint.value,
    {
      query: baseQuery.value,
      targets: initialTargets.value,
      common_form_id: formId,
      conditions: [],
      options_only: true,
    },
    { signal, timeout: 60000 },
  );
  if (!Array.isArray(data.forms) || !Array.isArray(data.fields)) throw Error("Invalid response");
  if (formId && !data.forms.some((form) => form.id === formId))
    throw Error("保存した共通フォームが現在の対象範囲にありません。一覧の条件を確認してください。");
  signal.throwIfAborted();
  if (generation !== optionsGeneration) throw new DOMException("Aborted", "AbortError");
  presetOptions.set(formId ?? "", data);
  return data;
};
const readPresetOptions = async (formId: string | null, signal: AbortSignal) => {
  signal.throwIfAborted();
  const key = formId ?? "";
  const cached = presetOptions.get(key);
  if (cached) return cached;
  return optionReads.get(key, signal, (request) => fetchPresetOptions(formId, request));
};
const readColorFields = async (id: string, signal: AbortSignal) =>
  (await readPresetOptions(id, signal)).fields;
const prefetchPage = (items: SavedMapPreset[]) => {
  clearPresetPage();
  if (!items.length && !applyingPreset.value) presetApplyError.value = "";
  if (!presetsOpen.value || !items.length) return;
  // 選択済みの条件は一覧を閉じても準備を続ける。別ページのエラーを混ぜない。
  const failures = new Set<string>();
  pageFailures.value = failures;
  // 呼び出し後ももう片方の入力欄に残る手動下書きは引き続き実行できるようにする。
  const retained = appliedDefinitions();
  if (items.some((item) => item.kind === "coloring")) retained.push(filterDraftDefinition());
  if (items.some((item) => item.kind === "filter")) {
    const color = coloringPanel.value?.getDraft();
    if (color?.common_form_id && color.rules.length) retained.push(colorDefinition(color));
  }
  presetPage = prepareAnswerPresetPage(items, {
    requiredForm: baseQuery.value.common_form_id,
    retained,
    readOptions: readPresetOptions,
    prepare: prepareData,
    ready: (definitions) => !!presetData?.ready(definitions),
    onFailure: (affected) => {
      if (pageFailures.value !== failures) return;
      for (const preset of affected) failures.add(preset.name);
      triggerRef(pageFailures);
    },
  });
};
const waitForPageData = async (page: PreparedPage, definitions: AiDefinition[]) => {
  releaseDraftPage();
  if (presetData?.ready(definitions)) return;
  draftPage = page;
  const job = new AbortController();
  editPreparation = job;
  preparingData.value = true;
  const draft = JSON.stringify(draftDefinitions());
  try {
    await awaitWithAbort(page.data, job.signal);
    if (!presetData?.ready(definitions)) throw Error("判定用データを取得できませんでした。");
  } catch (cause) {
    if (!job.signal.aborted && !presetData?.ready(definitions))
      preparationError.value = messageError(cause, "判定用データを取得できませんでした。");
  } finally {
    if (editPreparation === job) {
      editPreparation = undefined;
      preparingData.value = false;
      releaseDraftPage();
      if (!preparationError.value && draft !== JSON.stringify(draftDefinitions()))
        void prepareEdits();
    }
  }
};
const restorePreset = async (preset: SavedMapPreset) => {
  if (
    !props.isOpen ||
    !presetsOpen.value ||
    restoringPreset.value ||
    applyingPreset.value ||
    busy.value
  )
    return;
  const seq = ++presetSequence,
    current = epoch;
  presetController?.abort();
  presetController = new AbortController();
  const signal = presetController.signal;
  const active = () =>
    props.isOpen &&
    presetsOpen.value &&
    current === epoch &&
    seq === presetSequence &&
    !signal.aborted;
  restoringPreset.value = true;
  presetRestoreError.value = "";
  presetApplyError.value = "";
  try {
    const draft = answerMapPresetInputs(preset);
    const page = presetPage;
    if (!page || !page.items.some((item) => item.id === preset.id))
      throw Error("保存した検索条件の一覧を閉じて開き直してください。");
    const preparedOptions = (id: string | null, request: AbortSignal) => {
      const options = page.options.get(id ?? "");
      if (!options) throw Error("保存した検索条件の一覧を閉じて開き直してください。");
      return awaitWithAbort(options, request);
    };
    if (draft.kind === "expression") {
      const host = document.createElement("div");
      let getFields = preparedOptions;
      const editor = createAiConditionEditor(host, {
        definition: draft.definition,
        display: preset.display,
        getForms: async () => forms.value.map((f) => ({ id: f.id, form_title: f.label })),
        getFields: (id, request) => getFields(id, request),
        onChange: () => void prepareEdits(),
      });
      try {
        await editor.refreshMetadata(signal);
        if (!active() || !expressionHost.value) return;
        editor.getDefinition();
        clearExpressionDraft();
        expressionHost.value.replaceChildren(host);
        expressionDraft.value = { name: preset.name, editor };
        selectedForm.value = "";
        rows.value = [];
      } finally {
        getFields = readPresetOptions;
        if (expressionDraft.value?.editor !== editor) editor.dispose();
      }
    } else {
      const formId = draft.definition.common_form_id;
      if (
        formId &&
        typeof baseQuery.value.common_form_id === "string" &&
        baseQuery.value.common_form_id !== formId
      )
        throw Error("現在の一覧と共通フォームが異なるため呼び出せません。");
      if (draft.kind === "coloring") {
        if (!coloringPanel.value) throw Error("色分けの入力欄が見つかりません。");
        draft.definition.rules.forEach((rule) =>
          createColorRuleRequest(
            baseQuery.value,
            appliedFilter,
            draft.definition.common_form_id,
            rule,
          ),
        );
      } else if (appliedColorSpecification) {
        appliedColorSpecification.rules.forEach((rule) =>
          createColorRuleRequest(
            baseQuery.value,
            draft.definition,
            appliedColorSpecification!.common_form_id,
            rule,
          ),
        );
      }
      const data = await preparedOptions(formId, signal);
      if (!active()) return;
      if (draft.kind === "filter") {
        const restored = deserializePresetConditions(
          draft.definition.conditions,
          data.fields,
          () => ++nextId,
        );
        clearExpressionDraft();
        selectedForm.value = formId || "";
        rows.value = restored;
        fields.value = data.fields;
      } else {
        coloringPanel.value!.restoreDraft(draft.definition, data.fields);
      }
      forms.value = data.forms;
      overflow.value = data.forms_overflow;
    }
    localPresets.value = true;
    stopPreparation();
    void waitForPageData(page, [preset.definition, ...draftDefinitions()]);
    if (preset.kind === "filter" && filterPanel.value) filterPanel.value.open = true;
    filtersOpen.value = true;
    filterError.value = "";
    presetNotice.value = "検索条件を呼び出しました。実行ボタンで地図に反映します。";
    await nextTick();
  } catch (cause) {
    if (active())
      presetRestoreError.value = messageError(
        cause,
        "検索条件を呼び出せませんでした。現在の入力を維持しています。再試行してください。",
      );
  } finally {
    if (seq === presetSequence) {
      restoringPreset.value = false;
      if (scopeChanged.value) void prepareEdits();
    }
  }
};
const failPresetApplication = (message: string) => {
  presetApplyError.value = message;
  applyingPreset.value = false;
};
const postMapFilter = (updateId: string, targets: string[], coloring: AnswerColoring | null) =>
  frame.value?.contentWindow?.postMessage(
    { type: "answer-map-filter", requestId: requestId.value, updateId, targets, coloring },
    new URL(props.action, window.location.href).origin,
  );
const restoreAppliedDisplay = () => {
  if (!appliedResult) return;
  try {
    postMapFilter(appliedId, appliedResult.targets, appliedColoring);
  } catch {
    // 地図との通信が切れている場合は、呼び出し元の更新エラーを表示する。
  }
};
const applyPreset = async (preset: SavedMapPreset) => {
  if (
    !props.isOpen ||
    !presetsOpen.value ||
    restoringPreset.value ||
    applyingPreset.value ||
    presetApplyComplete.value ||
    busy.value
  )
    return;
  const seq = ++presetSequence;
  presetController?.abort();
  presetController = new AbortController();
  const signal = presetController.signal;
  applyingPreset.value = true;
  presetApplyError.value = "";
  presetRestoreError.value = "";
  try {
    const draft = answerMapPresetInputs(preset);
    const page = presetPage;
    if (!page?.items.some((item) => item.id === preset.id))
      throw Error("保存した検索条件の一覧を閉じて開き直してください。");
    if (
      draft.kind !== "expression" &&
      draft.definition.common_form_id &&
      typeof baseQuery.value.common_form_id === "string" &&
      baseQuery.value.common_form_id !== draft.definition.common_form_id
    )
      throw Error("現在の一覧と共通フォームが異なるため適用できません。");
    const metadata = new Map(
      await Promise.all(
        [...presetReferences([preset.definition]).keys()].map(async (id) => {
          const options = page.options.get(id);
          if (!options) throw Error("保存した検索条件の一覧を閉じて開き直してください。");
          try {
            return [id, (await awaitWithAbort(options, signal)).fields] as const;
          } catch (cause) {
            signal.throwIfAborted();
            throw Error(
              `${messageError(cause, "項目情報を取得できませんでした。")} 一覧を閉じて開き直してから、もう一度適用してください。`,
            );
          }
        }),
      ),
    );
    signal.throwIfAborted();
    const definition = validateAiDefinitionFields(
      preset.definition,
      (id) => metadata.get(id) ?? [],
      preset.display,
    );
    const retained =
      draft.kind === "coloring"
        ? filterDefinition(appliedFilter)
        : appliedColorSpecification && colorDefinition(appliedColorSpecification);
    const required = retained ? [preset.definition, retained] : [preset.definition];
    if (!presetData?.ready(required)) {
      await awaitWithAbort(page.data, signal).catch(async () => {
        signal.throwIfAborted();
        if (!presetData?.ready(required)) await prepareData(required, signal);
      });
    }
    signal.throwIfAborted();
    if (pageFailures.value.delete(preset.name)) triggerRef(pageFailures);
    if (draft.kind === "coloring") {
      await fetchResult(false, false, { specification: draft.definition }, false, {
        name: preset.name,
      });
      return;
    }
    const filter =
      draft.kind === "filter"
        ? draft.definition
        : { common_form_id: null, conditions: [], expression: definition.expression };
    await fetchResult(false, false, undefined, false, { name: preset.name, filter });
  } catch (cause) {
    if (!signal.aborted && seq === presetSequence)
      failPresetApplication(
        messageError(cause, "検索条件を適用できませんでした。再試行してください。"),
      );
  }
};
const fetchResult = async (
  optionsOnly: boolean,
  reset = false,
  colorChange?: { specification: AnswerColorSpecification | null },
  refreshingScope = false,
  preset?: { name: string; filter?: AppliedMapFilter },
) => {
  const reportError = (message: string) => {
    if (preset) failPresetApplication(message);
    else filterError.value = message;
  };
  if (!scopeReady.value || !props.isOpen || (childModalOpen.value && !preset)) {
    if (preset) reportError("地図の読み込み完了後に再試行してください。");
    return;
  }
  if (
    colorChange &&
    (busy.value || preparingPrint.value || csvPreparing.value || printSnapshot.value)
  ) {
    if (preset) reportError("地図の処理完了後に再試行してください。");
    return;
  }
  if (!preset) filterError.value = "";
  let conditions: Record<string, unknown>[] = [];
  let expression: unknown;
  if (!reset && !colorChange && !preset) {
    try {
      if (expressionDraft.value)
        expression = expressionDraft.value.editor.getDefinition().expression;
      else conditions = serializeAnswerConditions(rows.value, fields.value);
    } catch (e) {
      filterError.value = (e as Error).message;
      return;
    }
  }
  if (conditions.length && !selectedForm.value) {
    filterError.value = "共通フォームを選択してください。";
    return;
  }
  controller?.abort();
  clearTimeout(ackTimeout);
  pending = undefined;
  controller = new AbortController();
  const current = epoch,
    metadataGeneration = optionsGeneration,
    seq = ++sequence,
    id = requestId.value;
  optionsOnlyPhase.value = optionsOnly;
  busy.value = true;
  const requestedFilter: AppliedMapFilter =
    preset?.filter ??
    (colorChange
      ? JSON.parse(JSON.stringify(appliedFilter))
      : {
          common_form_id: reset ? null : selectedForm.value || null,
          conditions: optionsOnly ? [] : JSON.parse(JSON.stringify(conditions)),
          ...(expression ? { expression } : {}),
        });
  const requestedColors: AnswerColorSpecification | null = JSON.parse(
    JSON.stringify(colorChange ? colorChange.specification : appliedColorSpecification),
  );
  try {
    // 共通の 20 条件制限も含め、処理を始める前にすべてのリクエストを検証する。
    const colorRequests =
      !optionsOnly &&
      requestedColors?.rules.map((rule) =>
        createColorRuleRequest(
          baseQuery.value,
          requestedFilter,
          requestedColors.common_form_id,
          rule,
        ),
      );
    let localResult: ReturnType<LocalPresetData["evaluateAnswers"]> | undefined;
    if (!optionsOnly && (localPresets.value || preset)) {
      const filter = filterDefinition(requestedFilter);
      const color = requestedColors ? colorDefinition(requestedColors) : null;
      if (!presetData?.ready(color ? [filter, color] : [filter]))
        throw Error("判定用データの準備完了後に実行してください。");
      localResult = presetData.evaluateAnswers(filter, color);
    }
    const data: Result = localResult
      ? {
          forms: forms.value,
          fields: fields.value,
          forms_overflow: overflow.value,
          targets: localResult.targets,
          target_count: localResult.target_count,
          answer_count: localResult.answer_count,
        }
      : optionsOnly && localPresets.value
        ? await readPresetOptions(requestedFilter.common_form_id, controller.signal)
        : colorChange && appliedResult
          ? JSON.parse(JSON.stringify(appliedResult))
          : (
              await apiClient.post<Result>(
                endpoint.value,
                {
                  query: baseQuery.value,
                  targets: initialTargets.value,
                  ...requestedFilter,
                  options_only: optionsOnly,
                },
                { signal: controller.signal, timeout: 60000 },
              )
            ).data;
    if (!props.isOpen || current !== epoch || seq !== sequence || id !== requestId.value) return;
    if (!Array.isArray(data.forms) || !Array.isArray(data.fields) || !Array.isArray(data.targets))
      throw Error("Invalid response");
    if (!colorChange && !preset) meta(data);
    if (optionsOnly) {
      const id = requestedFilter.common_form_id;
      if (
        metadataGeneration === optionsGeneration &&
        (!id || data.forms.some((form) => form.id === id))
      )
        presetOptions.set(id ?? "", data);
      busy.value = false;
      return;
    }
    const initial = new Set(initialTargets.value);
    if (
      !Number.isSafeInteger(data.target_count) ||
      data.target_count !== data.targets.length ||
      data.targets.some((k) => !initial.has(k)) ||
      new Set(data.targets).size !== data.targets.length ||
      !Number.isSafeInteger(data.answer_count) ||
      data.answer_count < 0
    )
      throw Error("Invalid response");
    let coloring: AnswerColoring | null = null;
    if (localResult) coloring = localResult.coloring;
    else if (requestedColors && colorRequests) {
      let index = 0;
      coloring = await classifyMapTargets(requestedColors, new Set(data.targets), async () => {
        const classified = (
          await apiClient.post<Result>(
            endpoint.value,
            {
              ...colorRequests[index++],
              ...(requestedFilter.expression ? { expression: requestedFilter.expression } : {}),
              targets: initialTargets.value,
            },
            { signal: controller!.signal, timeout: 60000 },
          )
        ).data;
        if (!props.isOpen || current !== epoch || seq !== sequence || id !== requestId.value)
          throw Error("色分けを中止しました。");
        validateColorTargets(classified.targets, new Set(initialTargets.value));
        if (classified.target_count !== classified.targets.length)
          throw Error("色分けの件数が不正です。");
        return classified.targets;
      });
    }
    const formLabel = forms.value.find((f) => f.id === selectedForm.value)?.label || "";
    const conditionLabels = rows.value.map(
      (row) =>
        `${selected(row)?.label} ${operations(row).find((op) => op.value === row.op)?.label} ${noValue(row) ? "" : selected(row)?.field_type === "checkbox" ? (row.value === "true" ? "はい" : "いいえ") : row.selected.length ? row.selected.join("・") : row.value}${row.op === "between" ? `〜${row.upper}` : ""}`,
    );
    pending = {
      id: `${id}:${seq}`,
      result: data,
      fromPreset: !!preset,
      filter: requestedFilter,
      colorSpecification: requestedColors,
      coloring,
      completion:
        optionsOnly || reset || refreshingScope || colorChange?.specification === null
          ? null
          : colorChange
            ? "coloring"
            : "filter",
      summary: colorChange
        ? applied.value
        : (preset?.name ??
          (expressionDraft.value && !reset
            ? expressionDraft.value.name
            : reset || !selectedForm.value
              ? "一覧と同じ範囲"
              : [formLabel, ...conditionLabels].join(" ／ "))),
    };
    postMapFilter(pending.id, data.targets, coloring);
    ackTimeout = setTimeout(() => {
      if (!props.isOpen || current !== epoch || seq !== sequence || id !== requestId.value) return;
      busy.value = false;
      pending = undefined;
      if (preset) restoreAppliedDisplay();
      reportError(
        preset
          ? "地図の更新結果を確認できませんでした。もう一度適用してください。"
          : "地図の更新結果を確認できませんでした。再度絞り込みを実行してください。",
      );
    }, 10000);
    if (reset) {
      clearExpressionDraft();
      selectedForm.value = "";
      rows.value = [];
    }
  } catch (e) {
    if (current !== epoch || seq !== sequence || !props.isOpen) return;
    if (preset) pending = undefined;
    busy.value = false;
    reportError(
      messageError(e, preset ? "検索条件を適用できませんでした。再試行してください。" : undefined),
    );
  }
};
const applyColoring = (specification: AnswerColorSpecification | null) =>
  void fetchResult(false, false, { specification });
watch(
  () => [
    scopeChanged.value,
    busy.value,
    preparingData.value,
    preparationError.value,
    childModalOpen.value,
    preparingPrint.value,
    csvPreparing.value,
    printSnapshot.value,
  ],
  () => {
    if (
      !scopeChanged.value ||
      busy.value ||
      preparingData.value ||
      preparationError.value ||
      childModalOpen.value ||
      preparingPrint.value ||
      csvPreparing.value ||
      printSnapshot.value ||
      !presetData?.ready(appliedDefinitions())
    )
      return;
    scopeChanged.value = false;
    void fetchResult(false, false, { specification: appliedColorSpecification }, true);
  },
);
const loadOptions = () => {
  rows.value = [];
  fields.value = [];
  void fetchResult(true);
};
const invalidatePresetData = (metadata: boolean) => {
  if (!props.isOpen || !scopeReady.value) return;
  const pageItems = presetPage?.items;
  releaseDraftPage();
  clearPresetPage();
  scopeReads.clear();
  if (metadata) {
    optionsGeneration++;
    presetOptions.clear();
    optionReads.clear();
    refreshFields = localPresets.value;
  }
  stopPreparation();
  presetData = undefined;
  scopeChanged.value = localPresets.value;
  if (pending || (localPresets.value && busy.value)) {
    if (pending?.fromPreset) restoreAppliedDisplay();
    clearTimeout(ackTimeout);
    controller?.abort();
    pending = undefined;
    busy.value = false;
    sequence++;
  }
  if (restoringPreset.value) {
    presetController?.abort();
    presetRestoreError.value = "地図の対象データが変わりました。条件をもう一度呼び出してください。";
  }
  if (applyingPreset.value) {
    presetController?.abort();
    failPresetApplication("地図の対象データが変わりました。条件をもう一度適用してください。");
  }
  if (pageItems) prefetchPage(pageItems);
  void prepareEdits();
};
const answerUpdated = (event: Event) => {
  const record = (event as CustomEvent).detail;
  if (
    !record ||
    typeof record.id !== "string" ||
    (record.user_id && record.user_id !== scopeAccountId)
  )
    return;
  const key = `${"geojson" in record ? "shape" : "marker"}:${record.id}`;
  if (initialTargets.value.includes(key)) invalidatePresetData(true);
};
const onMessage = (event: MessageEvent) => {
  if (
    !props.isOpen ||
    !frame.value ||
    event.source !== frame.value.contentWindow ||
    event.origin !== new URL(props.action, window.location.href).origin
  )
    return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.requestId !== requestId.value) return;
  if (data.type === "answer-map-preset-scope-changed") {
    invalidatePresetData(false);
    return;
  }
  if (
    (data.type === "answer-map-csv-targets" || data.type === "answer-map-csv-error") &&
    csvPreparing.value &&
    csvCapture &&
    data.csvRequestId === csvCapture.id
  ) {
    clearTimeout(csvTimer);
    const capture = csvCapture;
    csvCapture = undefined;
    const initial = new Set(initialTargets.value);
    if (
      data.type !== "answer-map-csv-targets" ||
      data.updateId !== capture.updateId ||
      data.updateId !== appliedId ||
      !Array.isArray(data.targets) ||
      !data.targets.length ||
      new Set(data.targets).size !== data.targets.length ||
      data.targets.some((id: unknown) => typeof id !== "string" || !initial.has(id))
    ) {
      csvPreparing.value = false;
      filterError.value =
        typeof data.message === "string"
          ? data.message
          : "CSVの対象を取得できませんでした。地図の更新完了後に再試行してください。";
      return;
    }
    void downloadCsv({ ...capture.request, targets: data.targets });
    return;
  }
  if (data.type === "answer-map-print-open") {
    openPrint();
    return;
  }
  if (
    (data.type === "answer-map-print-state" || data.type === "answer-map-print-error") &&
    preparingPrint.value &&
    data.printRequestId === printRequest
  ) {
    clearTimeout(printTimer);
    preparingPrint.value = false;
    if (
      data.type === "answer-map-print-state" &&
      data.updateId === appliedId &&
      data.snapshot &&
      typeof data.snapshot === "object"
    )
      printSnapshot.value = data.snapshot;
    else
      filterError.value =
        typeof data.message === "string"
          ? data.message
          : "印刷対象を取得できませんでした。再試行してください。";
    return;
  }
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (data.type === "answer-map-ready") {
    if (![data.answerCount, data.targetCount, data.displayed, data.skipped].every(count)) return;
    clearTimeout(timeout);
    disposeNativeRequest?.();
    loading.value = false;
    error.value = "";
    initialCount.value = matchedCount.value = data.targetCount;
    answerCount.value = data.answerCount;
    visibleCount.value = renderableCount.value = data.displayed;
    applied.value = "一覧と同じ範囲";
    appliedId = "";
    appliedFilter = { common_form_id: null, conditions: [] };
    appliedColorSpecification = null;
    appliedColoring = null;
    coloringActive.value = false;
    appliedForm.value = "";
    preserveColorDraftAfterPreset.value = false;
    frame.value?.contentWindow?.postMessage(
      {
        type: "answer-map-print-enable",
        requestId: requestId.value,
        enabled: props.printEnabled === true,
      },
      new URL(props.action, location.href).origin,
    );
    if (
      data.query &&
      typeof data.query.as_of === "string" &&
      Array.isArray(data.targets) &&
      data.targets.length === data.targetCount &&
      new Set(data.targets).size === data.targets.length &&
      data.targets.every((v: unknown) => typeof v === "string")
    ) {
      baseQuery.value = data.query;
      scopeAccountId = typeof data.accountId === "string" ? data.accountId : "";
      initialTargets.value = data.targets;
      appliedResult = {
        forms: [],
        fields: [],
        forms_overflow: false,
        targets: [...data.targets],
        target_count: data.targetCount,
        answer_count: data.answerCount,
      };
      scopeReady.value = true;
      void fetchResult(true);
    }
  } else if (data.type === "answer-map-error") {
    disposeNativeRequest?.();
    clearTimeout(timeout);
    loading.value = false;
    error.value = typeof data.message === "string" ? data.message : "地図を表示できませんでした。";
  } else if (data.type === "answer-map-filter-applied" && pending && pending.id === data.updateId) {
    if (
      !count(data.visible) ||
      !count(data.renderable) ||
      data.visible > data.renderable ||
      data.renderable > pending.result.target_count
    )
      return;
    clearTimeout(ackTimeout);
    matchedCount.value = pending.result.target_count;
    answerCount.value = pending.result.answer_count;
    visibleCount.value = data.visible;
    renderableCount.value = data.renderable;
    applied.value = pending.summary;
    appliedFilter = pending.filter;
    appliedResult = pending.result;
    appliedForm.value = appliedFilter.common_form_id || "";
    appliedColorSpecification = pending.colorSpecification;
    appliedColoring = pending.coloring;
    coloringActive.value = appliedColorSpecification !== null;
    appliedId = data.updateId;
    if (pending.completion === "filter") preserveColorDraftAfterPreset.value = !!pending.fromPreset;
    if (pending.fromPreset) {
      localPresets.value = true;
      scopeChanged.value = false;
      applyingPreset.value = false;
      presetNotice.value = "";
      if (pending.completion) presetApplyComplete.value = mapOperationMessages[pending.completion];
      void prepareEdits();
    } else if (pending.completion) {
      completionFocus = document.activeElement as HTMLElement | null;
      completionMessage.value = mapOperationMessages[pending.completion];
    }
    pending = undefined;
    busy.value = false;
  } else if (data.type === "answer-map-filter-error" && pending && pending.id === data.updateId) {
    clearTimeout(ackTimeout);
    const message = typeof data.message === "string" ? data.message : "表示更新に失敗しました。";
    if (pending.fromPreset) failPresetApplication(message);
    else filterError.value = message;
    pending = undefined;
    busy.value = false;
  } else if (
    data.type === "answer-map-filter-visible" &&
    data.updateId === appliedId &&
    count(data.visible) &&
    count(data.renderable) &&
    data.visible <= data.renderable &&
    data.renderable <= matchedCount.value
  ) {
    visibleCount.value = data.visible;
    renderableCount.value = data.renderable;
  }
};
const fit = () =>
  frame.value?.contentWindow?.postMessage(
    { type: "answer-map-fit", requestId: requestId.value },
    new URL(props.action, window.location.href).origin,
  );
const downloadCsv = async (request: Record<string, unknown>) => {
  const seq = csvSequence,
    current = epoch;
  csvController = new AbortController();
  try {
    const data = (
      await apiClient.post<{ count: number }>(csvCheckAction.value, request, {
        signal: csvController.signal,
        timeout: 60000,
      })
    ).data;
    if (!props.isOpen || current !== epoch || seq !== csvSequence) return;
    if (!Number.isSafeInteger(data.count) || data.count < 0 || data.count > 10000)
      throw Error("Invalid CSV response");
    if (data.count === 0) {
      filterError.value = "出力対象の登録がありません。地図を更新して確認してください。";
      return;
    }
    if (!csvForm.value || !csvFrame.value) throw Error("Download frame unavailable");
    csvQuery.value = JSON.stringify(request);
    const input = csvForm.value.querySelector<HTMLInputElement>('input[name="query"]');
    if (input) input.value = csvQuery.value;
    disposeCsv = submitAuthenticatedForm(csvForm.value, csvFrame.value, (message) => {
      if (props.isOpen && seq === csvSequence) filterError.value = message;
    });
  } catch (error) {
    if (props.isOpen && current === epoch && seq === csvSequence)
      filterError.value = messageError(
        error,
        "CSVを出力できませんでした。地図の表示は維持しています。再試行してください。",
      );
  } finally {
    if (seq === csvSequence) csvPreparing.value = false;
  }
};
const exportCsv = () => {
  if (
    !props.printEnabled ||
    !props.isOpen ||
    loading.value ||
    error.value ||
    busy.value ||
    !scopeReady.value ||
    !visibleCount.value ||
    preparingPrint.value ||
    printSnapshot.value ||
    csvPreparing.value ||
    childModalOpen.value
  )
    return;
  stopCsv();
  csvPreparing.value = true;
  filterError.value = "";
  const id = `csv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  csvCapture = {
    id,
    updateId: appliedId,
    request: JSON.parse(
      JSON.stringify({ query: baseQuery.value, ...appliedFilter, options_only: false }),
    ),
  };
  frame.value?.contentWindow?.postMessage(
    {
      type: "answer-map-csv-request",
      requestId: requestId.value,
      csvRequestId: id,
      updateId: appliedId,
    },
    new URL(props.action, location.href).origin,
  );
  csvTimer = setTimeout(() => {
    csvCapture = undefined;
    csvPreparing.value = false;
    filterError.value = "CSVの対象を取得できませんでした。再試行してください。";
  }, 15000);
};
const openPrint = () => {
  if (
    !props.printEnabled ||
    !props.isOpen ||
    loading.value ||
    error.value ||
    busy.value ||
    !scopeReady.value ||
    !visibleCount.value ||
    preparingPrint.value ||
    csvPreparing.value ||
    printSnapshot.value ||
    childModalOpen.value
  )
    return;
  preparingPrint.value = true;
  filterError.value = "";
  printRequest = `print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  frame.value?.contentWindow?.postMessage(
    {
      type: "answer-map-print-request",
      requestId: requestId.value,
      printRequestId: printRequest,
      updateId: appliedId,
    },
    new URL(props.action, location.href).origin,
  );
  printTimer = setTimeout(() => {
    preparingPrint.value = false;
    filterError.value = "印刷対象を取得できませんでした。再試行してください。";
  }, PRINT_REQUEST_TIMEOUT_MS);
};
const onKey = (e: KeyboardEvent) => {
  if (props.isOpen && childModalOpen.value) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") e.preventDefault();
    if (completionMessage.value && e.key === "Escape") {
      e.preventDefault();
      void closeCompletion();
    }
    return;
  }
  if (printSnapshot.value) return;
  if (
    props.isOpen &&
    props.printEnabled &&
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    !e.isComposing &&
    e.key.toLowerCase() === "p"
  ) {
    e.preventDefault();
    if (!e.repeat) openPrint();
    return;
  }
  if (props.isOpen && e.key === "Escape") emit("close");
};
watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      filtersOpen.value = true;
      selectedForm.value = "";
      rows.value = [];
      forms.value = [];
      fields.value = [];
      overflow.value = false;
      initialCount.value = 0;
      void submit();
    } else {
      epoch++;
      stop();
    }
  },
  { immediate: true },
);
onMounted(() => {
  stopFormUpdates = observeAiSuggestionDataChanges(
    () => scopeAccountId,
    () => invalidatePresetData(true),
  );
  window.addEventListener("geocode-answer-updated", answerUpdated);
  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  stopFormUpdates?.();
  window.removeEventListener("geocode-answer-updated", answerUpdated);
  epoch++;
  stop();
  window.removeEventListener("message", onMessage);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div
    v-if="isOpen"
    class="answer-map-overlay overlay-fullscreen-map"
    role="dialog"
    aria-modal="true"
    aria-label="地図で分析・検索・出力"
    v-bind="$attrs"
  >
    <button
      type="button"
      class="fullscreen-close-btn"
      :disabled="childModalOpen"
      @click="emit('close')"
    >
      閉じる
    </button>
    <div class="content-fullscreen-map" :inert="childModalOpen || undefined">
      <header>
        <strong>地図で分析・検索・出力</strong
        ><span v-if="!loading && !error">{{ summary }}（一致登録{{ answerCount }}件）</span>
        <button
          v-if="printEnabled"
          type="button"
          :disabled="
            loading ||
            !!error ||
            busy ||
            !scopeReady ||
            !visibleCount ||
            preparingPrint ||
            csvPreparing
          "
          @click="openPrint"
        >
          {{ preparingPrint ? "印刷準備中…" : "地図を印刷" }}
        </button>
        <button
          v-if="printEnabled"
          type="button"
          :disabled="
            loading ||
            !!error ||
            busy ||
            !scopeReady ||
            !visibleCount ||
            preparingPrint ||
            csvPreparing
          "
          @click="exportCsv"
        >
          {{ csvPreparing ? "CSV準備中…" : "CSV出力" }}
        </button>
        <button
          type="button"
          :disabled="
            loading ||
            !!error ||
            busy ||
            !scopeReady ||
            preparingPrint ||
            csvPreparing ||
            !!printSnapshot ||
            presetModalOpen
          "
          @click="openPresets"
        >
          保存した検索条件
        </button>
      </header>
      <div class="answer-map-body" :class="{ 'filters-closed': !filtersOpen }">
        <aside
          v-if="!loading && !error"
          :id="filtersPanelId"
          class="filter-sidebar"
          aria-label="地図の絞り込み"
        >
          <details ref="filterPanel" class="filter-panel" open>
            <summary>地図上で絞り込み</summary>
            <fieldset
              :disabled="busy || !scopeReady || preparingPrint || csvPreparing || presetModalOpen"
            >
              <div ref="expressionHost" v-show="expressionDraft"></div>
              <div class="filter-actions">
                <label v-if="!expressionDraft"
                  >共通フォーム
                  <select v-model="selectedForm" aria-label="共通フォーム" @change="loadOptions">
                    <option value="">一覧と同じ範囲</option>
                    <option v-for="f in forms" :key="f.id" :value="f.id">{{ f.label }}</option>
                  </select></label
                >
                <button
                  class="btn-close"
                  type="button"
                  :disabled="preparingData || !!preparationError"
                  @click="fetchResult(false, true)"
                >
                  地図条件を解除
                </button>
                <button class="btn-close" type="button" :disabled="!visibleCount" @click="fit">
                  表示範囲の移動
                </button>
                <button
                  class="btn-close"
                  type="button"
                  v-if="!expressionDraft"
                  :disabled="!selectedForm || !fields.length || rows.length >= 10"
                  @click="addRow"
                >
                  条件を追加
                </button>
                <button
                  class="btn-close filter-submit"
                  type="button"
                  :disabled="preparingData || !!preparationError"
                  @click="fetchResult(false)"
                >
                  絞り込み実行
                </button>
                <button class="btn-close" type="button" @click="saveFilter">検索条件を保存</button>
              </div>
              <div v-for="row in rows" :key="row.id" class="condition-row">
                <select v-model="row.key" aria-label="入力項目" @change="resetRow(row)">
                  <option v-for="f in fields" :key="fieldKey(f)" :value="fieldKey(f)">
                    {{ f.label }}（{{
                      f.field_type === "date"
                        ? "日付"
                        : f.field_type === "number"
                          ? "数値"
                          : f.field_type === "checkbox"
                            ? "はい／いいえ"
                            : f.field_type === "select" || f.field_type === "radio"
                              ? "選択肢"
                              : "文字列"
                    }}）
                  </option>
                </select>
                <select v-model="row.op" aria-label="比較方法">
                  <option v-for="op in operations(row)" :key="op.value" :value="op.value">
                    {{ op.label }}
                  </option>
                </select>
                <template v-if="!noValue(row)">
                  <select
                    v-if="
                      selected(row)?.field_type === 'select' ||
                      selected(row)?.field_type === 'radio'
                    "
                    v-model="row.selected"
                    multiple
                    aria-label="選択値"
                  >
                    <option v-for="choice in selected(row)?.choices" :key="choice" :value="choice">
                      {{ choice }}
                    </option>
                  </select>
                  <select
                    v-else-if="selected(row)?.field_type === 'checkbox'"
                    v-model="row.value"
                    aria-label="登録値"
                  >
                    <option value="true">はい</option>
                    <option value="false">いいえ</option>
                  </select>
                  <input
                    v-else
                    v-model="row.value"
                    :type="selected(row)?.field_type === 'date' ? 'date' : 'text'"
                    :inputmode="selected(row)?.field_type === 'number' ? 'decimal' : undefined"
                    aria-label="条件の値"
                  />
                  <template v-if="row.op === 'between'"
                    ><span>〜</span
                    ><input
                      v-model="row.upper"
                      :type="selected(row)?.field_type === 'date' ? 'date' : 'text'"
                      :inputmode="selected(row)?.field_type === 'number' ? 'decimal' : undefined"
                      aria-label="範囲の終了値"
                  /></template>
                </template>
                <button
                  class="btn-close"
                  type="button"
                  @click="rows = rows.filter((r) => r.id !== row.id)"
                >
                  削除
                </button>
              </div>
            </fieldset>
            <p v-if="!expressionDraft" class="filter-help">
              最大10件のAND条件です。日付の期間は開始日・終了日を含みます。条件変更後は「絞り込み実行」で反映します。
            </p>
            <p v-if="overflow" class="filter-help">
              フォーム候補は200件までです。一覧で条件を絞ってください。
            </p>
            <p v-if="!scopeReady" class="filter-help">
              絞り込みを使用するには地図を開き直してください。
            </p>
          </details>
          <AnswerColoringPanel
            ref="coloringPanel"
            :forms="forms"
            :endpoint="endpoint"
            :query="baseQuery"
            :targets="initialTargets"
            :requiredForm="colorFormConstraint"
            :disabled="
              busy ||
              !scopeReady ||
              preparingPrint ||
              csvPreparing ||
              !!printSnapshot ||
              presetModalOpen
            "
            :active="coloringActive"
            :preserve-draft="preserveColorDraftAfterPreset"
            :load-fields="localPresets ? readColorFields : undefined"
            :apply-disabled="preparingData || !!preparationError"
            @fields-changed="prepareEdits"
            @apply="applyColoring"
            @save="saveColoring"
          />
          <div v-if="!loading && !error" class="map-status" role="status">
            <span>表示に反映済み：{{ applied }}</span
            ><span v-if="busy">処理中…</span
            ><span v-else-if="matchedCount === 0">条件に一致する対象がありません。</span>
          </div>
          <p v-if="filterError" class="map-warning" role="alert">{{ filterError }}</p>
          <p v-if="preparingData" class="filter-help" role="status">
            判定用データを準備しています…
          </p>
          <p v-if="preparationError" class="map-warning" role="alert">
            {{ preparationError }} <button type="button" @click="prepareEdits">再試行</button>
          </p>
          <p v-if="presetNotice" class="filter-help preset-notice" role="status">
            {{ presetNotice }}
          </p>
          <p v-if="skipped && !loading && !error" class="map-warning">
            位置情報などの問題により{{ skipped }}件を表示できませんでした。
          </p>
        </aside>
        <div class="map-content">
          <iframe
            ref="frame"
            :name="frameName"
            title="登録条件に一致する対象の地図"
            :class="{ 'is-loading': loading || error }"
          />
          <div v-if="loading" class="map-state" role="status">
            <ProgressSpinner :is-open="loading" inline />
            <span>地図を読み込んでいます…</span>
          </div>
          <div v-if="error" class="map-state" role="alert">
            <p>{{ error }}</p>
            <button type="button" @click="submit">再試行</button>
          </div>
        </div>
      </div>
      <button
        v-if="!loading && !error"
        type="button"
        class="answer-map-filter-toggle"
        :aria-expanded="filtersOpen"
        :aria-controls="filtersPanelId"
        @click="filtersOpen = !filtersOpen"
      >
        {{ filtersOpen ? "絞り込みを閉じる" : "絞り込みを開く" }}
      </button>
      <form ref="form" :action="action" method="post" :target="frameName" hidden>
        <input name="query" type="hidden" :value="JSON.stringify(query)" /><input
          name="parent_origin"
          type="hidden"
          :value="parentOrigin"
        /><input name="request_id" type="hidden" :value="requestId" />
        <input name="initial_view" type="hidden" :value="initialView" />
      </form>
      <iframe
        v-if="printEnabled"
        ref="csvFrame"
        :name="csvFrameName"
        title="登録地図CSVダウンロード"
        hidden
      />
      <form
        v-if="printEnabled"
        ref="csvForm"
        :action="csvAction"
        :target="csvFrameName"
        method="post"
        hidden
      >
        <input name="query" type="hidden" :value="csvQuery" />
      </form>
    </div>
    <PrintMapModal
      v-if="printSnapshot"
      :layerIds="null"
      :answerPrint="{ action: printAction, snapshot: printSnapshot }"
      @close="printSnapshot = null"
    />
    <MessageModal
      v-if="completionMessage"
      ref="completionModal"
      class="common-form-confirm"
      role="dialog"
      aria-modal="true"
      aria-label="処理完了"
      :isOpen="true"
      :zIndex="120"
      :message="completionMessage"
      @close="closeCompletion"
    />
    <SaveMapPresetModal
      :isOpen="presetDraft !== null"
      :draft="presetDraft"
      :endpoint="presetEndpoint"
      @close="presetDraft = null"
      @saved="presetSaved"
    />
    <SavedMapPresetsModal
      :isOpen="presetsOpen"
      :endpoint="presetEndpoint"
      :restoring="restoringPreset"
      :restoreError="presetRestoreError"
      :applying="applyingPreset"
      :applyError="presetApplyError"
      :applyComplete="presetApplyComplete"
      :preparationFailures="[...pageFailures]"
      @close="closePresets"
      @page-items="prefetchPage"
      @restore="restorePreset"
      @apply="applyPreset"
      @dismiss-apply-complete="presetApplyComplete = ''"
    />
  </div>
  <Teleport to="body">
    <ProgressSpinner
      v-if="updatingMap && !applyingPreset"
      :is-open="true"
      :style="{ zIndex: 120 }"
      role="status"
      aria-label="地図の表示を更新しています"
    >
      <template #controls>
        <button type="button" class="progress-close-button" @click="emit('close')">閉じる</button>
      </template>
    </ProgressSpinner>
  </Teleport>
</template>

<style scoped>
.answer-map-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100dvh;
  background: rgba(0, 0, 0, 0.5);
  color: #172033;
  box-sizing: border-box;
  padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right))
    max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
}
.content-fullscreen-map {
  z-index: 101;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 95dvh;
  max-height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 1em;
  background: #444;
  border-radius: 2px;
}
.fullscreen-close-btn {
  z-index: 102;
  position: fixed;
  bottom: max(5%, calc(env(safe-area-inset-bottom) + 12px));
  left: max(2%, calc(env(safe-area-inset-left) + 12px));
}
.answer-map-filter-toggle {
  position: fixed;
  right: 2%;
  bottom: 7%;
  z-index: 102;
  padding: 0.45em 0.8em;
  font-size: 0.85em;
}
.answer-map-body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.filter-sidebar {
  flex: 0 0 23%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  background: whitesmoke;
  padding-bottom: 64px;
}
header,
.map-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 8px 12px;
  flex-shrink: 0;
  background: whitesmoke;
  font-size: 13px;
}
header strong {
  font-size: 16px;
}
.answer-map-overlay:not(.answer-map-mobile-layout) header {
  background: black;
  color: whitesmoke;
}
.map-status {
  overflow-wrap: anywhere;
}
.filter-panel {
  background: whitesmoke;
  padding: 8px 12px;
  flex-shrink: 0;
  font-size: 14px;
}
.filter-panel summary {
  cursor: pointer;
  font-weight: bold;
}
fieldset {
  border: 0;
  padding: 8px 0 0;
  margin: 0;
  min-width: 0;
}
.filter-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.filter-actions > button {
  width: 100%;
  min-width: 0;
  margin: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.condition-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  border-top: 1px solid #ccc;
  padding-top: 8px;
}
.condition-row > select,
.condition-row > input {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}
.condition-row > button {
  justify-self: end;
  margin: 0;
}
.filter-actions label {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  min-width: 0;
}
.filter-actions label select {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}
select,
input {
  font: inherit;
  min-height: 34px;
  max-width: 240px;
  box-sizing: border-box;
}
select[multiple] {
  min-height: 64px;
}
.filter-help {
  font-size: 12px;
  margin: 4px 0;
}
.preset-notice {
  padding: 8px 12px;
}
button {
  background: #5f5f5f;
  color: white;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 12px;
  min-height: 40px;
  flex-shrink: 0;
  cursor: pointer;
  font: inherit;
}
.filter-submit {
  background: #2165bb;
  border-color: #2165bb;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.map-content {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  background: whitesmoke;
}
.map-content > iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  padding: 0;
  box-sizing: border-box;
}
.is-loading {
  visibility: hidden;
}
.map-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  margin: 0;
  text-align: center;
}
.map-warning {
  padding: 8px 12px;
  margin: 0;
  color: #7c3f00;
  background: #fff3d6;
  font-size: 13px;
}
@media (min-width: 701px) {
  .answer-map-overlay:not(.answer-map-mobile-layout) .filter-sidebar {
    transition:
      flex-basis 0.2s ease,
      visibility 0.2s;
  }
  .answer-map-overlay:not(.answer-map-mobile-layout) .filters-closed .filter-sidebar {
    flex-basis: 0;
    overflow: hidden;
    visibility: hidden;
  }
}
.answer-map-mobile-layout .filter-actions > button {
  padding: 8px 6px;
  font-size: 13px;
}
.answer-map-mobile-layout .answer-map-body {
  flex-direction: column;
}
.answer-map-mobile-layout .filter-sidebar {
  flex: 0 1 auto;
  width: 100%;
  max-height: 40dvh;
  padding-bottom: 0;
}
.answer-map-mobile-layout .answer-map-filter-toggle {
  display: none;
}
.answer-map-mobile-layout .map-status {
  font-size: 12px;
}
@media (max-width: 700px) {
  .filter-actions > button {
    padding: 8px 6px;
    font-size: 13px;
  }
  .answer-map-body {
    flex-direction: column;
  }
  .filter-sidebar {
    flex: 0 1 auto;
    width: 100%;
    max-height: 40dvh;
    padding-bottom: 0;
  }
  .answer-map-filter-toggle {
    display: none;
  }
  .map-status {
    font-size: 12px;
  }
}
</style>
