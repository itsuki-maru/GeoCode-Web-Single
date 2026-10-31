import { escapeHtml } from "./marker";
import { releaseDeferredDetails, disposeMapContent, registerProgressiveHtml } from "./content";
import { updatePopupLayout } from "./popup-layout";

export interface PopupBody {
  body?: string;
  free_text: string;
  managed_markdown: string;
  sync_required: boolean;
}
export type PopupBodies = Record<string, PopupBody>;
type Content = { kind: "marker" | "shape"; id: string; name: string; body: string };
type MarkdownReferences = Record<string, { href: string; title: string | null }>;
type RenderMarkdown = (markdown: string, links?: MarkdownReferences) => string;
interface Options {
  map: { on(event: string, fn: (event: any) => void): void };
  renderMarkdown: RenderMarkdown;
  sanitizeHtml(html: string): string;
  setupImages(root: ParentNode, render?: RenderMarkdown): void;
  loadBody?(kind: string, id: string): Promise<PopupBody>;
  snapshot?: PopupBodies;
  analysis?: Record<string, string>;
  answerMap?: boolean;
}

export function isPopupBody(value: any): value is PopupBody {
  return (
    !!value &&
    typeof value.free_text === "string" &&
    typeof value.managed_markdown === "string" &&
    typeof value.sync_required === "boolean" &&
    (value.body === undefined || typeof value.body === "string")
  );
}

// 所有者用の五つの地図ページでのみ設定する。内容はページに既存の Markdown サニタイザーで描画し、
// ツールバーはユーザーの Markdown の外側に構築する。
export function createPopupContentRuntime(options: Options) {
  const contents = new Map<string, Content & { html: string }>();
  const analysis = new Map<string, string>(Object.entries(options.analysis || {}));
  const cache = new Map<string, { body: string; pending: Promise<PopupBody> }>();
  const sessions = new WeakMap<HTMLElement, { dispose(): void }>();
  const activeSessions = new Set<{ dispose(): void }>();
  const stopToolbarEvent = (event: Event) => event.stopPropagation();
  const render = (content: Content) => {
    const key = `${content.kind}:${content.id}`;
    const previous = contents.get(key);
    if (previous?.body === content.body && previous.name === content.name) return previous.html;
    if (previous) releaseDeferredDetails(previous.html);
    const html = `<div class="geocode-content-popup" data-content-key="${escapeHtml(key)}">
      <div class="popup-content-toolbar"><label>表示内容<select aria-label="表示内容">
        <option value="free" disabled>自由入力の内容</option>
        <option value="answers" disabled>フォームからの回答</option>
        <option value="normal" selected>通常表示</option>
      </select></label></div><span class="popup-content-print-label">通常表示</span>
      <div class="popup-content-analysis"></div>
      <h1 class="popup-content-title">${escapeHtml(content.name)}</h1>
      <p class="popup-content-note" role="status"></p>
      <div class="md-detail-contents popup-content-body">${content.body.trim() ? options.renderMarkdown(content.body) : "内容はありません。"}</div></div>`;
    contents.set(key, { ...content, html });
    return html;
  };
  const onOpen = async (event: any) => {
    const popup = event.popup;
    const root = popup
      ?.getElement?.()
      ?.querySelector(".geocode-content-popup") as HTMLElement | null;
    if (!root) return;
    const key = root.dataset.contentKey!;
    const content = contents.get(key);
    if (!content) return;
    if (sessions.has(root)) return;
    const select = root.querySelector<HTMLSelectElement>("select")!;
    const note = root.querySelector<HTMLElement>(".popup-content-note")!;
    const body = root.querySelector<HTMLElement>(".popup-content-body")!;
    const printLabel = root.querySelector<HTMLElement>(".popup-content-print-label")!;
    const analysisElement = root.querySelector<HTMLElement>(".popup-content-analysis")!;
    const normalBodyHtml = body.innerHTML;
    const toolbar = root.querySelector(".popup-content-toolbar")!;
    const toolbarEvents = ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "wheel"];
    let displayedMode = "normal";
    let transientHtml = "";
    let analysisHtml = "";
    const session = {
      dispose: () => {
        select.onchange = null;
        for (const type of toolbarEvents) toolbar.removeEventListener(type, stopToolbarEvent);
        root.removeEventListener("geocode:contentchange", update);
        disposeMapContent(root);
        releaseDeferredDetails(transientHtml);
        releaseDeferredDetails(analysisHtml);
        transientHtml = "";
        sessions.delete(root);
        activeSessions.delete(session);
      },
    };
    sessions.set(root, session);
    activeSessions.add(session);
    const update = () => {
      updatePopupLayout(popup, root);
    };
    root.addEventListener("geocode:contentchange", update);
    select.value = "normal";
    for (const option of Array.from(select.options)) option.disabled = option.value !== "normal";
    const analysisContent = analysis.get(key) || "";
    analysisHtml = analysisContent
      ? registerProgressiveHtml(analysisContent, options.sanitizeHtml)
      : "";
    analysisElement.innerHTML = analysisHtml;
    printLabel.textContent = "通常表示";
    note.textContent = "表示内容を確認しています…";
    // キーボードのフォーカスを閉じ込めず、選択欄の操作中に地図がドラッグやズームされることを防ぐ。
    for (const type of toolbarEvents) toolbar.addEventListener(type, stopToolbarEvent);
    // 最初の画像の一括読み込みで、ポップアップのレイアウトが同期的に更新される場合がある。
    // Leaflet が準備済みの文字列を復元しないよう、初期化前に実際のノードを保持する。
    if (popup.setContent) popup.setContent(root);
    else update();
    options.setupImages(root, options.renderMarkdown);
    try {
      let info: PopupBody;
      if (options.snapshot !== undefined) {
        info = options.snapshot[key];
      } else {
        let cached = cache.get(key);
        if (!cached || cached.body !== content.body) {
          const pending = options.loadBody!(content.kind, content.id);
          cached = { body: content.body, pending };
          cache.set(key, cached);
          pending.catch(() => {
            if (cache.get(key)?.pending === pending) cache.delete(key);
          });
        }
        cache.delete(key);
        cache.set(key, cached);
        while (cache.size > 32) cache.delete(cache.keys().next().value!);
        info = await cached.pending;
      }
      if (sessions.get(root) !== session || !root.isConnected) return;
      if (!isPopupBody(info)) throw Error("Invalid popup body");
      if (info.body !== undefined && info.body !== content.body) {
        note.textContent = "内容が更新されています。地図を再読み込みしてから切り替えてください。";
        update();
        return;
      }
      if (info.sync_required) {
        note.textContent =
          "本文と回答の対応を確認できないため、通常表示のみ利用できます。回答一覧の編集から確認してください。";
        update();
        return;
      }
      for (const option of Array.from(select.options)) option.disabled = false;
      const show = () => {
        if (sessions.get(root) !== session || !root.isConnected) return;
        const mode = select.value;
        const markdown =
          mode === "free"
            ? info.free_text
            : mode === "answers"
              ? info.managed_markdown
              : content.body;
        if (mode !== displayedMode) {
          disposeMapContent(body);
          releaseDeferredDetails(transientHtml);
          transientHtml = "";
          if (mode === "normal") body.innerHTML = normalBodyHtml;
          else {
            transientHtml = markdown.trim()
              ? options.renderMarkdown(markdown)
              : mode === "free"
                ? "自由入力の内容はありません。"
                : "フォームからの回答はありません。";
            body.innerHTML = transientHtml;
          }
          displayedMode = mode;
          options.setupImages(root, options.renderMarkdown);
        }
        note.textContent =
          mode === "answers" && options.answerMap
            ? "この対象の回答をすべて表示します。絞り込み・分析に使用した回答だけには限定しません。"
            : "";
        printLabel.textContent = select.selectedOptions[0]?.textContent || "通常表示";
        update();
      };
      select.onchange = show;
      show();
    } catch {
      if (sessions.get(root) !== session || !root.isConnected) return;
      note.textContent =
        "表示内容を取得できないため、通常表示のみ利用できます。開き直して再試行してください。";
      update();
    }
  };
  options.map.on("popupopen", (event) => void onOpen(event));
  options.map.on("popupclose", (event) => {
    const root = event.popup?.getElement?.()?.querySelector(".geocode-content-popup");
    if (root) {
      sessions.get(root)?.dispose();
      const content = contents.get(root.dataset.contentKey!);
      // ポップアップが閉じている間は、準備済みの折りたたんだ HTML だけを保持する。
      // 表示したマーカーを切り替えるたびに、展開済みの画像 DOM が蓄積しないようにする。
      if (content) event.popup.setContent?.(content.html);
    }
  });
  const release = (kind: "marker" | "shape", id: string) => {
    const key = `${kind}:${id}`;
    const content = contents.get(key);
    if (content) releaseDeferredDetails(content.html);
    contents.delete(key);
    cache.delete(key);
  };
  options.map.on("unload", () => {
    [...activeSessions].forEach((session) => session.dispose());
    contents.forEach((content) => releaseDeferredDetails(content.html));
    contents.clear();
    cache.clear();
    analysis.clear();
  });
  return {
    render,
    release,
    setAnalysis: (key: string, html: string) => analysis.set(key, html),
    getAnalysis: () => Object.fromEntries(analysis),
  };
}
