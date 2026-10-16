// 初期表示時、または最初のドラッグ後から地図枠内に浮かせて表示する。
export function makeSummaryDraggable(
  panel: HTMLElement,
  mapElement: HTMLElement,
  onPositionChange: () => void = () => {},
  initialPosition?: { x: number; y: number },
) {
  let floating = false;
  let drag: { id: number; offsetX: number; offsetY: number } | null = null;
  panel.style.cursor = "grab";
  panel.style.touchAction = "none";
  panel.title = "ドラッグして移動";

  // 印刷プレビューでは用紙が CSS で拡縮されるため、位置は拡縮前の地図のピクセル座標で保持する。
  const scaleFor = (bounds: DOMRect) => ({
    x: bounds.width / mapElement.offsetWidth || 1,
    y: bounds.height / mapElement.offsetHeight || 1,
  });

  const place = (x: number, y: number) => {
    const previous = `${panel.style.left}:${panel.style.top}`;
    panel.style.left = `${Math.max(0, Math.min(x, mapElement.clientWidth - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(0, Math.min(y, mapElement.clientHeight - panel.offsetHeight))}px`;
    if (previous !== `${panel.style.left}:${panel.style.top}`) onPositionChange();
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = panel.getBoundingClientRect();
    const mapBounds = mapElement.getBoundingClientRect();
    const scale = scaleFor(mapBounds);
    drag = {
      id: event.pointerId,
      offsetX: (event.clientX - bounds.left) / scale.x,
      offsetY: (event.clientY - bounds.top) / scale.y,
    };
    if (!floating) {
      floating = true;
      mapElement.append(panel);
      Object.assign(panel.style, {
        position: "absolute",
        margin: "0",
        right: "auto",
        bottom: "auto",
        zIndex: "1000",
      });
      place((bounds.left - mapBounds.left) / scale.x, (bounds.top - mapBounds.top) / scale.y);
    }
    panel.style.cursor = "grabbing";
    panel.setPointerCapture(event.pointerId);
  };
  if (initialPosition) {
    floating = true;
    mapElement.append(panel);
    Object.assign(panel.style, {
      position: "absolute",
      margin: "0",
      right: "auto",
      bottom: "auto",
      zIndex: "1000",
    });
    place(initialPosition.x, initialPosition.y);
  }
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = mapElement.getBoundingClientRect();
    const scale = scaleFor(bounds);
    place(
      (event.clientX - bounds.left) / scale.x - drag.offsetX,
      (event.clientY - bounds.top) / scale.y - drag.offsetY,
    );
  };
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    panel.style.cursor = "grab";
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
  };
  const resize = new ResizeObserver(() => {
    if (floating && !panel.hidden) place(parseFloat(panel.style.left), parseFloat(panel.style.top));
  });
  resize.observe(mapElement);
  resize.observe(panel);
  panel.addEventListener("pointerdown", down);
  panel.addEventListener("pointermove", move);
  panel.addEventListener("pointerup", finish);
  panel.addEventListener("pointercancel", finish);
  panel.addEventListener("lostpointercapture", finish);
  return () => {
    if (drag && panel.hasPointerCapture(drag.id)) panel.releasePointerCapture(drag.id);
    drag = null;
    resize.disconnect();
    panel.removeEventListener("pointerdown", down);
    panel.removeEventListener("pointermove", move);
    panel.removeEventListener("pointerup", finish);
    panel.removeEventListener("pointercancel", finish);
    panel.removeEventListener("lostpointercapture", finish);
  };
}
