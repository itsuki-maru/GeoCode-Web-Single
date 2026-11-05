import css from "./color-legend.css?inline";
import { makeSummaryDraggable } from "./draggable-summary";

export interface ColorLegendEntry {
  id: string;
  label: string;
  color: string;
  hidden?: boolean;
}

const MIN_WIDTH = 160;
const MIN_HEIGHT = 70;
const EDGE_SPACE = 20;
const clamp = (value: number, min: number, max: number) =>
  Math.max(Math.min(min, max), Math.min(value, max));

export function createColorLegend({
  mapElement,
  mode = "map",
  onChange = () => {},
}: {
  mapElement: HTMLElement;
  mode?: "map" | "print";
  onChange?: () => void;
}) {
  const doc = mapElement.ownerDocument;
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.append(style);
  const print = mode === "print";
  const panel = doc.createElement("section");
  panel.className = `map-color-legend ${print ? "answer-print-legend" : "map-color-legend-live"}`;
  panel.setAttribute("aria-label", "色分けの凡例");
  panel.style.fontSize = "12px";
  panel.hidden = true;
  const title = doc.createElement("strong");
  title.className = `map-color-legend-handle${print ? " answer-print-legend-handle" : ""}`;
  title.textContent = "凡例";
  const list = doc.createElement("ul");
  list.className = "map-color-legend-entries";
  const grip = doc.createElement("button");
  grip.type = "button";
  grip.className = "map-color-legend-resize";
  grip.setAttribute("aria-label", "凡例のサイズを変更");
  grip.title = "ドラッグまたは矢印キーでサイズを変更";
  if (print) grip.setAttribute("data-html2canvas-ignore", "");
  panel.append(title, list, grip);
  mapElement.append(panel);

  const rows = new Map<
    string,
    {
      item: HTMLLIElement;
      swatch: HTMLSpanElement;
      label: HTMLSpanElement;
    }
  >();
  let disposed = false;
  let visible = true;
  let stopDrag: (() => void) | undefined;
  let resizing: {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
  } | null = null;

  const finishResize = () => {
    const id = resizing?.id;
    resizing = null;
    if (id !== undefined && grip.hasPointerCapture?.(id)) grip.releasePointerCapture(id);
  };
  const updateVisibility = () => {
    panel.hidden = !visible || ![...rows.values()].some(({ item }) => !item.hidden);
    if (panel.hidden) {
      finishResize();
      return;
    }
    if (!stopDrag) {
      // 出典、現在地、地図機能のボタンを避け、下端のコントロールより上に置く。
      const bottomSpace = Math.max(
        44,
        ...[...mapElement.querySelectorAll<HTMLElement>(".leaflet-bottom")].map(
          (corner) => corner.offsetHeight + 8,
        ),
      );
      const position = print
        ? { x: 10, y: 10 }
        : {
            x: mapElement.clientWidth - panel.offsetWidth - 10,
            y: mapElement.clientHeight - panel.offsetHeight - bottomSpace,
          };
      stopDrag = makeSummaryDraggable(panel, mapElement, onChange, position, title);
    }
  };
  const setEntries = (entries: readonly ColorLegendEntry[]) => {
    if (disposed) return;
    const ids = new Set(entries.map(({ id }) => id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.item.remove();
      rows.delete(id);
    }
    let next = list.firstElementChild;
    for (const entry of entries) {
      let row = rows.get(entry.id);
      if (!row) {
        const item = doc.createElement("li");
        const swatch = doc.createElement("span");
        swatch.className = `map-color-legend-swatch${print ? " answer-print-legend-swatch" : ""}`;
        swatch.setAttribute("aria-hidden", "true");
        const label = doc.createElement("span");
        label.className = "map-color-legend-label";
        item.append(swatch, label);
        row = { item, swatch, label };
        rows.set(entry.id, row);
      }
      if (row.label.textContent !== entry.label) row.label.textContent = entry.label;
      row.swatch.style.backgroundColor = entry.color;
      row.item.hidden = Boolean(entry.hidden);
      if (row.item !== next) list.insertBefore(row.item, next);
      next = row.item.nextElementSibling;
    }
    updateVisibility();
  };

  const getSize = () => `${panel.offsetWidth}:${panel.offsetHeight}`;
  let previousSize = getSize();
  const checkSize = () => {
    if (disposed || panel.hidden) return;
    const size = getSize();
    if (size === previousSize) return;
    previousSize = size;
    onChange();
  };
  const resizeTo = (width: number, height: number) => {
    panel.classList.add("map-color-legend-user-size");
    panel.style.width = `${clamp(width, MIN_WIDTH, Math.max(0, mapElement.clientWidth - EDGE_SPACE))}px`;
    panel.style.height = `${clamp(height, MIN_HEIGHT, Math.max(0, mapElement.clientHeight - EDGE_SPACE))}px`;
    checkSize();
  };
  const resizeStart = (event: PointerEvent) => {
    if (event.button !== 0 || resizing || panel.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = mapElement.getBoundingClientRect();
    resizing = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      // 用紙がCSSで縮小されていても、操作量は地図のピクセル座標へ戻す。
      scaleX: bounds.width && mapElement.offsetWidth ? bounds.width / mapElement.offsetWidth : 1,
      scaleY:
        bounds.height && mapElement.offsetHeight ? bounds.height / mapElement.offsetHeight : 1,
    };
    grip.setPointerCapture?.(event.pointerId);
  };
  const resizeMove = (event: PointerEvent) => {
    if (!resizing || event.pointerId !== resizing.id) return;
    event.preventDefault();
    event.stopPropagation();
    resizeTo(
      resizing.width + (event.clientX - resizing.x) / resizing.scaleX,
      resizing.height + (event.clientY - resizing.y) / resizing.scaleY,
    );
  };
  const resizeEnd = (event: PointerEvent) => {
    if (event.pointerId === resizing?.id) finishResize();
  };
  const resizeByKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 24 : 8;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    event.stopPropagation();
    resizeTo(panel.offsetWidth + dx, panel.offsetHeight + dy);
  };
  grip.addEventListener("pointerdown", resizeStart);
  grip.addEventListener("pointermove", resizeMove);
  const finishEvents = ["pointerup", "pointercancel", "lostpointercapture"] as const;
  for (const event of finishEvents) grip.addEventListener(event, resizeEnd);
  grip.addEventListener("keydown", resizeByKey);

  // 一覧のスクロールやパネル操作を、背面地図の移動・ズームへ伝播させない。
  const stop = (event: Event) => event.stopPropagation();
  const mapEvents = [
    "click",
    "dblclick",
    "wheel",
    "mousedown",
    "touchstart",
    "pointerdown",
  ] as const;
  for (const event of mapEvents) panel.addEventListener(event, stop);
  const observer = new ResizeObserver(checkSize);
  observer.observe(mapElement);
  observer.observe(panel);

  const overflows = (element: HTMLElement) =>
    element.scrollHeight > element.clientHeight + 1 ||
    element.scrollWidth > element.clientWidth + 1;
  return {
    setEntries,
    setVisible(value: boolean) {
      if (disposed) return;
      visible = value;
      updateVisibility();
    },
    setFontSize(size: number) {
      if (!disposed) panel.style.fontSize = `${size}px`;
    },
    hasOverflow: () => !disposed && !panel.hidden && (overflows(panel) || overflows(list)),
    dispose() {
      if (disposed) return;
      disposed = true;
      finishResize();
      stopDrag?.();
      observer.disconnect();
      grip.removeEventListener("pointerdown", resizeStart);
      grip.removeEventListener("pointermove", resizeMove);
      for (const event of finishEvents) grip.removeEventListener(event, resizeEnd);
      grip.removeEventListener("keydown", resizeByKey);
      for (const event of mapEvents) panel.removeEventListener(event, stop);
      rows.clear();
      panel.remove();
      style.remove();
    },
  };
}
