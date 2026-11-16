import css from "./chat.css?inline";
import { awaitWithAbort, createProgressSpinner } from "../map/common/progress-spinner";
import {
  validateCapabilities,
  validateExecutionResult,
  validateDefinition,
  validateSuggestions,
  AI_OPERATION_NOT_ALLOWED,
  createAiOperationId,
  type AiAppliedState,
  type AiCapabilities,
  type AiContext,
  type AiExecutionResult,
  type AiTransport,
  type AiSuggestion,
  type AiUndo,
} from "./types";

interface ChatOptions {
  mode?: "desktop" | "mobile" | "standalone";
  transport: AiTransport;
  getContext(): AiContext;
  /** アカウント・地図の範囲・読込世代が変わった後は古い応答を適用しない。 */
  getContextKey(): string;
  /** 候補だけを失効するためのデータ・フォーム更新世代。会話の範囲とは分離する。 */
  getSuggestionContextKey?(): string;
  apply(result: AiExecutionResult, signal: AbortSignal): Promise<AiUndo | void>;
  onEnabledChange?(enabled: boolean): void;
  onAccountChanged?(): void;
  onLayerCreated?(layer: { id: string; name: string }, signal: AbortSignal): Promise<void>;
}
const GENERAL_EXAMPLE = "地図上のデータを絞り込む方法を教えて";
const SUGGESTION_TTL_MS = 60_000;
const SUGGESTION_REFRESH_DELAY_MS = 150;
let chatInstance = 0;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};
function describeDefinition(value: unknown): string {
  const definition = validateDefinition(value);
  const conditions = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map((raw) => {
            const c = raw as { field_id?: unknown; op?: unknown; value?: unknown; upper?: unknown };
            const labels: Record<string, string> = {
              eq: "＝",
              contains: "を含む",
              gte: "以上",
              lte: "以下",
              between: "範囲",
              in: "のいずれか",
              empty: "未入力",
              filled: "入力あり",
              missing: "項目なし",
            };
            const text = ["empty", "filled", "missing"].includes(String(c.op))
              ? ""
              : Array.isArray(c.value)
                ? c.value.join("・")
                : String(c.value ?? "");
            return `${String(c.field_id ?? "項目")} ${labels[String(c.op)] ?? "条件"} ${text}${c.op === "between" ? `〜${String(c.upper ?? "")}` : ""}`;
          })
          .join("、かつ ")
      : "";
  if (definition.type === "color") {
    return `色分け：${(definition.rules as { label?: unknown; conditions?: unknown[] }[])
      .map((rule) => `${String(rule.label ?? "分類")}：${conditions(rule.conditions) || "全件"}`)
      .join("\n")}`.slice(0, 5000);
  }
  const describe = (value: unknown, depth = 0): string => {
    if (depth > 5 || !value || typeof value !== "object") return "条件";
    const expression = value as {
      op?: unknown;
      query1?: unknown;
      query2?: unknown;
      conditions?: unknown[];
      children?: unknown[];
      child?: unknown;
    };
    if (expression.op === "all") return "対象レイヤーの全件";
    if (expression.op === "text")
      return `文字列「${String(expression.query1 ?? "")}」${expression.query2 ? `と「${String(expression.query2)}」` : ""}`;
    if (expression.op === "attribute")
      return conditions(expression.conditions) || "フォームの登録あり";
    if (expression.op === "not") return `次の条件を除外：${describe(expression.child, depth + 1)}`;
    if (["and", "or"].includes(String(expression.op)) && Array.isArray(expression.children))
      return expression.children
        .map((child) => describe(child, depth + 1))
        .join(expression.op === "and" ? "、かつ " : "、または ");
    return "検索条件";
  };
  return describe(definition.expression).slice(0, 5000);
}

/** PC・モバイル・単独地図で同じ送信、取消、音声入力を使用する。 */
export function createAiChat(options: ChatOptions) {
  if (!document.getElementById("geocode-ai-chat-style")) {
    const style = node("style");
    style.id = "geocode-ai-chat-style";
    style.textContent = css;
    document.head.append(style);
  }
  const dialog = node("dialog", "geocode-ai-chat");
  dialog.dataset.mode = options.mode ?? "desktop";
  dialog.setAttribute("aria-label", "AIアシスタント");
  const visualViewport = window.visualViewport;
  const syncViewport = () => {
    const width = visualViewport?.width || window.innerWidth;
    const height = visualViewport?.height || window.innerHeight;
    dialog.style.setProperty("--ai-viewport-width", width + "px");
    dialog.style.setProperty("--ai-viewport-height", height + "px");
    dialog.style.setProperty("--ai-viewport-left", (visualViewport?.offsetLeft || 0) + "px");
    dialog.style.setProperty("--ai-viewport-top", (visualViewport?.offsetTop || 0) + "px");
    dialog.toggleAttribute("data-compact", height <= 600);
  };
  syncViewport();
  const header = node("header", "ai-header");
  const closeButton = node("button", "ai-close", "閉じる");
  closeButton.type = "button";
  header.append(node("h2", "", "AIアシスタント"), closeButton);
  const note = node(
    "p",
    "ai-note",
    "検索・色分け・保存条件・分析方法を相談できます。作成・保存は内容を確認して確定します。入力と必要な属性情報を、管理者が設定したAIへ送信します。",
  );
  const log = node("div", "ai-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const progress = node("div", "ai-progress");
  progress.hidden = true;
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "AIの処理中");
  progress.append(createProgressSpinner());
  const status = node("p", "ai-status");
  const panel = node("section", "ai-panel");
  status.setAttribute("role", "status");
  const form = node("form", "ai-form");
  const draft = node("textarea");
  draft.setAttribute("aria-label", "AIへの指示");
  draft.placeholder = "例：" + GENERAL_EXAMPLE;
  draft.maxLength = 4000;
  const suggestionTools = node("div", "ai-suggestion-tools");
  const suggestionHint = node("p", "ai-suggestion-hint");
  suggestionHint.id = "ai-suggestion-hint-" + ++chatInstance;
  const suggestionButton = node("button", "ai-use-suggestion", "例を入力");
  suggestionButton.type = "button";
  suggestionTools.append(suggestionHint, suggestionButton);
  const actions = node("div", "ai-actions");
  const undoButton = node("button", "", "元に戻す");
  const recordButton = node("button", "ai-record", "音声入力");
  const cancelButton = node("button", "", "中止");
  const sendButton = node("button", "ai-send", "送信");
  for (const button of [undoButton, recordButton, cancelButton]) button.type = "button";
  recordButton.setAttribute("aria-pressed", "false");
  sendButton.type = "submit";
  actions.append(undoButton, recordButton, cancelButton, sendButton);
  form.append(suggestionTools, draft, actions);
  dialog.append(header, note, progress, log, panel, status, form);
  document.body.append(dialog);

  let capabilities: AiCapabilities | null = null;
  let accountInvalid = false;
  let disposed = false;
  let busy = false;
  let sequence = 0;
  let request: AbortController | undefined;
  let capabilityRequest: AbortController | undefined;
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let recording = false;
  let stoppingRecording = false;
  let requestingMicrophone = false;
  let voiceSequence = 0;
  let voiceTimer: ReturnType<typeof setTimeout> | undefined;
  let opener: HTMLElement | undefined;
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const undos: { key: string; undo: AiUndo; entry?: { content: string } }[] = [];
  let appliedState: AiAppliedState = { filter: null, color: null };
  let scopeGeneration = 0;
  let pendingWrite: { attempted: boolean } | undefined;
  let outsidePointer: number | undefined;
  let outsideClickReady = false;
  let composing = false;
  let suggestionSequence = 0;
  let suggestionRequest: AbortController | undefined;
  let suggestionRequestKey = "";
  let suggestionLoading = false;
  let suggestionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestionCache:
    | { key: string; revision: string; expires: number; items: AiSuggestion[]; index: number }
    | undefined;
  const suggestionKey = () =>
    JSON.stringify([
      options.getContextKey(),
      options.getSuggestionContextKey?.() ?? options.getContextKey(),
      options.getContext(),
    ]);
  const currentSuggestion = () => {
    if (
      !dialog.open ||
      !capabilities?.enabled ||
      accountInvalid ||
      !suggestionCache ||
      suggestionCache.key !== suggestionKey() ||
      suggestionCache.revision !== capabilities.revision ||
      suggestionCache.expires <= Date.now()
    )
      return undefined;
    return suggestionCache.items[suggestionCache.index % suggestionCache.items.length];
  };
  const renderSuggestions = () => {
    const candidate = currentSuggestion();
    draft.placeholder = "例：" + (candidate?.text ?? GENERAL_EXAMPLE);
    suggestionTools.hidden =
      !capabilities?.enabled ||
      accountInvalid ||
      busy ||
      recording ||
      requestingMicrophone ||
      draft.value.length > 0;
    suggestionButton.disabled = suggestionTools.hidden;
    // 明示参照した説明は非表示でも読み上げられるため、利用できる状態だけ参照する。
    if (dialog.open && !suggestionTools.hidden && !composing)
      draft.setAttribute("aria-describedby", suggestionHint.id);
    else draft.removeAttribute("aria-describedby");
    suggestionHint.textContent = candidate
      ? "現在の対象レイヤーの例です。Tabキーでも入力できます。"
      : suggestionLoading
        ? "入力例を確認しています。文字入力はそのまま使えます。"
        : "一般的な操作案内の入力例です。";
  };
  const stopSuggestionRequest = () => {
    ++suggestionSequence;
    clearTimeout(suggestionRefreshTimer);
    suggestionRefreshTimer = undefined;
    suggestionRequest?.abort();
    suggestionRequest = undefined;
    suggestionRequestKey = "";
    suggestionLoading = false;
  };
  const clearSuggestions = () => {
    stopSuggestionRequest();
    clearTimeout(suggestionExpiryTimer);
    suggestionExpiryTimer = undefined;
    suggestionCache = undefined;
    renderSuggestions();
  };
  const scheduleSuggestionExpiry = () => {
    clearTimeout(suggestionExpiryTimer);
    const cache = suggestionCache;
    if (!cache) return;
    suggestionExpiryTimer = setTimeout(
      () => {
        if (suggestionCache === cache) renderSuggestions();
      },
      Math.max(0, cache.expires - Date.now()) + 1,
    );
  };

  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
    if (!error && text) {
      progress.setAttribute("aria-valuetext", text);
    }
  };
  const update = () => {
    const voiceBusy = recording || requestingMicrophone;
    const waiting =
      dialog.open && (busy || requestingMicrophone || (!!capabilityRequest && !capabilities));
    progress.hidden = !waiting;
    status.hidden = waiting;
    dialog.setAttribute("aria-busy", String(waiting));
    sendButton.disabled =
      busy ||
      voiceBusy ||
      !!pendingWrite?.attempted ||
      !capabilities?.enabled ||
      !draft.value.trim();
    undoButton.disabled = busy || voiceBusy || !undos.length;
    recordButton.hidden = !capabilities?.voice_enabled;
    recordButton.disabled = busy || stoppingRecording || !capabilities?.enabled;
    recordButton.setAttribute("aria-pressed", String(voiceBusy));
    recordButton.textContent = stoppingRecording
      ? "録音を終了しています…"
      : requestingMicrophone
        ? "マイク接続を中止"
        : recording
          ? "録音を終了"
          : "音声入力";
    cancelButton.hidden = !busy;
    draft.disabled = voiceBusy || busy;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = busy || voiceBusy || button.dataset.disabled === "true";
    renderSuggestions();
  };
  const append = (role: "user" | "assistant", content: string) => {
    const message = node("div", "ai-message");
    message.dataset.role = role;
    message.append(node("span", "ai-message-label", role === "user" ? "あなた" : "AI"));
    message.append(document.createTextNode(content));
    log.append(message);
    log.scrollTop = log.scrollHeight;
    history.push({ role, content: content.slice(0, 4000) });
    if (history.length > 12) history.splice(0, history.length - 12);
  };
  const releaseMicrophone = () => {
    clearTimeout(voiceTimer);
    voiceTimer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  };
  const cancelRecording = () => {
    ++voiceSequence;
    requestingMicrophone = false;
    recording = false;
    stoppingRecording = false;
    const active = recorder;
    recorder = undefined;
    if (active && active.state !== "inactive") active.stop();
    releaseMicrophone();
    update();
  };
  const cancel = () => {
    ++sequence;
    request?.abort();
    request = undefined;
    busy = false;
    outsidePointer = undefined;
    outsideClickReady = false;
    cancelRecording();
    update();
  };
  const handleAccountError = (error: unknown) => {
    if (disposed || !(error instanceof Error) || error.message !== "ai_account_changed")
      return false;
    accountInvalid = true;
    clearSuggestions();
    ++scopeGeneration;
    appliedState = { filter: null, color: null };
    pendingWrite = undefined;
    panel.replaceChildren();
    history.length = 0;
    undos.length = 0;
    log.replaceChildren();
    draft.value = "";
    capabilities = { enabled: false, voice_enabled: false, revision: "" };
    cancelRecording();
    options.onEnabledChange?.(false);
    options.onAccountChanged?.();
    setStatus(
      "ログイン中のアカウントが変わりました。画面を再読み込みしてから再試行してください。",
      true,
    );
    update();
    return true;
  };
  const applyCapabilities = (next: AiCapabilities) => {
    if (accountInvalid) return;
    const changed = !!capabilities && capabilities.revision !== next.revision;
    capabilities = next;
    if (!next.enabled || changed) clearSuggestions();
    options.onEnabledChange?.(next.enabled);
    if (!next.enabled || (changed && busy)) {
      cancel();
      if (dialog.open)
        setStatus(
          next.enabled
            ? "AI設定が変更されました。指示を送り直してください。"
            : "管理者がAI機能を無効にしています。",
          true,
        );
    }
    if (!next.voice_enabled) cancelRecording();
    update();
    if (changed && next.enabled && dialog.open) void refreshSuggestions();
  };
  const loadCapabilities = async (signal: AbortSignal) => {
    const data = validateCapabilities(
      await options.transport("/ai/capabilities", undefined, signal),
    );
    if (!disposed && !signal.aborted) applyCapabilities(data);
    return data;
  };
  const refreshCapabilities = async () => {
    if (accountInvalid) return;
    capabilityRequest?.abort();
    const controller = new AbortController();
    capabilityRequest = controller;
    update();
    try {
      await loadCapabilities(controller.signal);
    } catch {
      if (!disposed && !controller.signal.aborted) {
        applyCapabilities({ enabled: false, voice_enabled: false, revision: "" });
        if (dialog.open)
          setStatus("AIの利用設定を取得できません。時間をおいて開き直してください。", true);
      }
    } finally {
      if (capabilityRequest === controller) {
        capabilityRequest = undefined;
        update();
      }
    }
  };
  const refreshSuggestions = async () => {
    if (disposed || accountInvalid || !dialog.open || !capabilities?.enabled) return;
    const key = suggestionKey(),
      revision = capabilities.revision;
    if (
      suggestionCache?.key === key &&
      suggestionCache.revision === revision &&
      suggestionCache.expires > Date.now()
    ) {
      renderSuggestions();
      return;
    }
    const requestKey = JSON.stringify([key, revision]);
    if (suggestionRequest && suggestionRequestKey === requestKey) return;
    stopSuggestionRequest();
    suggestionCache = undefined;
    const controller = new AbortController();
    const id = suggestionSequence;
    suggestionRequest = controller;
    suggestionRequestKey = requestKey;
    suggestionLoading = true;
    renderSuggestions();
    const isCurrent = () =>
      !disposed &&
      !accountInvalid &&
      dialog.open &&
      id === suggestionSequence &&
      key === suggestionKey() &&
      capabilities?.enabled &&
      capabilities.revision === revision;
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const raw = await awaitWithAbort(
        options.transport(
          "/ai/suggestions",
          { context: structuredClone(options.getContext()), revision },
          controller.signal,
        ),
        controller.signal,
      );
      if (!isCurrent() || controller.signal.aborted) return;
      const result = validateSuggestions(raw);
      if (result.revision !== revision) {
        clearSuggestions();
        await refreshCapabilities();
        return;
      }
      suggestionCache = {
        key,
        revision,
        expires: Date.now() + SUGGESTION_TTL_MS,
        items: result.suggestions,
        index: 0,
      };
      scheduleSuggestionExpiry();
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof Error && error.message === "ai_account_changed") {
        cancel();
        handleAccountError(error);
        return;
      }
      if (
        error instanceof Error &&
        (error.message === "conflict" ||
          error.message.startsWith("forbidden:") ||
          error.message.startsWith("unauthorized error:") ||
          error.message === "token_expired" ||
          error.message.includes("再ログイン"))
      ) {
        clearSuggestions();
        await refreshCapabilities();
        return;
      }
      // 旧サーバー・一時障害・空候補でも、通常の入力や送信を妨げない。
      suggestionCache = {
        key,
        revision,
        expires: Date.now() + SUGGESTION_TTL_MS,
        items: [],
        index: 0,
      };
      scheduleSuggestionExpiry();
    } finally {
      clearTimeout(timer);
      if (id === suggestionSequence) {
        suggestionRequest = undefined;
        suggestionRequestKey = "";
        suggestionLoading = false;
        renderSuggestions();
      }
    }
  };
  const useSuggestion = (allowGeneral = false) => {
    if (
      disposed ||
      accountInvalid ||
      !dialog.open ||
      !capabilities?.enabled ||
      busy ||
      recording ||
      requestingMicrophone ||
      composing ||
      draft.value.length > 0
    )
      return false;
    const candidate = currentSuggestion();
    if (!candidate && !allowGeneral) {
      renderSuggestions();
      return false;
    }
    draft.value = candidate?.text ?? GENERAL_EXAMPLE;
    if (candidate && suggestionCache) ++suggestionCache.index;
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.focus();
    draft.setSelectionRange(draft.value.length, draft.value.length);
    return true;
  };
  const assertCurrent = (id: number, key: string, signal: AbortSignal) => {
    if (disposed || !dialog.open || signal.aborted || id !== sequence)
      throw new DOMException("Aborted", "AbortError");
    if (key !== options.getContextKey())
      throw Error("地図の対象が変わりました。現在の地図で指示を送り直してください。");
  };
  const panelButton = (text: string, operation: () => void, disabled = false) => {
    const button = node("button", "", text);
    button.type = "button";
    button.dataset.disabled = String(disabled);
    button.addEventListener("click", operation);
    return button;
  };
  const withPanelRequest = async (
    key: string,
    operation: (signal: AbortSignal, id: number) => Promise<void>,
    propagate = false,
  ) => {
    if (busy || disposed || accountInvalid || !dialog.open || key !== options.getContextKey())
      return;
    const controller = new AbortController();
    request = controller;
    const id = ++sequence;
    busy = true;
    setStatus("処理中です…");
    update();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      await operation(controller.signal, id);
    } catch (error) {
      if (!handleAccountError(error) && !disposed && id === sequence) {
        const message = error instanceof Error ? error.message : "AIの処理に失敗しました。";
        if (message === AI_OPERATION_NOT_ALLOWED) append("assistant", AI_OPERATION_NOT_ALLOWED);
        setStatus(controller.signal.aborted ? "処理を中止しました。" : message, true);
      }
      if (propagate) throw error;
    } finally {
      clearTimeout(timer);
      if (id === sequence) {
        request = undefined;
        busy = false;
        update();
      }
    }
  };
  const applyDisplay = async (
    result: AiExecutionResult,
    action: unknown,
    id: number,
    key: string,
    signal: AbortSignal,
    entry?: { content: string },
  ) => {
    const before = structuredClone(appliedState);
    const definition = result.definition ?? action;
    let next = structuredClone(before);
    if (result.type === "filter" || result.type === "color") {
      // Legacy servers do not return definitions; legacy chat must remain usable.
      if (capabilities?.protocol_version === 2) {
        const validated = validateDefinition(definition);
        if (validated.type !== result.type) throw Error("適用した条件の種類が一致しません。");
        next[result.type] = validated;
      }
    } else if (result.type === "reset") next = { filter: null, color: null };
    const undo = await options.apply(result, signal);
    assertCurrent(id, key, signal);
    appliedState = next;
    if (undo) {
      const generation = scopeGeneration;
      undos.push({
        key,
        entry,
        undo: async () => {
          const undoSequence = sequence;
          await undo();
          if (
            disposed ||
            generation !== scopeGeneration ||
            undoSequence !== sequence ||
            key !== options.getContextKey()
          )
            throw Error("地図の対象が変わったため、以前の条件は復元できません。");
          appliedState = structuredClone(before);
        },
      });
      if (undos.length > 10) undos.shift();
    }
    setStatus(
      result.type === "filter"
        ? `検索条件に一致：${result.target_count}件。地図・一覧へ反映しました。手動の検索条件も併用します。`
        : result.type === "color"
          ? "色分けを地図へ反映しました。"
          : result.type === "reset"
            ? "AIで適用した検索と色分けを解除しました。"
            : "地図を移動しました。",
    );
  };
  const execute = async (
    action: unknown,
    revision: string,
    context: AiContext,
    id: number,
    key: string,
    signal: AbortSignal,
    entry?: { content: string },
  ): Promise<void> => {
    const current = await loadCapabilities(signal);
    assertCurrent(id, key, signal);
    if (!current.enabled || current.revision !== revision)
      throw Error("AI設定が変更されました。指示を送り直してください。");
    const protocol = current.protocol_version === 2;
    const command = action as { type?: unknown; kind?: unknown };
    if (protocol && ["create_layer", "save_preset"].includes(String(command?.type))) {
      if (!current.write_enabled) throw Error(AI_OPERATION_NOT_ALLOWED);
      const operationId = createAiOperationId();
      const state = structuredClone(appliedState);
      const data = (await options.transport(
        "/ai/operations/prepare",
        {
          operation_id: operationId,
          protocol_version: 2,
          revision,
          action,
          context,
          state,
        },
        signal,
      )) as Record<string, unknown>;
      assertCurrent(id, key, signal);
      if (
        data?.operation_id !== operationId ||
        data.status !== "prepared" ||
        !data.summary ||
        typeof data.summary !== "object"
      )
        throw Error("作成・保存の確認内容を取得できませんでした。");
      const summary = data.summary as {
        type?: unknown;
        name?: unknown;
        kind?: unknown;
        definition?: unknown;
        description?: unknown;
      };
      if (
        summary.type !== command.type ||
        typeof summary.name !== "string" ||
        !summary.name.trim() ||
        summary.name.length > 200
      )
        throw Error("作成・保存の確認内容が不正です。");
      if (summary.type === "save_preset") {
        const definition = validateDefinition(summary.definition);
        if (
          (summary.kind === "filter" ? "filter" : summary.kind === "coloring" ? "color" : "") !==
          definition.type
        )
          throw Error("保存する条件の種類が一致しません。");
      }
      const pending = { attempted: false };
      pendingWrite = pending;
      recordAction(entry, action, "確認待ち・未実行");
      panel.replaceChildren(
        node(
          "h3",
          "",
          summary.type === "create_layer" ? "レイヤーを作成しますか？" : "条件を保存しますか？",
        ),
        node("p", "", summary.name),
      );
      if (typeof summary.description === "string") panel.append(node("p", "", summary.description));
      if (summary.definition)
        panel.append(node("p", "ai-definition", describeDefinition(summary.definition)));
      const finish = async (response: unknown, controller: AbortSignal, sequenceId: number) => {
        const value = response as {
          operation_id?: unknown;
          status?: unknown;
          result?: { type?: unknown; id?: unknown; name?: unknown; kind?: unknown };
        };
        if (
          value?.operation_id !== operationId ||
          value.status !== "completed" ||
          !value.result ||
          value.result.type !== summary.type ||
          typeof value.result.id !== "string" ||
          typeof value.result.name !== "string"
        )
          throw Error("実行結果を確認できませんでした。「結果を確認」で確認してください。");
        assertCurrent(sequenceId, key, controller);
        pendingWrite = undefined;
        recordAction(entry, action, "作成・保存完了。結果ID：" + value.result.id);
        const result = value.result;
        const label =
          result.type === "create_layer" ? "レイヤーを作成しました：" : "条件を保存しました：";
        panel.replaceChildren(node("p", "", label + result.name));
        setStatus(label + result.name);
        if (result.type === "create_layer" && options.onLayerCreated) {
          const layer = { id: result.id as string, name: result.name as string };
          const refresh = async (refreshSignal: AbortSignal) => {
            await options.onLayerCreated!(layer, refreshSignal);
          };
          try {
            await refresh(controller);
          } catch {
            assertCurrent(sequenceId, key, controller);
            panel.append(
              node("p", "", "作成は完了しています。一覧の更新を再試行してください。"),
              panelButton("一覧を更新", () => void withPanelRequest(key, refresh)),
            );
          }
        }
      };
      const checkResult = () =>
        void withPanelRequest(key, async (controller, sequenceId) => {
          const result = (await options.transport(
            `/ai/operations/${encodeURIComponent(operationId)}`,
            undefined,
            controller,
          )) as { status?: unknown };
          assertCurrent(sequenceId, key, controller);
          if (result?.status === "completed") await finish(result, controller, sequenceId);
          else if (result?.status === "prepared")
            setStatus("まだ確定されていません。内容を確認して確定してください。");
          else throw Error("実行結果を確認できませんでした。");
        });
      panel.append(
        panelButton(
          "確定する",
          () =>
            void withPanelRequest(key, async (controller, sequenceId) => {
              pending.attempted = true;
              recordAction(entry, action, "確定要求送信済み・結果未確認");
              try {
                const result = await options.transport(
                  "/ai/operations/commit",
                  { operation_id: operationId, protocol_version: 2, revision, context },
                  controller,
                );
                await finish(result, controller, sequenceId);
              } catch (error) {
                if (controller.aborted) throw error;
                const recovered = (await options.transport(
                  `/ai/operations/${encodeURIComponent(operationId)}`,
                  undefined,
                  controller,
                )) as { status?: unknown };
                if (recovered?.status === "completed")
                  await finish(recovered, controller, sequenceId);
                // A plain status read may still show prepared while the earlier commit is running.
                // Keep the original ID and block new proposals until this operation is resolved.
                else throw error;
              }
            }),
        ),
        panelButton("結果を確認", checkResult),
        panelButton("取り消す", () => {
          if (pending.attempted) {
            setStatus("確定要求を送信済みです。「結果を確認」で確認してください。", true);
            return;
          }
          recordAction(entry, action, "利用者が取り消し・未実行");
          pendingWrite = undefined;
          panel.replaceChildren();
          setStatus("作成・保存を取り消しました。");
          update();
        }),
      );
      setStatus("内容を確認し、「確定する」を押してください。");
      return;
    }
    const raw = await options.transport(
      protocol ? "/ai/assist/execute" : "/ai/execute",
      {
        ...(protocol ? { protocol_version: 2 } : {}),
        action,
        context,
        revision,
      },
      signal,
    );
    assertCurrent(id, key, signal);
    const resultPage = raw as {
      type?: unknown;
      items?: unknown;
      total?: unknown;
      page?: unknown;
      page_size?: unknown;
      kind?: unknown;
      name?: unknown;
    };
    if (protocol && resultPage?.type === "presets") {
      if (
        !Array.isArray(resultPage.items) ||
        resultPage.items.length > 100 ||
        !Number.isSafeInteger(resultPage.total) ||
        Number(resultPage.total) < 0
      )
        throw Error("保存条件の一覧を確認できませんでした。");
      panel.replaceChildren(node("h3", "", "保存した条件"));
      for (const item of resultPage.items) {
        const preset = item as {
          id?: unknown;
          name?: unknown;
          kind?: unknown;
          schema_version?: unknown;
          create_at?: unknown;
          definition?: unknown;
        };
        if (
          typeof preset.id !== "string" ||
          typeof preset.name !== "string" ||
          !["filter", "coloring"].includes(String(preset.kind)) ||
          ![1, 2].includes(Number(preset.schema_version))
        )
          throw Error("保存条件の一覧が不正です。");
        const row = node("div", "ai-preset");
        row.append(
          node("strong", "", preset.name),
          node(
            "p",
            "",
            `${preset.kind === "filter" ? "絞り込み" : "色分け"} ／ ${String(preset.create_at ?? "")}`,
          ),
        );
        row.append(
          panelButton(
            "適用する",
            () =>
              void withPanelRequest(key, (controller, sequenceId) =>
                execute(
                  { type: "apply_preset", preset_id: preset.id },
                  revision,
                  context,
                  sequenceId,
                  key,
                  controller,
                ),
              ),
          ),
        );
        panel.append(row);
      }
      if (!resultPage.items.length) panel.append(node("p", "", "保存した条件はありません。"));
      const page = Number(resultPage.page),
        pageSize = Number(resultPage.page_size);
      if (
        Number.isSafeInteger(page) &&
        page > 0 &&
        Number.isSafeInteger(pageSize) &&
        pageSize > 0
      ) {
        const load = (next: number) =>
          void withPanelRequest(key, (controller, sequenceId) =>
            execute(
              {
                type: "list_presets",
                ...(resultPage.kind ? { kind: resultPage.kind } : {}),
                ...(typeof resultPage.name === "string" ? { name: resultPage.name } : {}),
                page: next,
              },
              revision,
              context,
              sequenceId,
              key,
              controller,
            ),
          );
        panel.append(
          panelButton("前へ", () => load(page - 1), page <= 1),
          node("span", "", ` ${page} `),
          panelButton("次へ", () => load(page + 1), page * pageSize >= Number(resultPage.total)),
        );
      }
      setStatus("適用する条件を選択してください。");
      return;
    }
    const result = validateExecutionResult(raw);
    const beforeApply = await loadCapabilities(signal);
    assertCurrent(id, key, signal);
    if (!beforeApply.enabled || beforeApply.revision !== revision)
      throw Error("AI設定が変更されました。指示を送り直してください。");
    await applyDisplay(result, action, id, key, signal, entry);
    panel.replaceChildren();
  };
  const recordAction = (entry: { content: string } | undefined, action: unknown, state: string) => {
    if (!entry || action === undefined || action === null) return;
    const receipt = "\n\n[アプリによる実行記録：" + state + "]\n" + JSON.stringify(action);
    const original = entry.content.split("\n\n[アプリによる実行記録：")[0] ?? "";
    entry.content =
      receipt.length <= 3500
        ? original.slice(0, 4000 - receipt.length) + receipt
        : "[アプリによる実行記録：" +
          state +
          "] 操作定義が長いため、条件全体は会話履歴に含めていません。適用済み条件を参照してください。";
  };
  const send = async (event?: Event) => {
    event?.preventDefault();
    if (accountInvalid) return;
    const message = draft.value.trim();
    if (busy || recording || requestingMicrophone || pendingWrite?.attempted || !message) return;
    panel.replaceChildren();
    pendingWrite = undefined;
    const controller = new AbortController();
    request = controller;
    const id = ++sequence;
    const key = options.getContextKey();
    const context = structuredClone(options.getContext());
    busy = true;
    update();
    setStatus("AIに問い合わせています…");
    const timeout = setTimeout(() => controller.abort(), 240000);
    let assistantEntry: { role: "user" | "assistant"; content: string } | undefined;
    let plannedAction: unknown;
    const rememberAction = (state: string) => {
      recordAction(assistantEntry, plannedAction, state);
    };
    try {
      const available = await loadCapabilities(controller.signal);
      assertCurrent(id, key, controller.signal);
      if (!available.enabled) throw Error("管理者がAI機能を無効にしています。");
      const response = (await options.transport(
        "/ai/chat",
        {
          message,
          history: history.slice(-6),
          context,
          ...(available.protocol_version === 2
            ? { protocol_version: 2, state: structuredClone(appliedState) }
            : {}),
        },
        controller.signal,
      )) as { message?: unknown; action?: unknown; revision?: unknown; outcome?: unknown };
      assertCurrent(id, key, controller.signal);
      if (
        !response ||
        typeof response.message !== "string" ||
        typeof response.revision !== "string"
      )
        throw Error("AIの応答を確認できませんでした。");
      append("user", message);
      draft.value = "";
      append(
        "assistant",
        response.outcome === "denied" ? AI_OPERATION_NOT_ALLOWED : response.message,
      );
      if (response.outcome === "denied") {
        setStatus("");
        return;
      }
      assistantEntry = history.at(-1);
      plannedAction = response.action;
      if (response.action !== undefined && response.action !== null) {
        setStatus("地図へ反映しています…");
        await execute(
          response.action,
          response.revision,
          context,
          id,
          key,
          controller.signal,
          assistantEntry,
        );
        if (!pendingWrite) rememberAction("適用成功");
      } else setStatus("");
    } catch (error) {
      rememberAction("適用失敗・未確定。成功した条件として扱わないこと");
      if (handleAccountError(error)) return;
      if (error instanceof Error && error.message === AI_OPERATION_NOT_ALLOWED) {
        if (!assistantEntry) {
          append("user", message);
          draft.value = "";
        }
        append("assistant", AI_OPERATION_NOT_ALLOWED);
      }
      if (!disposed && id === sequence) {
        setStatus(
          controller.signal.aborted
            ? "処理を中止しました。必要に応じて指示を送り直してください。"
            : error instanceof Error
              ? error.message
              : "AIの処理に失敗しました。",
          true,
        );
      }
    } finally {
      clearTimeout(timeout);
      if (id === sequence) {
        request = undefined;
        busy = false;
        update();
        if (dialog.open) draft.focus();
      }
    }
  };

  const startRecording = async () => {
    if (requestingMicrophone) {
      cancelRecording();
      return;
    }
    if (recording) {
      if (stoppingRecording || !recorder || recorder.state === "inactive") return;
      stoppingRecording = true;
      recorder.stop();
      releaseMicrophone();
      update();
      return;
    }
    if (busy || !capabilities?.voice_enabled || !capabilities.enabled) return;
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setStatus(
        "この環境では録音できません。HTTPS接続の対応ブラウザー、または文字入力をご利用ください。",
        true,
      );
      return;
    }
    const voiceId = ++voiceSequence;
    requestingMicrophone = true;
    update();
    setStatus("マイクの利用を許可してください。");
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed || !dialog.open || voiceId !== voiceSequence) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(acquired, mimeType ? { mimeType } : undefined);
      recorder = active;
      const chunks: Blob[] = [];
      let bytes = 0;
      active.ondataavailable = (event) => {
        if (voiceId !== voiceSequence || !event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes > 10 * 1024 * 1024) {
          cancelRecording();
          setStatus("録音が長すぎます。短く分けて入力してください。", true);
        }
      };
      active.onerror = () => {
        if (voiceId !== voiceSequence) return;
        cancelRecording();
        setStatus("録音に失敗しました。文字入力または再録音をご利用ください。", true);
      };
      active.onstop = () => {
        if (voiceId !== voiceSequence) return;
        releaseMicrophone();
        recorder = undefined;
        recording = false;
        stoppingRecording = false;
        update();
        if (voiceId === voiceSequence && !disposed && dialog.open)
          void transcribe(chunks, active.mimeType);
      };
      requestingMicrophone = false;
      recording = true;
      active.start(250);
      voiceTimer = setTimeout(() => {
        if (voiceId === voiceSequence && active.state !== "inactive") {
          stoppingRecording = true;
          active.stop();
          update();
        }
        releaseMicrophone();
      }, 60000);
      update();
      setStatus(
        "録音中です。「録音を終了」で文字にします（最長60秒）。音声は設定済みの認識サービスへ送信します。",
      );
    } catch (error) {
      if (voiceId !== voiceSequence || disposed) return;
      cancelRecording();
      setStatus(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクの利用が許可されていません。ブラウザー設定を確認するか、文字で入力してください。"
          : "マイクを利用できません。接続とブラウザー設定を確認してください。",
        true,
      );
    }
  };
  const transcribe = async (chunks: Blob[], mimeType: string) => {
    const audio = new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" });
    if (!audio.size) {
      setStatus("音声を取得できませんでした。もう一度お試しください。", true);
      return;
    }
    const id = ++sequence;
    const key = options.getContextKey();
    const controller = new AbortController();
    request = controller;
    busy = true;
    update();
    setStatus("音声を文字にしています…");
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const data = new FormData();
      const extension = audio.type.includes("mp4")
        ? "mp4"
        : audio.type.includes("ogg")
          ? "ogg"
          : "webm";
      data.append("audio", audio, `speech.${extension}`);
      const result = (await options.transport("/ai/transcribe", data, controller.signal)) as {
        text?: unknown;
      };
      assertCurrent(id, key, controller.signal);
      if (typeof result?.text !== "string" || !result.text.trim())
        throw Error("音声を認識できませんでした。もう一度お試しください。");
      draft.value = [draft.value.trim(), result.text.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, draft.maxLength);
      setStatus("認識した文章を確認・修正し、「送信」を押してください。");
    } catch (error) {
      if (handleAccountError(error)) return;
      if (!disposed && id === sequence)
        setStatus(
          controller.signal.aborted
            ? "文字起こしを中止しました。"
            : error instanceof Error
              ? error.message
              : "文字起こしに失敗しました。",
          true,
        );
    } finally {
      clearTimeout(timeout);
      if (id === sequence) {
        request = undefined;
        busy = false;
        update();
        if (dialog.open) draft.focus();
      }
    }
  };
  const close = () => {
    stopSuggestionRequest();
    cancel();
    capabilityRequest?.abort();
    capabilityRequest = undefined;
    if (dialog.open) dialog.close();
    update();
    opener?.focus();
  };
  const hidden = () => {
    if (document.visibilityState === "hidden") {
      stopSuggestionRequest();
      cancel();
      capabilityRequest?.abort();
      if (dialog.open) setStatus("画面が非表示になったため、録音・通信を中止しました。");
    }
  };
  const onFocus = () => void refreshCapabilities();
  const onPageHide = () => {
    stopSuggestionRequest();
    cancel();
  };
  form.addEventListener("submit", send);
  draft.addEventListener("input", update);
  draft.addEventListener("compositionstart", () => {
    composing = true;
    renderSuggestions();
  });
  draft.addEventListener("compositionend", () => {
    composing = false;
    renderSuggestions();
  });
  draft.addEventListener("keydown", (event) => {
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      useSuggestion()
    )
      event.preventDefault();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing)
      void send(event);
  });
  suggestionButton.addEventListener("click", () => useSuggestion(true));
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    stopSuggestionRequest();
    cancel();
  });
  // native dialogのbackdropはdialog自身へretargetされる。内部の余白や、
  // 内部から外部へのドラッグで閉じないよう、押下・解放の両方を確認する。
  const outside = (event: MouseEvent) => {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  dialog.addEventListener("pointerdown", (event) => {
    outsideClickReady = false;
    outsidePointer =
      event.button === 0 && event.isPrimary !== false && event.target === dialog && outside(event)
        ? event.pointerId
        : undefined;
  });
  dialog.addEventListener("pointerup", (event) => {
    outsideClickReady =
      outsidePointer !== undefined &&
      outsidePointer === event.pointerId &&
      event.target === dialog &&
      outside(event);
    outsidePointer = undefined;
  });
  dialog.addEventListener("pointercancel", () => {
    outsidePointer = undefined;
    outsideClickReady = false;
  });
  dialog.addEventListener("click", (event) => {
    const dismiss = outsideClickReady && event.target === dialog && outside(event);
    outsideClickReady = false;
    if (dismiss) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  cancelButton.addEventListener("click", () => {
    cancel();
    setStatus("処理を中止しました。");
  });
  recordButton.addEventListener("click", () => void startRecording());
  undoButton.addEventListener("click", async () => {
    const previous = undos.at(-1);
    if (!previous || busy) return;
    if (previous.key !== options.getContextKey()) {
      undos.length = 0;
      setStatus("地図の対象が変わったため、以前の操作は元に戻せません。", true);
      update();
      return;
    }
    const generation = scopeGeneration,
      key = options.getContextKey(),
      id = ++sequence;
    const isCurrent = () =>
      !disposed &&
      generation === scopeGeneration &&
      id === sequence &&
      key === options.getContextKey();
    busy = true;
    setStatus("地図を元に戻しています…");
    update();
    try {
      await previous.undo();
      if (!isCurrent()) return;
      undos.pop();
      if (previous.entry)
        previous.entry.content =
          "[この操作は利用者が元に戻しました。現在の適用済み条件として扱わないこと]\n" +
          previous.entry.content.slice(0, 3930);
      setStatus("直前のAI操作を元に戻しました。");
    } catch (error) {
      if (isCurrent())
        setStatus(error instanceof Error ? error.message : "元に戻せませんでした。", true);
    } finally {
      if (!disposed && id === sequence) {
        busy = false;
        update();
      }
    }
  });
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("resize", syncViewport);
  visualViewport?.addEventListener("resize", syncViewport);
  visualViewport?.addEventListener("scroll", syncViewport);
  update();
  void refreshCapabilities();
  return {
    refreshCapabilities,
    invalidateSuggestions() {
      clearSuggestions();
      const generation = suggestionSequence;
      // 失効と中止は即時に行い、別フレームにまたがる連続更新の取得だけをまとめる。
      if (!dialog.open || disposed || accountInvalid || !capabilities?.enabled) return;
      suggestionRefreshTimer = setTimeout(() => {
        suggestionRefreshTimer = undefined;
        if (generation === suggestionSequence && dialog.open && !disposed && !accountInvalid)
          void refreshSuggestions();
      }, SUGGESTION_REFRESH_DELAY_MS);
    },
    async applyPreset(presetId: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (disposed || accountInvalid || busy || pendingWrite?.attempted)
        throw Error("現在のAI処理を完了してから条件を適用してください。");
      if (!presetId || presetId.length > 128) throw Error("保存条件のIDが不正です。");
      if (!dialog.open) dialog.showModal();
      const key = options.getContextKey(),
        context = structuredClone(options.getContext());
      const abort = () => cancel();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await withPanelRequest(
          key,
          async (controller, id) => {
            const current = await loadCapabilities(controller);
            assertCurrent(id, key, controller);
            if (!current.enabled || current.protocol_version !== 2)
              throw Error("AIで保存した条件の適用にはAI機能の有効化とアプリの更新が必要です。");
            void refreshSuggestions();
            await execute(
              { type: "apply_preset", preset_id: presetId },
              current.revision,
              context,
              id,
              key,
              controller,
            );
          },
          true,
        );
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    open(trigger?: HTMLElement) {
      if (disposed) return;
      syncViewport();
      opener =
        trigger ||
        (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
      if (!dialog.open) dialog.showModal();
      setStatus(capabilities?.enabled ? "" : "AIの利用設定を確認しています…");
      void refreshCapabilities().then(() => {
        if (dialog.open && capabilities && !capabilities.enabled)
          setStatus("管理者がAI機能を無効にしています。");
        if (dialog.open) void refreshSuggestions();
      });
      draft.focus();
    },
    close,
    clear() {
      close();
      clearSuggestions();
      ++scopeGeneration;
      history.length = 0;
      undos.length = 0;
      appliedState = { filter: null, color: null };
      pendingWrite = undefined;
      panel.replaceChildren();
      log.replaceChildren();
      draft.value = "";
      update();
      void refreshCapabilities();
    },
    dispose() {
      disposed = true;
      clearSuggestions();
      ++scopeGeneration;
      cancel();
      capabilityRequest?.abort();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
      dialog.remove();
    },
  };
}
