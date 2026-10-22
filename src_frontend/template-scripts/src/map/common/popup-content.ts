import { escapeHtml } from "./marker";

export interface PopupBody {
  body?: string;
  free_text: string;
  managed_markdown: string;
  sync_required: boolean;
}
export type PopupBodies = Record<string, PopupBody>;
type Content = { kind: "marker" | "shape"; id: string; name: string; body: string };
interface Options {
  map: { on(event: string, fn: (event: any) => void): void };
  renderMarkdown(markdown: string): string;
  sanitizeHtml(html: string): string;
  setupImages(root: ParentNode): void;
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

// Installed only by the five owner map pages. Content is rendered with the page's
// existing Markdown sanitizer; the toolbar is built outside user Markdown.
export function createPopupContentRuntime(options: Options) {
  const contents = new Map<string, Content>();
  const analysis = new Map<string, string>(Object.entries(options.analysis || {}));
  const cache = new Map<string, Promise<PopupBody>>();
  const sessions = new WeakMap<HTMLElement, object>();
  const stopToolbarEvent = (event: Event) => event.stopPropagation();
  const render = (content: Content) => {
    const key = `${content.kind}:${content.id}`;
    contents.set(key, { ...content });
    return `<div class="geocode-content-popup" data-content-key="${escapeHtml(key)}">
      <div class="popup-content-toolbar"><label>表示内容<select aria-label="表示内容">
        <option value="free" disabled>自由入力の内容</option>
        <option value="answers" disabled>フォームからの回答</option>
        <option value="normal" selected>通常表示</option>
      </select></label></div><span class="popup-content-print-label">通常表示</span>
      <div class="popup-content-analysis"></div>
      <h1 class="popup-content-title">${escapeHtml(content.name)}</h1>
      <p class="popup-content-note" role="status"></p>
      <div class="md-detail-contents popup-content-body">${options.renderMarkdown(content.body)}</div></div>`;
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
    // Leaflet.update() re-applies string content. Retain the live node so layout
    // updates never replace the select or discard its change handler.
    popup.setContent?.(root);
    const session = {};
    sessions.set(root, session);
    const select = root.querySelector<HTMLSelectElement>("select")!;
    const note = root.querySelector<HTMLElement>(".popup-content-note")!;
    const body = root.querySelector<HTMLElement>(".popup-content-body")!;
    const printLabel = root.querySelector<HTMLElement>(".popup-content-print-label")!;
    const analysisElement = root.querySelector<HTMLElement>(".popup-content-analysis")!;
    const update = () => {
      const focused = root.ownerDocument.activeElement as HTMLElement | null;
      options.setupImages(root);
      popup.update?.();
      if (focused && root.contains(focused)) focused.focus({ preventScroll: true });
    };
    select.value = "normal";
    for (const option of Array.from(select.options)) option.disabled = option.value !== "normal";
    analysisElement.innerHTML = options.sanitizeHtml(analysis.get(key) || "");
    body.innerHTML = content.body.trim()
      ? options.renderMarkdown(content.body)
      : "内容はありません。";
    printLabel.textContent = "通常表示";
    note.textContent = "表示内容を確認しています…";
    // Prevent map dragging/zooming while operating the select, without trapping keyboard focus.
    for (const type of ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "wheel"])
      root.querySelector(".popup-content-toolbar")!.addEventListener(type, stopToolbarEvent);
    update();
    try {
      let info: PopupBody;
      if (options.snapshot !== undefined) {
        info = options.snapshot[key];
      } else {
        const cacheKey = `${key}\n${content.body}`;
        let pending = cache.get(cacheKey);
        if (!pending) {
          pending = options.loadBody!(content.kind, content.id);
          cache.set(cacheKey, pending);
          pending.catch(() => cache.delete(cacheKey));
        }
        info = await pending;
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
        const mode = select.value;
        const markdown =
          mode === "free"
            ? info.free_text
            : mode === "answers"
              ? info.managed_markdown
              : content.body;
        body.innerHTML = markdown.trim()
          ? options.renderMarkdown(markdown)
          : mode === "free"
            ? "自由入力の内容はありません。"
            : mode === "answers"
              ? "フォームからの回答はありません。"
              : "内容はありません。";
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
      sessions.delete(root);
      const select = root.querySelector("select");
      if (select) select.onchange = null;
    }
  });
  return {
    render,
    setAnalysis: (key: string, html: string) => analysis.set(key, html),
    getAnalysis: () => Object.fromEntries(analysis),
  };
}
