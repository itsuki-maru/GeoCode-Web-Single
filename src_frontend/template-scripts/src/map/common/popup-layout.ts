interface PopupLayout {
  getElement?(): HTMLElement | null | undefined;
  getContent?(): unknown;
  update?(): void;
}

const measuredContent = new WeakMap<
  HTMLElement,
  { parent: HTMLElement; width: number; height: number; scrollWidth: number }
>();

// Leaflet detaches and reattaches live popup content during update(). Preserve
// both the inner Markdown scroller and Leaflet's optional outer scroller.
export function capturePopupScroll(root: HTMLElement): () => void {
  const ancestors: HTMLElement[] = [];
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    ancestors.unshift(element);
    if (element.classList.contains("leaflet-popup")) break;
  }
  const elements = new Set([
    ...ancestors,
    ...root.querySelectorAll<HTMLElement>(".leaflet-popup-content, .md-detail-contents"),
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

export function updatePopupLayout(popup: PopupLayout, fallbackRoot?: HTMLElement): void {
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
    // Appending below a full-height Markdown scroller does not change popup
    // geometry. Avoid Leaflet's detach/reinsert and whole-content remeasurement
    // in that common case, including image loads after an append.
    if (
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
    // Focus restoration can also move scroll positions on some browsers.
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
