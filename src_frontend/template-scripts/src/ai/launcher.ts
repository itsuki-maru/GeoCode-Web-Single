import css from "./launcher.css?inline";

export type AiLauncherMode = "desktop" | "mobile" | "standalone";
type Point = { x: number; y: number };
type SavedPosition = Point & { viewportWidth: number; viewportHeight: number };
interface LauncherOptions {
  mode: AiLauncherMode;
  iconUrl: string;
  onActivate(button: HTMLButtonElement): void;
}

export const aiLauncherStorageKey = (mode: AiLauncherMode) =>
  "geocode.ai-launcher.position.v1." + mode;
const SIZE = 77;
const MARGIN = 12;
const DRAG_THRESHOLD = 6;
const CONTROL_GAP = 10;
const CONTROL_SELECTOR = [
  ".header-btn-zone button, .header-btn-zone input, .header-btn-zone select",
  "#search-area button, #search-area select, #function-btn-row button",
  ".other-function-btn-zone button, .other-function-btn-zone a",
  ".map-object-table-toggle",
  ".bottom-navigation button, .bottom-navigation a",
  "nav.app-navigation button, nav.app-navigation a",
  ".leaflet-control button, .leaflet-control a, .leaflet-control input, .leaflet-control select",
].join(",");

/** 起動ボタンの位置だけを保存する。会話・APIキー・アカウント情報は保存しない。 */
export function createAiLauncher(options: LauncherOptions) {
  if (!document.getElementById("geocode-ai-launcher-style")) {
    const style = document.createElement("style");
    style.id = "geocode-ai-launcher-style";
    style.textContent = css;
    document.head.append(style);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-launcher";
  button.dataset.mode = options.mode;
  button.hidden = true;
  button.title = "AIアシスタント（ドラッグして移動）";
  button.setAttribute("aria-label", "AIアシスタント");
  button.setAttribute("aria-haspopup", "dialog");
  const icon = document.createElement("img");
  icon.src = options.iconUrl;
  icon.alt = "";
  icon.draggable = false;
  button.append(icon);
  const safeArea = document.createElement("span");
  safeArea.className = "ai-launcher-safe-area";
  safeArea.setAttribute("aria-hidden", "true");
  document.body.append(safeArea, button);

  let disposed = false;
  let position: Point = { x: 0, y: 0 };
  let preferred: Point | undefined;
  let suppressClick = false;
  let drag:
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        origin: Point;
        moved: boolean;
      }
    | undefined;

  const viewport = () => {
    const visual = window.visualViewport;
    return {
      width: visual?.width || window.innerWidth || document.documentElement.clientWidth || 1024,
      height: visual?.height || window.innerHeight || document.documentElement.clientHeight || 768,
      left: visual?.offsetLeft || 0,
      top: visual?.offsetTop || 0,
    };
  };
  const bounds = () => {
    const view = viewport();
    const safe = getComputedStyle(safeArea);
    const inset = (value: string) => Math.max(0, Number.parseFloat(value) || 0);
    const safeLeft = inset(safe.paddingLeft);
    const safeRight = inset(safe.paddingRight);
    const safeTop = inset(safe.paddingTop);
    const safeBottom = inset(safe.paddingBottom);
    const horizontalMargin = Math.min(
      MARGIN,
      Math.max(0, (view.width - safeLeft - safeRight - SIZE) / 2),
    );
    const verticalMargin = Math.min(
      MARGIN,
      Math.max(0, (view.height - safeTop - safeBottom - SIZE) / 2),
    );
    const left = view.left + safeLeft + horizontalMargin;
    const top = view.top + safeTop + verticalMargin;
    return {
      left,
      top,
      right: Math.max(left, view.left + view.width - safeRight - horizontalMargin - SIZE),
      bottom: Math.max(top, view.top + view.height - safeBottom - verticalMargin - SIZE),
    };
  };
  const clamp = (point: Point, area = bounds()): Point => ({
    x: Math.min(area.right, Math.max(area.left, point.x)),
    y: Math.min(area.bottom, Math.max(area.top, point.y)),
  });
  const avoidControls = (point: Point) => {
    const area = bounds();
    const desired = clamp(point, area);
    // 大きなtoolbarの親枠ではなく、表示・操作される要素だけを避ける。
    const controls = [...document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].flatMap(
      (control) => {
        const rect = control.getBoundingClientRect();
        let { left, right, top, bottom } = rect;
        for (let element: HTMLElement | null = control; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          )
            return [];
          if (element !== control) {
            const clip = element.getBoundingClientRect();
            if (/^(hidden|clip|scroll|auto)$/.test(style.overflowX)) {
              left = Math.max(left, clip.left);
              right = Math.min(right, clip.right);
            }
            if (/^(hidden|clip|scroll|auto)$/.test(style.overflowY)) {
              top = Math.max(top, clip.top);
              bottom = Math.min(bottom, clip.bottom);
            }
          }
        }
        left = Math.max(left, area.left);
        right = Math.min(right, area.right + SIZE);
        top = Math.max(top, area.top);
        bottom = Math.min(bottom, area.bottom + SIZE);
        return right > left && bottom > top ? [{ left, right, top, bottom }] : [];
      },
    );
    const overlap = (candidate: Point) =>
      controls.reduce(
        (sum, rect) =>
          sum +
          Math.max(
            0,
            Math.min(candidate.x + SIZE, rect.right + CONTROL_GAP) -
              Math.max(candidate.x, rect.left - CONTROL_GAP),
          ) *
            Math.max(
              0,
              Math.min(candidate.y + SIZE, rect.bottom + CONTROL_GAP) -
                Math.max(candidate.y, rect.top - CONTROL_GAP),
            ),
        0,
      );
    if (!overlap(desired)) return desired;
    // 空き領域の最近点は希望位置・画面境界・操作領域の辺の組合せにある。
    // 有限個の候補で探索し、空きがない極小画面では重なりが最小の位置に留める。
    const xs = new Set([desired.x, area.left, area.right]);
    const ys = new Set([desired.y, area.top, area.bottom]);
    for (const rect of controls) {
      xs.add(clamp({ x: rect.left - SIZE - CONTROL_GAP, y: desired.y }, area).x);
      xs.add(clamp({ x: rect.right + CONTROL_GAP, y: desired.y }, area).x);
      ys.add(clamp({ x: desired.x, y: rect.top - SIZE - CONTROL_GAP }, area).y);
      ys.add(clamp({ x: desired.x, y: rect.bottom + CONTROL_GAP }, area).y);
    }
    const candidates = [...xs].flatMap((x) => [...ys].map((y) => ({ x, y })));
    const distance = (candidate: Point) =>
      (candidate.x - desired.x) ** 2 + (candidate.y - desired.y) ** 2;
    candidates.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
    let best = desired,
      leastOverlap = overlap(desired);
    for (const candidate of candidates) {
      const amount = overlap(candidate);
      if (!amount) return candidate;
      if (amount < leastOverlap) {
        best = candidate;
        leastOverlap = amount;
      }
    }
    return best;
  };
  const place = (point: Point, avoid = false) => {
    position = avoid ? avoidControls(point) : clamp(point);
    button.style.left = position.x + "px";
    button.style.top = position.y + "px";
  };
  const initialPosition = () => {
    const area = bounds();
    if (options.mode === "desktop") {
      const anchor = document.querySelector(".map-object-table-toggle")?.getBoundingClientRect();
      if (anchor && anchor.width > 0 && anchor.height > 0) {
        return { x: anchor.right - SIZE, y: anchor.top - SIZE - 10 };
      }
      return { x: area.right, y: area.bottom - 64 };
    }
    return { x: area.right, y: area.bottom };
  };
  const readPosition = (): Point | undefined => {
    try {
      const raw = localStorage.getItem(aiLauncherStorageKey(options.mode));
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedPosition;
      if (
        !saved ||
        typeof saved !== "object" ||
        ![saved.x, saved.y, saved.viewportWidth, saved.viewportHeight].every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100000,
        ) ||
        saved.viewportWidth <= 0 ||
        saved.viewportHeight <= 0
      )
        return;
      const view = viewport();
      return {
        x: (saved.x * view.width) / saved.viewportWidth,
        y: (saved.y * view.height) / saved.viewportHeight,
      };
    } catch {
      return;
    }
  };
  const savePosition = () => {
    const view = viewport();
    const saved: SavedPosition = {
      ...position,
      viewportWidth: view.width,
      viewportHeight: view.height,
    };
    try {
      localStorage.setItem(aiLauncherStorageKey(options.mode), JSON.stringify(saved));
    } catch {
      // 保存が拒否されても、その画面では通常どおり移動・起動できる。
    }
  };
  const release = () => {
    const pointerId = drag?.pointerId;
    drag = undefined;
    button.removeAttribute("data-dragging");
    if (pointerId !== undefined && button.hasPointerCapture?.(pointerId)) {
      button.releasePointerCapture(pointerId);
    }
  };
  const cancelDrag = () => {
    if (drag) place(drag.origin, true);
    release();
  };
  const down = (event: PointerEvent) => {
    if (disposed || button.hidden || event.button !== 0 || event.isPrimary === false || drag)
      return;
    event.stopPropagation();
    suppressClick = false;
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: { ...position },
      moved: false,
    };
    try {
      button.setPointerCapture?.(event.pointerId);
    } catch {
      // グローバルpointerイベントでも終了できるためcapture未提供時も操作可能。
    }
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const x = event.clientX - drag.clientX;
    const y = event.clientY - drag.clientY;
    if (!drag.moved && x * x + y * y < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    drag.moved = true;
    button.dataset.dragging = "true";
    event.preventDefault();
    event.stopPropagation();
    place({ x: drag.origin.x + x, y: drag.origin.y + y });
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      event.preventDefault();
      event.stopPropagation();
      place(position, true);
      preferred = { ...position };
      savePosition();
      suppressClick = true;
    }
    release();
  };
  const cancelPointer = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) cancelDrag();
  };
  const click = (event: MouseEvent) => {
    event.stopPropagation();
    if (disposed || button.hidden) return;
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    suppressClick = false;
    options.onActivate(button);
  };
  const resize = () => {
    if (!disposed && !drag) place(preferred || initialPosition(), true);
  };
  preferred = readPosition();
  place(preferred || initialPosition(), true);
  button.addEventListener("pointerdown", down);
  button.addEventListener("click", click);
  button.addEventListener("lostpointercapture", cancelPointer);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancelPointer);
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : undefined;
  const anchors = [
    ...document.querySelectorAll(
      ".header-btn-zone, .map-object-table-toggle, #search-area, #function-btn-row, .other-function-btn-zone, .bottom-navigation, nav.app-navigation",
    ),
  ];
  for (const anchor of anchors) {
    observer?.observe(anchor);
    anchor.addEventListener("scroll", resize, true);
  }

  return {
    element: button,
    setEnabled(enabled: boolean) {
      if (disposed) return;
      if (!enabled) cancelDrag();
      button.hidden = !enabled;
      if (enabled) resize();
    },
    dispose() {
      if (disposed) return;
      cancelDrag();
      disposed = true;
      observer?.disconnect();
      for (const anchor of anchors) anchor.removeEventListener("scroll", resize, true);
      button.removeEventListener("pointerdown", down);
      button.removeEventListener("click", click);
      button.removeEventListener("lostpointercapture", cancelPointer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      button.remove();
      safeArea.remove();
    },
  };
}
