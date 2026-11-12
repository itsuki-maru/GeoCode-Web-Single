interface PopupLayout {
  getElement?(): HTMLElement | null | undefined;
  getContent?(): unknown;
  update?(): void;
}

interface PopupHeightMap {
  getContainer?(): HTMLElement;
  on(event: string, listener: (event: { popup?: PopupLayout }) => void): unknown;
  off?(event: string, listener: (event: { popup?: PopupLayout }) => void): unknown;
}

// PC の通常地図・全画面地図から明示的に有効化する。マーカーの初回 autoPan より前に
// 地図の実際の高さを CSS に渡し、表示中の回転・リサイズでも同じ制限を使う。
export function installMarkerPopupHeightLimit(map: PopupHeightMap): () => void {
  const container = map.getContainer?.();
  if (!container) return () => {};
  const property = "--geocode-popup-map-height";
  const previousHeight = container.style.getPropertyValue(property);
  const previousPriority = container.style.getPropertyPriority(property);
  const hadClass = container.classList.contains("pc-map-popup-height");
  let activePopup: PopupLayout | undefined;
  let disposed = false;
  const setHeight = () => {
    container.style.setProperty(property, `${container.clientHeight}px`);
  };
  const open = ({ popup }: { popup?: PopupLayout }) => {
    // 図形名編集など、マーカーと共存するポップアップを開いても追跡を維持する。
    if (
      popup?.getElement?.()?.querySelector('.geocode-content-popup[data-content-key^="marker:"]')
    ) {
      activePopup = popup;
    }
  };
  const close = ({ popup }: { popup?: PopupLayout }) => {
    if (activePopup === popup) activePopup = undefined;
  };
  const resize = () => {
    setHeight();
    // 本文が上限の 500px のままでも、地図の寸法が変われば表示位置の再計測が必要。
    if (activePopup) updatePopupLayout(activePopup, undefined, { force: true });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    map.off?.("popupopen", open);
    map.off?.("popupclose", close);
    map.off?.("resize", resize);
    map.off?.("unload", dispose);
    activePopup = undefined;
    if (!hadClass) container.classList.remove("pc-map-popup-height");
    if (previousHeight) container.style.setProperty(property, previousHeight, previousPriority);
    else container.style.removeProperty(property);
  };
  container.classList.add("pc-map-popup-height");
  setHeight();
  map.on("popupopen", open);
  map.on("popupclose", close);
  map.on("resize", resize);
  map.on("unload", dispose);
  return dispose;
}

const measuredContent = new WeakMap<
  HTMLElement,
  { parent: HTMLElement; width: number; height: number; scrollWidth: number }
>();

// Leaflet は update() 中に実際のポップアップ内容を取り外して付け直すため、Markdown 本文、
// 低い画面での見出しを含む全体、Leaflet 外側の各スクロール領域を保持する。
export function capturePopupScroll(root: HTMLElement): () => void {
  const ancestors: HTMLElement[] = [];
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    ancestors.unshift(element);
    if (element.classList.contains("leaflet-popup")) break;
  }
  const elements = new Set([
    ...ancestors,
    ...root.querySelectorAll<HTMLElement>(
      ".leaflet-popup-content, .geocode-content-popup, .md-detail-contents",
    ),
  ]);
  const positions = Array.from(elements, (element) => ({
    element,
    top: element.scrollTop,
    left: element.scrollLeft,
  }));
  return () => {
    for (const { element, top, left } of positions) {
      element.scrollLeft = left;
      element.scrollTop = top;
    }
  };
}

export function updatePopupLayout(
  popup: PopupLayout,
  fallbackRoot?: HTMLElement,
  options: { force?: boolean } = {},
): void {
  const root = popup.getElement?.() ?? fallbackRoot;
  if (!root) {
    popup.update?.();
    return;
  }
  const content = popup.getContent?.();
  const pinned =
    content instanceof HTMLElement &&
    content.isConnected &&
    root.contains(content) &&
    content.parentElement?.classList.contains("leaflet-popup-content") &&
    content.parentElement.childNodes.length === 1
      ? content
      : undefined;
  if (pinned) {
    const previous = measuredContent.get(pinned);
    const size = pinned.getBoundingClientRect();
    // 高さを使い切った Markdown のスクロール領域の下へ追記しても、ポップアップの形状は変わらない。
    // この一般的なケースでは、追記後の画像読み込みも含め、Leaflet による取り外し・再挿入と
    // 内容全体の再計測を避ける。
    if (
      !options.force &&
      previous &&
      previous.parent === pinned.parentElement &&
      Math.abs(previous.width - size.width) < 0.5 &&
      Math.abs(previous.height - size.height) < 0.5 &&
      previous.scrollWidth === pinned.scrollWidth
    )
      return;
  }
  const restoreScroll = capturePopupScroll(root);
  const focused = root.ownerDocument.activeElement as HTMLElement | null;
  try {
    popup.update?.();
    if (focused && root.contains(focused)) focused.focus({ preventScroll: true });
  } finally {
    // ブラウザーによっては、フォーカスの復元でもスクロール位置が動く場合がある。
    restoreScroll();
  }
  if (pinned?.parentElement) {
    const size = pinned.getBoundingClientRect();
    measuredContent.set(pinned, {
      parent: pinned.parentElement,
      width: size.width,
      height: size.height,
      scrollWidth: pinned.scrollWidth,
    });
  }
}
