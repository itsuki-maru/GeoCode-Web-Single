// Ported from Margin Text Writer v2.0.2. See licenses/MarginTextWriter.txt.
import { makeSummaryDraggable } from "../common/draggable-summary";

const STORAGE_KEY = "geocode-web:print-memo";
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

function loadText() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveText(text: string) {
  try {
    if (text) window.localStorage.setItem(STORAGE_KEY, text);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ストレージを利用できない環境でも、この画面での編集と出力は続けられる。
  }
}

function mountMemo(mapElement: HTMLElement, onChange: () => void, remove: () => void) {
  const panel = document.createElement("div");
  panel.id = "print-memo";
  panel.className = "print-memo";
  panel.innerHTML = `
    <div class="print-memo-toolbar" role="group" aria-label="メモの編集">
      <button type="button" data-size-up aria-label="文字を拡大" title="文字を拡大 (Ctrl+Shift+B)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7V4h16v3 M9 20h6 M12 4v16"/>
          <line x1="17" y1="7" x2="23" y2="7"/><line x1="20" y1="4" x2="20" y2="10"/>
        </svg>
      </button>
      <span class="print-memo-font-size"></span>
      <button type="button" data-size-down aria-label="文字を縮小" title="文字を縮小 (Ctrl+Shift+S)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7V4h16v3 M9 20h6 M12 4v16"/><line x1="17" y1="7" x2="23" y2="7"/>
        </svg>
      </button>
      <button type="button" data-bold aria-label="太字" title="太字の切り替え">B</button>
      <button type="button" data-underline aria-label="下線" title="下線の切り替え (Ctrl+Shift+U)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>
        </svg>
      </button>
      <button type="button" data-border aria-label="印刷時の枠線" title="印刷時の枠線 (Ctrl+Shift+L)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
        </svg>
      </button>
      <span class="print-memo-separator"></span>
      <label class="print-memo-color">文字色<input type="color" value="#000000" title="文字色を選択"></label>
      <button type="button" data-white-background title="白背景と透明背景を切り替え">白背景</button>
      <span class="print-memo-separator"></span>
      <button type="button" data-remove aria-label="メモを削除" title="メモを削除 (Ctrl+Shift+D)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>
    </div>
    <div class="print-memo-body" data-underline data-white-background>
      <div class="print-memo-text" data-border></div>
      <textarea class="print-memo-editor" rows="1" aria-label="印刷メモ" placeholder="ここにテキストを入力…"></textarea>
    </div>`;

  const toolbar = panel.querySelector<HTMLElement>(".print-memo-toolbar")!;
  const body = panel.querySelector<HTMLElement>(".print-memo-body")!;
  const text = panel.querySelector<HTMLElement>(".print-memo-text")!;
  const editor = panel.querySelector<HTMLTextAreaElement>(".print-memo-editor")!;
  const sizeLabel = panel.querySelector<HTMLElement>(".print-memo-font-size")!;
  const sizeUp = toolbar.querySelector<HTMLButtonElement>("[data-size-up]")!;
  const sizeDown = toolbar.querySelector<HTMLButtonElement>("[data-size-down]")!;
  const removeButton = toolbar.querySelector<HTMLButtonElement>("[data-remove]")!;
  const colorPicker = toolbar.querySelector<HTMLInputElement>('input[type="color"]')!;
  const bindFormatToggle = (attribute: string, target: HTMLElement) => {
    const button = toolbar.querySelector<HTMLButtonElement>(`[${attribute}]`)!;
    button.setAttribute("aria-pressed", String(target.hasAttribute(attribute)));
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(target.toggleAttribute(attribute)));
      onChange();
    });
    return button;
  };
  bindFormatToggle("data-bold", body);
  const underline = bindFormatToggle("data-underline", body);
  const border = bindFormatToggle("data-border", text);
  bindFormatToggle("data-white-background", body);
  const shortcuts = new Map([
    ["b", sizeUp],
    ["s", sizeDown],
    ["u", underline],
    ["l", border],
    ["d", removeButton],
  ]);

  let fontSize = 14;
  const renderFontSize = () => {
    body.style.fontSize = `${fontSize}px`;
    sizeLabel.textContent = `${fontSize}px`;
    sizeUp.disabled = fontSize === MAX_FONT_SIZE;
    sizeDown.disabled = fontSize === MIN_FONT_SIZE;
  };
  renderFontSize();
  const changeFontSize = (delta: number) => {
    fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize + delta));
    renderFontSize();
    onChange();
  };
  sizeUp.addEventListener("click", () => changeFontSize(1));
  sizeDown.addEventListener("click", () => changeFontSize(-1));
  const applyColor = () => {
    const previous = body.style.color;
    body.style.color = colorPicker.value;
    if (body.style.color !== previous) onChange();
  };
  colorPicker.addEventListener("input", applyColor);
  colorPicker.addEventListener("change", applyColor);
  removeButton.addEventListener("click", remove);

  // 同じ幅・書式の本文で高さを決め、印刷とPDFではその本文を描画する。
  const renderText = () => {
    text.textContent = editor.value;
    text.toggleAttribute("data-empty", !editor.value.trim());
  };
  const updateText = (event: Event) => {
    renderText();
    if (!(event instanceof InputEvent && event.isComposing)) saveText(editor.value);
    onChange();
  };
  editor.value = loadText();
  renderText();
  editor.addEventListener("input", updateText);
  editor.addEventListener("compositionend", updateText);

  const stop = (event: Event) => event.stopPropagation();
  for (const event of [
    "click",
    "dblclick",
    "contextmenu",
    "wheel",
    "mousedown",
    "touchstart",
    "pointerdown",
  ]) {
    panel.addEventListener(event, stop);
  }
  for (const control of toolbar.querySelectorAll("button, label")) {
    control.addEventListener("pointerdown", stop);
  }
  panel.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "escape" || (key === "p" && (event.ctrlKey || event.metaKey))) return;
    event.stopPropagation();
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.isComposing)
      return;
    const button = shortcuts.get(key);
    if (!button) return;
    event.preventDefault();
    button.click();
  });

  mapElement.append(panel);
  const stopDrag = makeSummaryDraggable(
    panel,
    mapElement,
    onChange,
    { x: mapElement.clientWidth - panel.offsetWidth - 16, y: 16 },
    toolbar,
  );
  return {
    editor,
    hasOverflow: () => !text.hasAttribute("data-empty") && text.offsetHeight > body.clientHeight,
    dispose() {
      stopDrag();
      panel.remove();
    },
  };
}

export function createPrintMemo(
  addButton: HTMLButtonElement,
  mapElement: HTMLElement,
  onChange: () => void,
) {
  let memo: ReturnType<typeof mountMemo> | undefined;
  const close = () => {
    memo?.dispose();
    memo = undefined;
    addButton.setAttribute("aria-expanded", "false");
    addButton.removeAttribute("aria-controls");
  };
  const remove = () => {
    close();
    saveText("");
    addButton.focus();
    onChange();
  };
  const add = () => {
    if (!memo) {
      memo = mountMemo(mapElement, onChange, remove);
      addButton.setAttribute("aria-expanded", "true");
      addButton.setAttribute("aria-controls", "print-memo");
      onChange();
    }
    memo.editor.focus();
  };
  addButton.addEventListener("click", add);
  return {
    hasOverflow: () => memo?.hasOverflow() ?? false,
    dispose() {
      addButton.removeEventListener("click", add);
      close();
    },
  };
}
