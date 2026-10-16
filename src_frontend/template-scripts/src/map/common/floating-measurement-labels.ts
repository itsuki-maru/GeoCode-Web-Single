interface LatLng {
  lat: number;
  lng: number;
}

interface Point {
  x: number;
  y: number;
}

interface FloatingMarker {
  isMeasurementLabel?: boolean;
  getElement?(): HTMLElement | null;
  getLatLng?(): LatLng;
  setLatLng?(latLng: LatLng): unknown;
  isMeasurementVertex?: boolean;
  measurementLabelVariant?: string;
  on?(event: string, listener: () => void): unknown;
}

interface FloatingMap {
  getContainer?(): HTMLElement;
  latLngToContainerPoint?(latLng: LatLng): Point;
  containerPointToLatLng?(point: Point): LatLng;
  fire?(event: string): unknown;
}

// 手動で移動した位置だけを緯度・経度で保持し、ページの再読み込み時に破棄する。
const positions = new WeakMap<object, Map<string, LatLng>>();

export function hasFloatingMeasurementLabels(layer: object): boolean {
  return Boolean(positions.get(layer)?.size);
}

export function bindFloatingMeasurementLabels<T extends FloatingMarker>(
  layer: object,
  markers: T[],
  map: FloatingMap,
  merged: boolean,
): T[] {
  if (!map.getContainer || !map.latLngToContainerPoint || !map.containerPointToLatLng)
    return markers;
  const container = map.getContainer();
  let saved = positions.get(layer);
  if (!saved) {
    saved = new Map();
    positions.set(layer, saved);
  }
  const labelPositions = saved;
  let segmentIndex = 0;
  for (const marker of markers) {
    if (
      !marker?.isMeasurementLabel ||
      marker.isMeasurementVertex ||
      !marker.on ||
      !marker.getLatLng ||
      !marker.setLatLng
    )
      continue;
    const variant = marker.measurementLabelVariant ?? "segment";
    const key =
      variant === "segment" ? `${merged ? "merged" : "separate"}:${segmentIndex++}` : variant;
    // 図形から離れた位置へ移動したラベルも含め、表示範囲で絞り込む前に位置を復元する。
    const position = labelPositions.get(key);
    if (position) marker.setLatLng(position);
    let cleanup: (() => void) | undefined;
    const remove = () => {
      cleanup?.();
      cleanup = undefined;
    };
    marker.on("add", () => {
      remove();
      const panel = marker.getElement?.()?.querySelector<HTMLElement>(".shape-measure-label");
      if (!panel) return;
      const previousStyle = panel.getAttribute("style");
      const previousTitle = panel.getAttribute("title");
      // 地図移動や拡縮アニメーションに追従できるよう、ラベルを Leaflet のマーカー表示領域内に置く。
      Object.assign(panel.style, {
        pointerEvents: "auto",
        userSelect: "none",
        touchAction: "none",
        cursor: "grab",
      });
      panel.title = "ドラッグして移動";
      let drag: { id: number; clientX: number; clientY: number; anchor: LatLng } | null = null;
      const down = (event: PointerEvent) => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        event.stopPropagation();
        const anchor = marker.getLatLng!();
        drag = {
          id: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          anchor: { lat: anchor.lat, lng: anchor.lng },
        };
        panel.style.cursor = "grabbing";
        panel.setPointerCapture(event.pointerId);
      };
      const move = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = container.getBoundingClientRect();
        // 印刷プレビューの CSS による拡縮を考慮し、画面上の移動量を地図のピクセル数へ換算する。
        const scaleX = bounds.width / container.offsetWidth || 1;
        const scaleY = bounds.height / container.offsetHeight || 1;
        const anchor = map.latLngToContainerPoint!(drag.anchor);
        const latLng = map.containerPointToLatLng!({
          x: anchor.x + (event.clientX - drag.clientX) / scaleX,
          y: anchor.y + (event.clientY - drag.clientY) / scaleY,
        });
        marker.setLatLng!(latLng);
        labelPositions.set(key, { lat: latLng.lat, lng: latLng.lng });
        map.fire?.("measurementlabelmove");
      };
      const finish = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        panel.style.cursor = "grab";
        if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
      };
      const stop = (event: Event) => event.stopPropagation();
      const blockedEvents = [
        "click",
        "dblclick",
        "contextmenu",
        "mousedown",
        "touchstart",
        "wheel",
      ];
      blockedEvents.forEach((name) => panel.addEventListener(name, stop));
      panel.addEventListener("pointerdown", down);
      panel.addEventListener("pointermove", move);
      panel.addEventListener("pointerup", finish);
      panel.addEventListener("pointercancel", finish);
      panel.addEventListener("lostpointercapture", finish);
      cleanup = () => {
        if (drag && panel.hasPointerCapture(drag.id)) panel.releasePointerCapture(drag.id);
        drag = null;
        blockedEvents.forEach((name) => panel.removeEventListener(name, stop));
        panel.removeEventListener("pointerdown", down);
        panel.removeEventListener("pointermove", move);
        panel.removeEventListener("pointerup", finish);
        panel.removeEventListener("pointercancel", finish);
        panel.removeEventListener("lostpointercapture", finish);
        if (previousStyle === null) panel.removeAttribute("style");
        else panel.setAttribute("style", previousStyle);
        if (previousTitle === null) panel.removeAttribute("title");
        else panel.setAttribute("title", previousTitle);
      };
    });
    marker.on("remove", remove);
  }
  return markers;
}
