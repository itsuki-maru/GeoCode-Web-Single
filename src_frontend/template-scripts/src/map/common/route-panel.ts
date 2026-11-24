import { makeSummaryDraggable } from "./draggable-summary";
import css from "./route-search.css?inline";

export function createRoutePanel({
  mapElement,
  print = false,
  onPositionChange,
}: {
  mapElement: HTMLElement;
  print?: boolean;
  onPositionChange?: () => void;
}) {
  const doc = mapElement.ownerDocument;
  const overlay = doc.createElement("div");
  overlay.className = "route-search-overlay";
  overlay.classList.toggle("route-search-overlay-print", print);

  const element = doc.createElement("section");
  element.className = "route-search-panel";
  element.setAttribute("aria-label", "経路検索結果");
  const handle = doc.createElement("strong");
  handle.className = "route-search-handle";
  handle.textContent = "経路";
  const body = doc.createElement("div");
  body.className = "route-search-body";
  const actions = doc.createElement("div");
  actions.className = "route-search-actions";
  const status = doc.createElement("p");
  status.className = "route-search-status";
  status.setAttribute("role", "status");
  const warningList = doc.createElement("ul");
  warningList.className = "route-search-warnings";
  body.append(actions, status, warningList);
  element.append(handle, body);
  overlay.append(element);

  for (const event of [
    "click",
    "dblclick",
    "contextmenu",
    "mousedown",
    "touchstart",
    "touchmove",
    "touchend",
    "pointerdown",
    "wheel",
  ]) {
    element.addEventListener(event, (input) => input.stopPropagation());
  }

  let stopDrag: (() => void) | undefined;
  let attributionResize: ResizeObserver | undefined;
  let printPosition: { x: number; y: number } | undefined;
  const show = () => {
    if (stopDrag) return;
    if (!doc.getElementById("route-search-style")) {
      const style = doc.createElement("style");
      style.id = "route-search-style";
      style.textContent = css;
      doc.head.append(style);
    }
    const attribution = mapElement.querySelector<HTMLElement>(".leaflet-control-attribution");
    if (attribution) {
      const reserveAttribution = () => {
        overlay.style.setProperty("--route-attribution-height", `${attribution.offsetHeight}px`);
      };
      reserveAttribution();
      if (typeof ResizeObserver !== "undefined") {
        attributionResize = new ResizeObserver(reserveAttribution);
        attributionResize.observe(attribution);
      }
    }
    mapElement.append(overlay);
    stopDrag = makeSummaryDraggable(element, overlay, onPositionChange, printPosition, handle);
  };
  const hide = () => {
    stopDrag?.();
    stopDrag = undefined;
    attributionResize?.disconnect();
    attributionResize = undefined;
    overlay.remove();
    // 印刷プレビューで背景を切り替えても、用紙上の位置を保つ。
    if (print) {
      const x = parseFloat(element.style.left);
      const y = parseFloat(element.style.top);
      if (Number.isFinite(x) && Number.isFinite(y)) printPosition = { x, y };
    }
    element.removeAttribute("style");
    overlay.style.removeProperty("--route-attribution-height");
  };
  const getBottomInset = () => {
    const style = doc.defaultView?.getComputedStyle(overlay);
    const bottom = style?.bottom ?? "";
    const margin = parseFloat(style?.getPropertyValue("--route-panel-margin") ?? "");
    return (bottom.endsWith("px") ? parseFloat(bottom) : 0) + (margin || 0);
  };
  return { element, actions, status, warningList, show, hide, dispose: hide, getBottomInset };
}
