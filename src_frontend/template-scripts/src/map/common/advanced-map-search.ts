import analysisCss from "./advanced-map-analysis.css?inline";
import { createProgressDialog, awaitWithAbort } from "./progress-spinner";
import { createColoringEditor, action, node } from "./coloring-editor";
import { createMapPresetDialogs } from "./map-preset-dialog";
import { createMapMessageDialog } from "./map-message-dialog";
import { evaluateMapAnalysis, mapFilterPath, mapOperationMessages } from "./map-analysis";
import { cloneSavedMapPreset, toV2PresetDraft, type SavedMapPreset } from "./answer-map-presets";
import { presetReferences, type LocalPresetData } from "./local-preset";
import { PresetPageReads } from "./preset-page-reads";
import type { AiDefinition } from "../../ai/types";
import { createAiConditionEditor, validateAiDefinitionFields } from "./ai-condition-editor";
import type { AnswerColorSpecification, AnswerColoring, AnswerField } from "./answer-coloring";
/** Vue の地図ページと、単独で開く全画面の地図で共有する。 */
export interface AttributeCondition {
  field_id: string;
  field_type: string;
  op: string;
  value?: unknown;
  upper?: unknown;
}
export interface AttributeSearchRequest {
  common_form_id: string;
  definition_version: number;
  layer_ids: string[] | null;
  conditions: AttributeCondition[];
  use_map_filter?: boolean;
  targets?: { target_type: "marker" | "shape"; id: string }[];
}
export interface AttributeSearchResult {
  common_form_id: string;
  definition_version: number;
  as_of: string;
  marker_ids: string[];
  shape_ids: string[];
  target_count: number;
  coloring?: AnswerColoring | null;
}
interface Field {
  id: string;
  label: string;
  type: string;
  choices?: string[];
}
interface CommonForm {
  id: string;
  version: number;
  form_title: string;
  form_schema: { fields: Field[] };
}
export type AttributeTransport = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
  method?: "DELETE",
  expectedAccountId?: string,
) => Promise<unknown>;
export const attributeSearchPath = "/map-objects/search/attributes";
const supported = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "image",
]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function attributeOperations(type: string): [string, string][] {
  const common: [string, string][] = [
    ["filled", "入力あり"],
    ["empty", "未入力"],
    ["missing", "項目なし"],
  ];
  if (type === "number" || type === "date")
    return [
      ["eq", "等しい"],
      ["gte", type === "date" ? "以降" : "以上"],
      ["lte", type === "date" ? "以前" : "以下"],
      ["between", "範囲"],
      ...common,
    ];
  if (type === "select" || type === "radio") return [["in", "選択値のいずれか"], ...common];
  if (type === "checkbox") return [["eq", "等しい"], ...common];
  if (type === "image") return common;
  return [["contains", "含む"], ["eq", "完全一致"], ...common];
}

export function validateAttributeResult(
  value: unknown,
  request: AttributeSearchRequest,
): AttributeSearchResult {
  const r = value as AttributeSearchResult;
  if (
    !r ||
    r.common_form_id !== request.common_form_id ||
    r.definition_version !== request.definition_version ||
    typeof r.as_of !== "string" ||
    !Array.isArray(r.marker_ids) ||
    !Array.isArray(r.shape_ids) ||
    [...r.marker_ids, ...r.shape_ids].some((id) => typeof id !== "string" || !id) ||
    new Set(r.marker_ids).size !== r.marker_ids.length ||
    new Set(r.shape_ids).size !== r.shape_ids.length ||
    r.target_count !== r.marker_ids.length + r.shape_ids.length
  )
    throw Error("検索結果を確認できませんでした。");
  return r;
}

/** テンプレートページには Cookie 認証を使い、Vue 側からは既存の Axios アダプターを渡す。 */
export const attributeTransport: AttributeTransport = async (
  path,
  body,
  signal,
  method,
  expectedAccountId,
) => {
  const init: RequestInit = {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(expectedAccountId !== undefined
      ? { headers: { "X-AI-Account-ID": expectedAccountId } }
      : {}),
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response = await fetch(path, init);
  if (response.status === 401) {
    const renewed = await fetch("/account/refresh", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (renewed.ok) response = await fetch(path, init);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (data?.code === "ai_account_changed" || data?.error === "ai_account_changed")
      throw Error("ai_account_changed");
    if (response.status === 409)
      throw Error("共通フォームが変更されました。開き直して条件を確認してください。");
    if (response.status === 404)
      throw Error("共通フォームまたはレイヤーが見つかりません。開き直してください。");
    if (response.status === 401) throw Error("再ログインしてください。");
    throw Error(
      data?.error?.replace(/^validation error:\s*/, "") || "検索結果を取得できませんでした。",
    );
  }
  return response.status === 204 ? null : response.json();
};

interface ModalOptions {
  transport: AttributeTransport;
  getApplied(): AttributeSearchRequest | null;
  hasAppliedPresetFilter?(): boolean;
  getLayerIds(): string[] | null;
  getContext(): string;
  /** AI条件は手動検索の再評価世代と分け、アカウント・レイヤー・読込対象を固定する。 */
  getAiContextKey?(): string;
  getPresetData?(): LocalPresetData;
  savedFilters?: boolean;
  applyAiDefinition?(definition: AiDefinition, signal: AbortSignal): Promise<void>;
  clearAiDefinition?(kind: "filter" | "color", signal: AbortSignal): Promise<void>;
  onApply(
    request: AttributeSearchRequest | null,
    result: AttributeSearchResult | null,
    signal?: AbortSignal,
  ): void | Promise<void>;
  analysis?: {
    getSpecification(): AnswerColorSpecification | null;
    getColoring(): AnswerColoring | null;
    apply(
      specification: AnswerColorSpecification | null,
      coloring: AnswerColoring | null,
      signal?: AbortSignal,
    ): Promise<void>;
  };
}

export function createAdvancedMapSearchModal(options: ModalOptions) {
  const dialog = document.createElement("dialog");
  const title = options.analysis ? "詳しい検索と色分け" : "詳しい検索";
  dialog.className = options.analysis ? "advanced-map-search has-analysis" : "advanced-map-search";
  dialog.setAttribute("aria-label", title);
  const styleId = "advanced-map-search-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    // テンプレートページでは Vue の全体用 CSS を読み込まないため、ここでも操作部品を定義する。
    // github.css が body の最後の子要素の余白を上書きするため、auto の余白を使わず中央に配置する。
    style.textContent = `
      .advanced-map-search {
        box-sizing: border-box;
        position: fixed;
        top: 50%;
        left: 50%;
        right: auto;
        bottom: auto;
        transform: translate(-50%, -50%);
        width: min(920px, calc(100% - 32px));
        height: fit-content;
        max-height: calc(100dvh - 32px);
        overflow: auto;
        margin: 0;
        border: 1px solid #aaa;
        border-radius: 10px;
        padding: 20px;
        background: whitesmoke;
        color: #222;
        font: 16px/1.4 sans-serif;
        text-align: left;
      }
      .advanced-map-search::backdrop { background: #0008; }
      .advanced-map-search *, .advanced-map-search *::before, .advanced-map-search *::after {
        box-sizing: border-box;
      }
      .advanced-map-search header, .advanced-map-search footer {
        display: flex;
        align-items: center;
        gap: 12px;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .advanced-map-search h2 { margin: 0; border-bottom: 0; font-size: 24px; font-weight: 700; }
      .advanced-map-search p { margin: 16px 0; }
      .advanced-map-search label {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
        margin: 0;
        font-weight: 400;
      }
      .advanced-map-search select, .advanced-map-search input, .advanced-map-search button {
        font: inherit;
        padding: 8px;
        margin: 0;
        max-width: 100%;
      }
      .advanced-map-search select, .advanced-map-search input {
        font-weight: 400;
        min-width: 0;
        border: 1px solid #767676;
        border-radius: 6px;
        background: white;
        color: #222;
      }
      .advanced-map-search input[type="checkbox"] { padding: 0; flex-shrink: 0; }
      .advanced-map-search button {
        border: 1px solid transparent;
        border-radius: 8px;
        background: #5f5f5f;
        color: white;
        font-weight: 500;
        box-shadow: 0 2px 2px #0003;
        transition: border-color 0.25s;
        cursor: pointer;
      }
      .advanced-map-search button:hover { border-color: #396cd8; }
      .advanced-map-search button:active { background: #e8e8e8; color: #222; }
      .advanced-map-search .attribute-conditions {
        display: grid;
        gap: 16px;
        margin: 16px 0;
      }
      .advanced-map-search .attribute-conditions > button { justify-self: start; }
      .advanced-map-search .attribute-row {
        display: grid;
        grid-template-columns: 2fr 1.4fr 2fr auto;
        gap: 10px;
        padding: 12px 0;
        border-bottom: 1px solid #ccc;
        align-items: start;
      }
      .advanced-map-search .attribute-row select:not([multiple]),
      .advanced-map-search .attribute-row input:not([type="checkbox"]) {
        height: calc(1.4em + 18px);
        line-height: 1.4;
      }
      .advanced-map-search .attribute-row select[multiple] {
        min-height: 64px;
        line-height: 1.4;
      }
      .advanced-map-search .attribute-row > button {
        align-self: end;
        margin: 0;
        box-shadow: none;
      }
      .advanced-map-search .attribute-values { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .advanced-map-search footer { margin-top: 18px; }
      .advanced-map-search .attribute-error { color: #b42318; white-space: pre-wrap; }
      .advanced-map-search .attribute-submit { background: #2165bb; border-color: #2165bb; }
      .advanced-map-search button:disabled { cursor: wait; opacity: .6; }
      @media (max-width: 650px) {
        .advanced-map-search .attribute-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        .advanced-map-search .attribute-values { grid-column: 1 / -1; }
      }
    `;
    style.textContent += analysisCss;
    document.head.append(style);
  }
  document.body.append(dialog);
  const progress = createProgressDialog();
  const completion = createMapMessageDialog();
  let forms: CommonForm[] = [],
    formId = "",
    conditions: AttributeCondition[] = [];
  let sequence = 0,
    controller: AbortController | undefined,
    searchTimer: ReturnType<typeof setTimeout> | undefined,
    trigger: HTMLElement | null = null,
    busy = false,
    disposed = false;
  let status: HTMLParagraphElement;
  let coloringBusy = false;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, click: () => void, focusKey = text) => {
    const b = element("button", text);
    b.type = "button";
    b.dataset.focusKey = focusKey;
    b.addEventListener("click", click);
    return b;
  };
  const analysisHost = node("section");
  analysisHost.className = "attribute-color-pane";
  const legacyAnalysisHost = node("div");
  analysisHost.append(legacyAnalysisHost);
  type AiKind = "filter" | "coloring";
  type AiDraft = {
    editor: ReturnType<typeof createAiConditionEditor>;
    reloadMetadata(page?: PresetPage): Promise<void>;
    host: HTMLElement;
    name: string;
    message: string;
    error: boolean;
    waiting?: boolean;
    retryData?: boolean;
    page?: PresetPage;
    preparation?: { data: LocalPresetData; controller: AbortController; read: Promise<void> };
  };
  const aiDrafts: Partial<Record<AiKind, AiDraft>> = {};
  const aiStatuses: Partial<Record<AiKind, HTMLParagraphElement>> = {};
  const clearAiDraft = (kind: AiKind) => {
    const page = aiDrafts[kind]?.page;
    aiDrafts[kind]?.preparation?.controller.abort();
    aiDrafts[kind]?.editor.dispose();
    delete aiDrafts[kind];
    delete aiStatuses[kind];
    if (page?.source.aborted) cancelUnusedPage(page);
  };
  const clearAiDrafts = () => {
    clearAiDraft("filter");
    clearAiDraft("coloring");
  };
  const aiMessage = (kind: AiKind, message: string, failed = false) => {
    const draft = aiDrafts[kind];
    if (draft) {
      draft.message = message;
      draft.error = failed;
    }
    const output = aiStatuses[kind];
    if (output) {
      output.textContent = message;
      output.className =
        kind === "coloring"
          ? failed
            ? "color-error"
            : "color-help"
          : failed
            ? "attribute-error"
            : "attribute-status";
      output.setAttribute("role", failed ? "alert" : "status");
    }
  };
  type MapOptions = { forms?: { id: string; label: string }[]; fields: AnswerField[] };
  const aiContextKey = () => options.getAiContextKey?.() ?? options.getContext();
  let metadataContext: string | undefined;
  let cachedForms: CommonForm[] | undefined;
  const cachedOptions = new Map<string | null, MapOptions>();
  const formReads = new PresetPageReads<CommonForm[]>();
  const optionReads = new PresetPageReads<MapOptions>();
  function resetMetadata() {
    cachedForms = undefined;
    cachedOptions.clear();
    formReads.clear();
    optionReads.clear();
  }
  function checkMetadataContext() {
    const key = aiContextKey();
    if (key !== metadataContext) {
      metadataContext = key;
      resetMetadata();
    }
    return key;
  }
  async function readForms(signal: AbortSignal): Promise<CommonForm[]> {
    const key = checkMetadataContext();
    signal.throwIfAborted();
    if (cachedForms) return cachedForms;
    return formReads.get("forms", signal, async (request) => {
      const value = await options.transport("/common-forms", undefined, request);
      request.throwIfAborted();
      if (key !== aiContextKey())
        throw new DOMException("地図の対象が変わりました。", "AbortError");
      if (
        !Array.isArray(value) ||
        value.some(
          (form) => !form || typeof form.id !== "string" || typeof form.form_title !== "string",
        )
      )
        throw Error("共通フォームを取得できませんでした。");
      return (cachedForms = value);
    });
  }
  async function readOptions(id: string | null, signal: AbortSignal): Promise<MapOptions> {
    const key = checkMetadataContext();
    signal.throwIfAborted();
    const cached = cachedOptions.get(id);
    if (cached) return cached;
    return optionReads.get(id ?? "", signal, async (request) => {
      const data = (await options.transport(
        mapFilterPath,
        {
          query: { mode: "latest" },
          scope: { kind: "layers", layer_ids: options.getLayerIds() },
          common_form_id: id,
          conditions: [],
          options_only: true,
        },
        request,
      )) as MapOptions;
      request.throwIfAborted();
      if (key !== aiContextKey())
        throw new DOMException("地図の対象が変わりました。", "AbortError");
      if (
        !data ||
        typeof data !== "object" ||
        (id &&
          (!Array.isArray(data.fields) ||
            data.fields.some(
              (field) =>
                !field ||
                typeof field.id !== "string" ||
                typeof field.label !== "string" ||
                typeof field.field_type !== "string" ||
                !Array.isArray(field.choices) ||
                field.choices.some((choice) => typeof choice !== "string"),
            )))
      )
        throw Error("入力項目を取得できませんでした。");
      cachedOptions.set(id, data);
      return data;
    });
  }
  const loadFields = async (id: string, signal: AbortSignal) =>
    (await readOptions(id, signal)).fields;
  const presets =
    options.analysis || options.savedFilters
      ? createMapPresetDialogs(options.transport, restorePreset, {
          filterOnly: !options.analysis,
          apply: options.applyAiDefinition ? applySavedPreset : undefined,
          preparePage: preparePresetPage,
        })
      : undefined;
  const coloringEditor = options.analysis
    ? createColoringEditor(legacyAnalysisHost, {
        collapsible: false,
        forms: () => forms.map((f) => ({ id: f.id, label: f.form_title })),
        requiredForm: () => options.getApplied()?.common_form_id || "",
        loadFields,
        active: () => !!options.analysis!.getColoring(),
        disabled: () => busy || !dialog.open,
        save: (value) => {
          presets!.save({ kind: "coloring", definition: value });
        },
        apply: async (specification) => {
          coloringBusy = true;
          const current = sequence,
            context = options.getContext();
          const job = new AbortController();
          controller?.abort();
          controller = job;
          const timeout = setTimeout(() => job.abort(), 60000);
          const finishProgress = progress.show("色分けを反映しています");
          try {
            const applied = options.getApplied();
            const result = specification
              ? await awaitWithAbort(
                  evaluateMapAnalysis(
                    options.transport,
                    applied
                      ? {
                          common_form_id: applied.common_form_id,
                          conditions: applied.conditions as unknown as Record<string, unknown>[],
                        }
                      : null,
                    specification,
                    options.getLayerIds(),
                    job.signal,
                  ),
                  job.signal,
                )
              : { coloring: null };
            if (
              disposed ||
              job.signal.aborted ||
              current !== sequence ||
              !dialog.open ||
              context !== options.getContext()
            )
              throw Error("地図データが更新されました。もう一度実行してください。");
            await awaitWithAbort(
              options.analysis!.apply(specification, result.coloring, job.signal),
              job.signal,
            );
            refreshDraft("filter");
          } finally {
            coloringBusy = false;
            clearTimeout(timeout);
            finishProgress();
          }
          if (
            !disposed &&
            !job.signal.aborted &&
            current === sequence &&
            dialog.open &&
            specification
          )
            completion.show(mapOperationMessages.coloring, "色分け完了", () =>
              dialog.querySelector<HTMLElement>(".color-submit")?.focus(),
            );
        },
      })
    : undefined;
  const fieldList = () =>
    forms.find((f) => f.id === formId)?.form_schema.fields.filter((f) => supported.has(f.type)) ||
    [];
  const cancel = () => {
    ++sequence;
    clearTimeout(searchTimer);
    searchTimer = undefined;
    controller?.abort();
    busy = false;
    progress.clear();
  };
  const close = () => {
    cancel();
    formReads.clear();
    optionReads.clear();
    for (const job of pageJobs) job.abort();
    currentPage = undefined;
    clearAiDrafts();
    completion.close(false);
    presets?.close();
    if (dialog.open) {
      dialog.close();
      trigger?.focus();
    }
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const error = (message: string) => {
    status.textContent = message;
    status.className = "attribute-error";
  };
  const assertAiRequest = (
    seq: number,
    context: string,
    signal: AbortSignal,
    key = options.getContext,
  ) => {
    if (disposed || signal.aborted || !dialog.open || sequence !== seq)
      throw new DOMException("処理を中止しました。", "AbortError");
    if (context !== key())
      throw Error("地図の対象が変わりました。現在の地図で条件を確認してください。");
  };
  function requiredDefinitions(definition: AiDefinition, clear = false) {
    // 手動の絞り込みを置き換えるときは、併用中の手動色分けも全地物で再判定する。
    const colors =
      definition.type === "filter" && options.getApplied()
        ? options.analysis?.getSpecification()
        : null;
    const definitions = clear ? [] : [definition];
    if (colors)
      definitions.push(toV2PresetDraft({ kind: "coloring", definition: colors }).definition);
    return definitions;
  }
  type PresetPage = {
    items: SavedMapPreset[];
    key: string;
    source: AbortSignal;
    job: AbortController;
    finished: boolean;
    replacement?: Promise<void>;
    forms: Promise<CommonForm[]>;
    fields: Map<string | null, Promise<MapOptions>>;
    values: Promise<void>;
  };
  let currentPage: PresetPage | undefined;
  // 選択時に一覧を閉じても、既に開始した読み込みは下書きが引き継ぐ。
  const pageJobs = new Set<AbortController>();
  function cancelUnusedPage(page: PresetPage) {
    if (!Object.values(aiDrafts).some((draft) => draft.page === page)) page.job.abort();
  }
  async function preparePresetPage(items: SavedMapPreset[], signal: AbortSignal) {
    if (disposed) return;
    signal.throwIfAborted();
    const eligible = items.filter((item) => options.analysis || item.kind === "filter");
    const key = checkMetadataContext();
    if (!eligible.length) return;
    const definitions = eligible.flatMap((item) => requiredDefinitions(item.definition));
    const ids = new Set<string | null>(presetReferences(definitions).keys());
    if (!dialog.open && options.analysis) {
      // AIの一覧から初めて検索画面を開く場合は、併用中の手動設定も表示する。
      ids.add(null);
      const applied = options.getApplied()?.common_form_id;
      const coloring = options.analysis.getSpecification()?.common_form_id;
      if (applied) ids.add(applied);
      if (coloring) ids.add(coloring);
    }
    const data = options.getPresetData?.();
    const missing = data && !data.ready(definitions);
    const job = new AbortController();
    pageJobs.add(job);
    const fields = new Map<string | null, Promise<MapOptions>>();
    // 多数のフォームを含むページでも、同時にすべてのリクエストを送らない。
    const lanes = Array.from({ length: 4 }, () => Promise.resolve());
    for (const id of ids) {
      const lane = fields.size % lanes.length;
      const read = lanes[lane]!.then(() => {
        if (aiContextKey() !== key)
          throw new DOMException("地図の対象が変わりました。", "AbortError");
        return readOptions(id, job.signal);
      });
      fields.set(id, read);
      lanes[lane] = read.then(
        () => {},
        () => {},
      );
    }
    const page: PresetPage = {
      items: eligible,
      key,
      source: signal,
      job,
      fields,
      finished: false,
      forms: readForms(job.signal),
      values: missing ? data.prepare(definitions, job.signal) : Promise.resolve(),
    };
    const abort = () => cancelUnusedPage(page);
    signal.addEventListener("abort", abort, { once: true });
    currentPage = page;
    try {
      const results = await Promise.allSettled([page.forms, page.values, ...fields.values()]);
      if (page.replacement) return page.replacement;
      job.signal.throwIfAborted();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      page.finished = true;
      signal.removeEventListener("abort", abort);
      pageJobs.delete(job);
    }
  }
  function pageFor(preset: SavedMapPreset) {
    if (!currentPage?.items.some((item) => item.id === preset.id)) return;
    if (currentPage.key !== aiContextKey() || currentPage.job.signal.aborted)
      throw Error("地図の対象が変わりました。一覧を閉じて開き直してください。");
    return currentPage;
  }
  function openingOptions(page: PresetPage | undefined, id: string | null, signal: AbortSignal) {
    if (!page) return readOptions(id, signal);
    const read = page.fields.get(id);
    if (!read) throw Error("手動の条件が変更されました。一覧を閉じて開き直してください。");
    return read;
  }
  async function applySavedPreset(preset: SavedMapPreset, outerSignal: AbortSignal) {
    if (busy || coloringBusy) throw Error("現在の処理が完了してから適用してください。");
    if (preset.kind === "coloring" && !options.analysis)
      throw Error("この画面では色分け条件を適用できません。");
    const apply = options.applyAiDefinition;
    if (!apply) throw Error("この画面では保存条件の直接適用に対応していません。");
    outerSignal.throwIfAborted();
    const page = pageFor(preset);
    const definitions = requiredDefinitions(preset.definition);
    const data = options.getPresetData?.();
    const seq = ++sequence;
    const context = aiContextKey();
    controller?.abort();
    const job = new AbortController();
    controller = job;
    const signal = job.signal;
    const abort = () => job.abort();
    outerSignal.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => assertAiRequest(seq, context, signal, aiContextKey);
    const reuse = <T>(prefetched: Promise<T> | undefined, load: () => Promise<T>) =>
      prefetched
        ? prefetched.catch(() => {
            assertCurrent();
            return load();
          })
        : load();
    const prepareValues = async () => {
      if (!data || data.ready(definitions)) return;
      await page?.values.catch(assertCurrent);
      assertCurrent();
      if (!data.ready(definitions)) await data.prepare(definitions, signal);
    };
    busy = true;
    try {
      assertCurrent();
      const [, fields] = await awaitWithAbort(
        Promise.all([
          reuse(page?.forms, () => readForms(signal)),
          Promise.all(
            [...presetReferences([preset.definition]).keys()].map(async (id) => {
              const metadata = await reuse(page?.fields.get(id), () => readOptions(id, signal));
              return [id, metadata.fields] as const;
            }),
          ),
          prepareValues(),
        ]),
        signal,
      );
      assertCurrent();
      const candidates = new Map(fields);
      const definition = validateAiDefinitionFields(
        preset.definition,
        (id) => candidates.get(id) ?? [],
        preset.display,
      );
      await awaitWithAbort(apply(definition, signal), signal);
      assertCurrent();
    } finally {
      outerSignal.removeEventListener("abort", abort);
      if (controller === job) controller = undefined;
      if (seq === sequence) busy = false;
    }
    if (!aiDrafts.filter && options.analysis) updateFilterStatus();
    if (!aiDrafts.coloring) coloringEditor?.refreshDisplay();
  }
  async function prepareDraft(kind: AiKind, signal?: AbortSignal) {
    const draft = aiDrafts[kind];
    if (!draft || !options.getPresetData) return;
    const data = options.getPresetData();
    const definitions = requiredDefinitions(draft.editor.getDraftDefinition());
    if (data.ready(definitions)) return;
    if (draft.preparation?.data === data) {
      await draft.preparation.read;
      if (draft === aiDrafts[kind] && !signal?.aborted) await prepareDraft(kind, signal);
      return;
    }
    draft.preparation?.controller.abort();
    const job = new AbortController();
    const abort = () => job.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) job.abort();
    try {
      aiMessage(kind, "判定に必要な登録データを読み込んでいます…");
      const read = data.prepare(definitions, job.signal);
      draft.preparation = { data, controller: job, read };
      await read;
      if (job.signal.aborted || options.getPresetData() !== data)
        throw new DOMException("対象が変更されました。", "AbortError");
      aiMessage(kind, "実行ボタンで地図に反映します。");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (draft.preparation?.controller === job) {
        draft.preparation = undefined;
      }
    }
  }
  function refreshDraft(kind: AiKind) {
    const draft = aiDrafts[kind];
    if (!draft) return;
    void prepareDraft(kind).catch((e) => {
      if (draft === aiDrafts[kind] && !(e instanceof DOMException && e.name === "AbortError"))
        aiMessage(
          kind,
          e instanceof Error ? e.message : "登録データを取得できませんでした。",
          true,
        );
    });
  }
  async function restorePreset(preset: SavedMapPreset, signal: AbortSignal) {
    if (busy || coloringBusy) throw Error("現在の処理が完了してから呼び出してください。");
    const saved = cloneSavedMapPreset(preset);
    if (saved.kind === "coloring" && !options.analysis)
      throw Error("この画面では色分け条件を呼び出せません。");
    const page = pageFor(saved);
    let initial = page;
    const host = node("div");
    const editor = createAiConditionEditor(host, {
      definition: saved.definition,
      display: saved.display,
      getForms: (signal) => initial?.forms ?? readForms(signal),
      getFields: (id, signal) => initial?.fields.get(id) ?? readOptions(id, signal),
      onChange: () => {
        const draft = aiDrafts[saved.kind];
        const wasWaiting = draft?.waiting || draft?.retryData;
        if (draft) {
          const previous = draft.page;
          draft.page = undefined;
          draft.waiting = false;
          draft.retryData = false;
          if (previous?.source.aborted) cancelUnusedPage(previous);
        }
        aiMessage(saved.kind, "編集中です。実行ボタンで地図に反映します。");
        refreshDraft(saved.kind);
        if (wasWaiting) render();
      },
      onClear: options.clearAiDefinition ? () => void executeAiDraft(saved.kind, true) : undefined,
    });
    clearAiDraft(saved.kind);
    const reloadMetadata = (source?: PresetPage) => {
      initial = source;
      return editor.refreshMetadata().finally(() => {
        if (initial === source) initial = undefined;
      });
    };
    aiDrafts[saved.kind] = {
      editor,
      reloadMetadata,
      host,
      name: saved.name,
      message: "呼び出した条件は未反映です。内容を確認して実行してください。",
      error: false,
    };
    if (page) {
      const draft = aiDrafts[saved.kind]!;
      const data = options.getPresetData?.();
      draft.page = page;
      draft.waiting = !page.finished;
      aiMessage(saved.kind, "地図への適用に必要なデータを準備しています…");
      render();
      // 一覧で開始済みの通信を参照する。編集画面はその完了を待たずに表示する。
      const metadata = reloadMetadata(page);
      const values = data?.ready(requiredDefinitions(saved.definition))
        ? Promise.resolve()
        : page.values;
      void Promise.all([metadata, values])
        .then(() => {
          if (aiDrafts[saved.kind] === draft && draft.page === page)
            aiMessage(saved.kind, "実行ボタンで地図に反映します。");
        })
        .catch((e) => {
          if (aiDrafts[saved.kind] === draft && draft.page === page) {
            draft.retryData = true;
            aiMessage(
              saved.kind,
              e instanceof Error ? e.message : "登録データを取得できませんでした。",
              true,
            );
          }
        })
        .finally(() => {
          if (aiDrafts[saved.kind] !== draft || draft.page !== page) return;
          if (page.key !== aiContextKey()) {
            close();
            return;
          }
          draft.waiting = false;
          render();
        });
      return;
    }
    const seq = ++sequence,
      context = aiContextKey();
    controller?.abort();
    const job = new AbortController();
    controller = job;
    const abort = () => job.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) job.abort();
    const timer = setTimeout(abort, 60000);
    busy = true;
    render();
    try {
      await awaitWithAbort(
        Promise.all([editor.refreshMetadata(job.signal), prepareDraft(saved.kind, job.signal)]),
        job.signal,
      );
      assertAiRequest(seq, context, job.signal, aiContextKey);
    } catch (e) {
      if (context !== aiContextKey()) {
        if (aiDrafts[saved.kind]?.editor === editor) clearAiDraft(saved.kind);
        if (seq === sequence) close();
        throw e;
      }
      if (seq === sequence && dialog.open)
        aiMessage(
          saved.kind,
          e instanceof Error ? e.message : "項目情報を取得できませんでした。",
          true,
        );
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!disposed && seq === sequence) {
        busy = false;
        render();
      }
    }
  }
  async function executeAiDraft(kind: AiKind, clear = false) {
    if (busy || coloringBusy) return;
    const draft = aiDrafts[kind];
    if (!draft || (!clear && (draft.waiting || draft.retryData))) return;
    if (clear ? !options.clearAiDefinition : !options.applyAiDefinition) {
      aiMessage(
        kind,
        "この画面では複合条件の実行に対応していません。アプリを更新してください。",
        true,
      );
      return;
    }
    const seq = ++sequence,
      context = aiContextKey();
    controller?.abort();
    const job = new AbortController();
    controller = job;
    const timer = setTimeout(() => job.abort(), 180000);
    const finishProgress = progress.show("条件を地図へ反映しています");
    busy = true;
    render();
    aiMessage(kind, clear ? "条件を解除しています…" : "条件を確認しています…");
    try {
      if (!clear) {
        // 編集中に開始した取得の完了を待つ。ここでは通信を開始しない。
        await awaitWithAbort(draft.editor.whenMetadataReady(), job.signal);
        if (draft.preparation) await awaitWithAbort(draft.preparation.read, job.signal);
      }
      const data = options.getPresetData?.();
      if (data && !data.ready(requiredDefinitions(draft.editor.getDraftDefinition(), clear)))
        throw Error(
          "登録データの読み込み完了後に実行してください。取得に失敗した場合は条件を呼び出し直してください。",
        );
      if (clear) {
        // 下書きを書き換えず、適用済み状態の片側だけを既存の地図反映経路で解除する。
        await awaitWithAbort(
          options.clearAiDefinition!(kind === "filter" ? "filter" : "color", job.signal),
          job.signal,
        );
      } else {
        assertAiRequest(seq, context, job.signal, aiContextKey);
        const definition = draft.editor.getDefinition();
        await awaitWithAbort(options.applyAiDefinition!(definition, job.signal), job.signal);
      }
      assertAiRequest(seq, context, job.signal, aiContextKey);
      aiMessage(
        kind,
        clear
          ? "呼び出した条件の適用を解除しました。編集内容は保持しています。"
          : "条件を地図へ反映しました。",
      );
      finishProgress();
      if (!clear)
        completion.show(
          kind === "filter" ? mapOperationMessages.filter : mapOperationMessages.coloring,
          kind === "filter" ? "絞り込み完了" : "色分け完了",
          () => dialog.querySelector<HTMLElement>(`[data-focus-key="ai-${kind}-submit"]`)?.focus(),
        );
    } catch (e) {
      if (context !== aiContextKey()) {
        if (aiDrafts[kind] === draft) clearAiDraft(kind);
        if (seq === sequence) close();
        return;
      }
      if (!disposed && seq === sequence && dialog.open)
        aiMessage(
          kind,
          job.signal.aborted
            ? "処理を中止しました。編集内容は保持しています。"
            : e instanceof Error
              ? e.message
              : "条件を反映できませんでした。",
          true,
        );
    } finally {
      clearTimeout(timer);
      finishProgress();
      if (!disposed && seq === sequence) {
        busy = false;
        render();
      }
    }
  }
  function renderAiPane(pane: HTMLElement, kind: AiKind) {
    const draft = aiDrafts[kind]!;
    pane.append(element("p", `呼び出した条件：${draft.name}`), draft.host);
    const output = element("p");
    aiStatuses[kind] = output;
    aiMessage(kind, draft.message, draft.error);
    if (kind === "filter") pane.append(output);
    if (kind === "filter") status = output;
    const actions = element("footer");
    actions.className = kind === "filter" ? "attribute-filter-actions" : "ai-color-actions";
    const submit = button(
      kind === "filter" ? "絞り込み実行" : "色分け実行",
      () => void executeAiDraft(kind),
      `ai-${kind}-submit`,
    );
    submit.className = kind === "filter" ? "attribute-submit" : "color-submit";
    submit.disabled = !options.applyAiDefinition || !!draft.waiting || !!draft.retryData;
    actions.append(submit);
    if (draft.retryData) {
      actions.append(
        button("登録データの取得を再試行", async () => {
          draft.retryData = false;
          draft.waiting = true;
          render();
          try {
            await prepareDraft(kind);
            if (aiDrafts[kind] === draft) aiMessage(kind, "実行ボタンで地図に反映します。");
          } catch (e) {
            if (aiDrafts[kind] === draft) {
              draft.retryData = true;
              aiMessage(
                kind,
                e instanceof Error ? e.message : "登録データを取得できませんでした。",
                true,
              );
            }
          } finally {
            if (aiDrafts[kind] === draft) {
              draft.waiting = false;
              render();
            }
          }
        }),
      );
    }
    if (kind === "filter") {
      const clear = button("属性条件を解除", () => void executeAiDraft(kind, true));
      clear.disabled = !options.clearAiDefinition;
      actions.append(clear);
    }
    if (presets) {
      const save = button("検索条件を保存", () => {
        try {
          presets.save({ schema_version: 2, kind, definition: draft.editor.getDefinition() });
        } catch (e) {
          aiMessage(
            kind,
            e instanceof Error ? e.message : "保存する条件を確認してください。",
            true,
          );
        }
      });
      if (kind === "coloring") save.className = "color-save";
      actions.append(save);
    }
    if (kind === "coloring") {
      const wrapper = element("div");
      wrapper.className = "map-coloring-editor";
      wrapper.append(actions, output);
      pane.append(wrapper);
    } else pane.append(actions);
    const extra = element("details");
    extra.className = "ai-editor-extra";
    extra.append(
      element("summary", "その他の操作"),
      button(kind === "filter" ? "手動の絞り込み条件を編集" : "手動の色分け条件を編集", () => {
        clearAiDraft(kind);
        render();
      }),
      element("p", "手動設定への切り替えでは、地図に反映済みの条件は変わりません。"),
    );
    pane.append(extra);
    draft.editor.setDisabled(busy || coloringBusy);
  }
  const select = (
    choices: [string, string][],
    value: string,
    change: (value: string) => void,
    focusKey?: string,
  ) => {
    const s = element("select");
    if (focusKey) s.dataset.focusKey = focusKey;
    for (const [id, text] of choices) {
      const option = element("option", text);
      option.value = id;
      s.append(option);
    }
    s.value = value;
    s.addEventListener("change", () => change(s.value));
    return s;
  };
  const label = (text: string, control: HTMLElement) => {
    const l = element("label", text);
    l.append(control);
    return l;
  };
  const reset = (c: AttributeCondition, field: Field) => {
    c.field_id = field.id;
    c.field_type = field.type;
    c.op = attributeOperations(field.type)[0]![0];
    c.value =
      field.type === "checkbox"
        ? true
        : field.type === "select" || field.type === "radio"
          ? []
          : "";
    delete c.upper;
  };
  const clearFilter = (notify = false) => {
    if (busy) return;
    const current = ++sequence;
    controller?.abort();
    controller = new AbortController();
    const requestController = controller;
    const timer = setTimeout(() => requestController.abort(), 60000);
    searchTimer = timer;
    const finishProgress = progress.show("検索結果を反映しています");
    const finish = () => {
      clearTimeout(timer);
      finishProgress();
      if (searchTimer === timer) searchTimer = undefined;
    };
    const clear = () => {
      finish();
      if (current !== sequence || !dialog.open) return;
      busy = false;
      formId = "";
      conditions = [];
      render("属性条件を解除");
      status.textContent = "属性条件を解除しました。";
      if (notify)
        completion.show(mapOperationMessages.filter, "絞り込み完了", () =>
          dialog.querySelector<HTMLElement>(".attribute-submit")?.focus(),
        );
    };
    try {
      const applied = options.analysis
        ? options.onApply(null, null, controller.signal)
        : options.onApply(null, null);
      if (applied && typeof applied.then === "function") {
        busy = true;
        render();
        void awaitWithAbort(applied, requestController.signal)
          .then(clear)
          .catch((e) => {
            finish();
            if (current !== sequence || !dialog.open) return;
            busy = false;
            render();
            error((e as Error).message);
          });
      } else clear();
    } catch (e) {
      finish();
      error((e as Error).message);
    }
  };
  const search = async () => {
    if (busy) return;
    const form = forms.find((f) => f.id === formId);
    if (!form && !conditions.length && (options.analysis || (options.savedFilters && !formId))) {
      clearFilter(true);
      return;
    }
    if (!form) {
      error("共通フォームを選択してください。");
      return;
    }
    for (const c of conditions) {
      const f = fieldList().find((f) => f.id === c.field_id && f.type === c.field_type);
      if (!f || !attributeOperations(f.type).some(([op]) => op === c.op)) {
        error("共通フォームが変更されています。条件を選び直してください。");
        return;
      }
      if (
        c.op === "in" &&
        (!Array.isArray(c.value) ||
          c.value.some((value) => typeof value !== "string" || !f.choices?.includes(value)))
      ) {
        error("現在の選択肢にない値があります。該当する値の選択を解除して選び直してください。");
        return;
      }
      if (
        !["filled", "empty", "missing"].includes(c.op) &&
        (c.value === "" ||
          c.value == null ||
          (Array.isArray(c.value) && !c.value.length) ||
          (c.op === "between" && !String(c.upper ?? "").trim()))
      ) {
        error("検索する値を入力してください。");
        return;
      }
    }
    const request: AttributeSearchRequest = {
      common_form_id: form.id,
      definition_version: form.version,
      layer_ids: options.getLayerIds(),
      conditions: clone(conditions),
      ...(options.analysis ? { use_map_filter: true } : {}),
    };
    const seq = ++sequence,
      context = options.getContext();
    clearTimeout(searchTimer);
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    busy = true;
    render();
    status.textContent = "検索中…";
    const timer = setTimeout(() => requestController.abort(), 60000);
    searchTimer = timer;
    const finishProgress = progress.show("検索結果を反映しています");
    try {
      const result = validateAttributeResult(
        await awaitWithAbort(
          options.analysis
            ? searchMapAttributes(
                options.transport,
                request,
                options.analysis.getSpecification(),
                requestController.signal,
              )
            : options.transport(attributeSearchPath, request, requestController.signal),
          requestController.signal,
        ),
        request,
      );
      if (disposed || seq !== sequence || !dialog.open) return;
      if (context !== options.getContext()) {
        error("地図データが更新されました。もう一度検索してください。");
        return;
      }
      await awaitWithAbort(
        Promise.resolve(
          options.analysis
            ? options.onApply(request, result, requestController.signal)
            : options.onApply(request, result),
        ),
        requestController.signal,
      );
      if (disposed || seq !== sequence || !dialog.open) return;
      status.textContent = `属性条件のみの一致件数：${result.target_count}件`;
      finishProgress();
      completion.show(mapOperationMessages.filter, "絞り込み完了", () =>
        dialog.querySelector<HTMLElement>(".attribute-submit")?.focus(),
      );
    } catch (e) {
      if (!disposed && seq === sequence && dialog.open)
        error(e instanceof Error ? e.message : "検索に失敗しました。");
    } finally {
      clearTimeout(timer);
      finishProgress();
      if (searchTimer === timer) searchTimer = undefined;
      if (seq === sequence) {
        busy = false;
        coloringEditor?.refresh();
        dialog.setAttribute("aria-busy", "false");
        dialog
          .querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("[data-busy]")
          .forEach((b) => (b.disabled = b.dataset.busy === "true"));
      }
    }
  };
  function updateFilterStatus() {
    status.className = "attribute-status";
    status.textContent = options.getApplied()
      ? "検索条件を適用中です。編集後は「絞り込み実行」で反映します。"
      : options.hasAppliedPresetFilter?.()
        ? "絞り込み条件を適用中です。"
        : "検索条件は未適用です。";
  }
  function render(focusKey?: string) {
    const active = document.activeElement;
    if (!focusKey && active instanceof HTMLElement && dialog.contains(active))
      focusKey = active.dataset.focusKey;
    dialog.setAttribute("aria-busy", String(busy));
    dialog.replaceChildren();
    const header = element("header");
    header.append(element("h2", title), button("閉じる", close));
    header.className = "attribute-header";
    if (presets)
      header.insertBefore(
        action("保存した検索条件", () => presets.list()),
        header.lastElementChild,
      );
    dialog.append(header);
    const filterPane = options.analysis ? element("section") : dialog;
    if (options.analysis) {
      filterPane.className = "attribute-filter-pane";
      const workspace = element("div");
      workspace.className = "attribute-workspace";
      workspace.append(filterPane, analysisHost);
      dialog.append(workspace);
      filterPane.append(element("h3", "地図上で絞り込み"));
    }
    if (aiDrafts.filter) renderAiPane(filterPane, "filter");
    else {
      filterPane.append(
        element(
          "p",
          "対象・共通フォームごとの最新登録データを検索します。複数条件はすべて一致する登録が対象です。",
        ),
      );
      const formSelect = select(
        [["", "共通フォームを選択"], ...forms.map((f) => [f.id, f.form_title] as [string, string])],
        formId,
        (value) => {
          formId = value;
          conditions = [];
          render();
          if (options.analysis && value) {
            const current = ++sequence;
            controller?.abort();
            controller = new AbortController();
            busy = true;
            render();
            void loadFields(value, controller.signal)
              .then((fields) => {
                if (current !== sequence || !dialog.open) return;
                const form = forms.find((f) => f.id === value);
                if (form)
                  form.form_schema.fields = fields.map((f) => ({
                    id: f.id,
                    label: f.label,
                    type: f.field_type,
                    choices: f.choices,
                  }));
                busy = false;
                render();
              })
              .catch((e) => {
                if (current === sequence && dialog.open) {
                  busy = false;
                  render();
                  error((e as Error).message);
                }
              });
          }
        },
        "form",
      );
      filterPane.append(label("共通フォーム", formSelect));
      if (!forms.length && !busy) filterPane.append(element("p", "共通フォームはありません。"));
      const conditionList = element("div");
      conditionList.className = "attribute-conditions";
      conditions.forEach((c, index) => {
        const fields = fieldList(),
          field = fields.find((f) => f.id === c.field_id && f.type === c.field_type);
        const row = element("div");
        row.className = "attribute-row";
        row.append(
          label(
            "属性",
            select(
              fields.map((f) => [`${f.id}:${f.type}`, f.label]),
              `${c.field_id}:${c.field_type}`,
              (value) => {
                const f = fields.find((f) => `${f.id}:${f.type}` === value);
                if (f) reset(c, f);
                render();
              },
              `field-${index}`,
            ),
          ),
        );
        row.append(
          label(
            "比較方法",
            select(
              attributeOperations(c.field_type),
              c.op,
              (value) => {
                c.op = value;
                render();
              },
              `operator-${index}`,
            ),
          ),
        );
        const values = element("div");
        values.className = "attribute-values";
        if (!["filled", "empty", "missing"].includes(c.op)) {
          if (c.field_type === "select" || c.field_type === "radio") {
            const currentChoices = field?.choices || [];
            const savedChoices = Array.isArray(c.value)
              ? c.value.filter((value): value is string => typeof value === "string")
              : [];
            const choices = element("select");
            choices.multiple = true;
            choices.dataset.focusKey = `choices-${index}`;
            const validateChoices = () =>
              choices.setAttribute(
                "aria-invalid",
                String([...choices.selectedOptions].some((o) => !currentChoices.includes(o.value))),
              );
            for (const choice of new Set([...currentChoices, ...savedChoices])) {
              const retired = !currentChoices.includes(choice);
              const option = element(
                "option",
                retired ? `${choice}（現在の選択肢にありません）` : choice,
              );
              option.value = choice;
              option.selected = savedChoices.includes(choice);
              choices.append(option);
            }
            choices.addEventListener("change", () => {
              c.value = [...choices.selectedOptions].map((o) => o.value);
              validateChoices();
            });
            validateChoices();
            values.append(label("値（複数選択可）", choices));
          } else if (c.field_type === "checkbox")
            values.append(
              label(
                "値",
                select(
                  [
                    ["true", "はい"],
                    ["false", "いいえ"],
                  ],
                  String(c.value),
                  (value) => (c.value = value === "true"),
                  `value-${index}`,
                ),
              ),
            );
          else {
            const input = (upper: boolean) => {
              const i = element("input");
              i.type =
                c.field_type === "date" ? "date" : c.field_type === "number" ? "number" : "text";
              i.step = "any";
              i.dataset.focusKey = `value-${index}-${upper ? "upper" : "lower"}`;
              i.value = String((upper ? c.upper : c.value) ?? "");
              i.addEventListener("input", () => {
                if (upper) c.upper = i.value;
                else c.value = i.value;
              });
              return i;
            };
            values.append(label(c.op === "between" ? "開始値" : "値", input(false)));
            if (c.op === "between") values.append(label("終了値", input(true)));
          }
        }
        row.append(
          values,
          button(
            "削除",
            () => {
              conditions.splice(index, 1);
              render("条件を追加");
            },
            `remove-${index}`,
          ),
        );
        conditionList.append(row);
      });
      const add = button("条件を追加", () => {
        const field = fieldList()[0];
        if (field && conditions.length < 10) {
          const c = {} as AttributeCondition;
          reset(c, field);
          conditions.push(c);
          render(`field-${conditions.length - 1}`);
        }
      });
      add.disabled = !fieldList().length || conditions.length >= 10;
      conditionList.append(add);
      filterPane.append(conditionList);
      status = element("p");
      status.setAttribute("role", "status");
      status.className = "attribute-status";
      if (options.analysis) updateFilterStatus();
      filterPane.append(status);
      const footer = element("footer"),
        submit = button("絞り込み実行", () => void search());
      submit.className = "attribute-submit";
      const clear = button("属性条件を解除", () => clearFilter());
      footer.className = "attribute-filter-actions";
      if (options.analysis) footer.append(submit, clear);
      else footer.append(clear, submit);
      if (presets && options.analysis) {
        footer.append(
          action("検索条件を保存", () => {
            try {
              presets.save({
                kind: "filter",
                definition: {
                  common_form_id: formId || null,
                  conditions: clone(conditions) as unknown as Record<string, unknown>[],
                },
              });
            } catch (e) {
              error((e as Error).message);
            }
          }),
        );
      }
      filterPane.append(footer);
    }
    if (coloringEditor) {
      analysisHost.replaceChildren();
      if (aiDrafts.coloring) {
        analysisHost.append(element("h3", "地図で色分け"));
        renderAiPane(analysisHost, "coloring");
      } else {
        analysisHost.append(legacyAnalysisHost);
        coloringEditor.refresh();
      }
      const note = element("p", "入力した条件は、それぞれの実行ボタンで地図に反映します。");
      note.className = "attribute-dialog-note";
      dialog.append(note);
    }
    dialog
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>(
        "button,select,input",
      )
      .forEach((b) => {
        // 複合条件の子要素はfieldsetで一括制御する。個別disabledを残さない。
        if (b.closest(".ai-condition-editor")) return;
        if (b.textContent !== "閉じる") {
          b.dataset.busy = String(b.disabled);
          if (busy) b.disabled = true;
        }
      });
    if (focusKey && dialog.open) {
      const controls = [...dialog.querySelectorAll<HTMLElement>("[data-focus-key]")];
      const target =
        controls.find((node) => node.dataset.focusKey === focusKey && !node.matches(":disabled")) ??
        controls.find((node) => node.dataset.focusKey === "閉じる");
      target?.focus({ preventScroll: true });
    }
  }
  const modal = {
    preparePresetPage,
    refreshPresetData(metadata = false) {
      if (disposed) return;
      if (metadata) resetMetadata();
      const page = currentPage;
      if (page && (metadata || page.key !== aiContextKey())) {
        for (const draft of Object.values(aiDrafts)) {
          draft.page = undefined;
          draft.waiting = false;
          draft.retryData = false;
        }
        for (const job of pageJobs) job.abort();
        currentPage = undefined;
        if (!presets?.refreshPreparation() && !page.source.aborted) {
          page.replacement = preparePresetPage(page.items, page.source);
          void page.replacement.catch(() => {
            // 呼び出した条件は、新しいページの準備結果から個別の失敗を表示する。
          });
        }
      }
      if (!dialog.open) return;
      if (metadata || (page && page.key !== aiContextKey())) {
        for (const draft of Object.values(aiDrafts)) void draft.reloadMetadata(currentPage);
        render();
      }
      refreshDraft("filter");
      refreshDraft("coloring");
    },
    isBusy: () => busy || coloringBusy,
    async open(from?: HTMLElement, page?: PresetPage) {
      if (disposed) return;
      if (!page) {
        cachedForms = undefined;
        cachedOptions.clear();
      }
      cancel();
      clearAiDrafts();
      trigger = from || (document.activeElement as HTMLElement | null);
      const applied = options.getApplied();
      formId = applied?.common_form_id || "";
      conditions = clone(applied?.conditions || []);
      const seq = ++sequence;
      controller = new AbortController();
      busy = !page;
      render();
      if (!dialog.open) dialog.showModal();
      status.textContent = "共通フォームを取得中…";
      const active = () =>
        !disposed && seq === sequence && dialog.open && (!page || page.key === aiContextKey());
      try {
        const signal = controller.signal;
        const data = await (page?.forms ?? readForms(signal));
        if (!active()) return;
        forms = structuredClone(data);
        if (options.analysis) {
          const meta = await openingOptions(page, null, signal);
          if (!active()) return;
          for (const f of meta.forms || [])
            if (!forms.some((form) => form.id === f.id))
              forms.push({
                id: f.id,
                version: 0,
                form_title: f.label,
                form_schema: { fields: [] },
              });
          if (formId) {
            const fields = (await openingOptions(page, formId, signal)).fields;
            if (!active()) return;
            const form = forms.find((f) => f.id === formId);
            if (form)
              form.form_schema.fields = fields.map((f) => ({
                id: f.id,
                label: f.label,
                type: f.field_type,
                choices: f.choices,
              }));
          }
        }
        if (options.analysis?.getSpecification()) {
          const specification = options.analysis.getSpecification()!;
          const id = specification.common_form_id;
          const candidates = (await openingOptions(page, id, signal)).fields;
          if (!active()) return;
          coloringEditor!.restore(specification, candidates);
        }
        busy = false;
        render();
        if (
          applied &&
          !options.analysis &&
          !forms.some((f) => f.id === formId && f.version === applied.definition_version)
        )
          error("共通フォームが変更・削除されています。条件を確認してください。");
      } catch (e) {
        if (active()) {
          busy = false;
          render();
          error(e instanceof Error ? e.message : "取得に失敗しました。");
        }
      }
    },
    async recallPreset(preset: SavedMapPreset) {
      if (disposed) return;
      const context = aiContextKey();
      if (!dialog.open) {
        const page = pageFor(preset);
        const opening = modal.open(undefined, page);
        const openingSequence = sequence;
        if (!page) await opening;
        if (sequence !== openingSequence) return;
      }
      if (disposed || !dialog.open) return;
      if (context !== aiContextKey()) {
        close();
        return;
      }
      await restorePreset(preset, new AbortController().signal);
    },
    close,
    dispose() {
      close();
      disposed = true;
      clearAiDrafts();
      coloringEditor?.dispose();
      presets?.dispose();
      completion.dispose();
      progress.dispose();
      dialog.remove();
    },
  };
  return modal;
}

export async function searchMapAttributes(
  transport: AttributeTransport,
  request: AttributeSearchRequest,
  colors: AnswerColorSpecification | null,
  signal: AbortSignal,
): Promise<AttributeSearchResult> {
  const data = await evaluateMapAnalysis(
    transport,
    {
      common_form_id: request.common_form_id,
      conditions: request.conditions as unknown as Record<string, unknown>[],
    },
    colors,
    request.layer_ids,
    signal,
    request.targets?.map((t) => `${t.target_type}:${t.id}`),
  );
  return {
    common_form_id: request.common_form_id,
    definition_version: request.definition_version,
    as_of: data.as_of,
    marker_ids: data.targets
      .filter((k: string) => k.startsWith("marker:"))
      .map((k: string) => k.slice(7)),
    shape_ids: data.targets
      .filter((k: string) => k.startsWith("shape:"))
      .map((k: string) => k.slice(6)),
    target_count: data.target_count,
    coloring: data.coloring,
  };
}
