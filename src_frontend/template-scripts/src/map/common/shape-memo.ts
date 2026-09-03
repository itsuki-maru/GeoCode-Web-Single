interface ShapeMemoGeoJson {
  properties?: { memo?: unknown } | null;
}

interface ShapeMemoLayer {
  getTooltip?(): ShapeMemoTooltip | null;
  on(eventName: string, listener: (event?: ShapeMemoLayerEvent) => void): void;
  shapeMemo?: unknown;
  shapeMemoClickBound?: boolean;
  shapeName?: unknown;
}

interface ShapeMemoLayerEvent {
  latlng?: unknown;
}

interface ShapeMemoTooltip {
  getElement?(): HTMLElement | null;
}

interface ShapeMemoPopup {
  getElement?(): HTMLElement | null;
  openOn(map: unknown): ShapeMemoPopup;
  setContent(content: string): ShapeMemoPopup;
  setLatLng(latLng: unknown): ShapeMemoPopup;
}

interface ShapeMemoLeaflet {
  DomEvent: {
    on(
      element: HTMLElement,
      eventName: string,
      listener: (event: unknown) => void,
    ): void;
    stop(event: unknown): void;
  };
  popup(): ShapeMemoPopup;
}

interface ShapeMemoDependencies {
  escapeHtml(value: string): string;
  getLeaflet(): ShapeMemoLeaflet;
  getMap(): unknown;
  renderIframe(html: string): string;
  renderMarkdown(markdown: string): string;
  sanitizeHtml(html: string): string;
  schedule?: (callback: () => void) => void;
  setupDetailsLazyImages(root: ParentNode): void;
}

export const SHAPE_MEMO_MAX_LENGTH = 10_000;

export function normalizeShapeName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

export function normalizeShapeMemo(memo: unknown): string {
  return typeof memo === "string" ? memo : "";
}

export function getShapeMemoFromGeoJson(geojson: unknown): string {
  if (!geojson || typeof geojson !== "object") return "";
  return normalizeShapeMemo((geojson as ShapeMemoGeoJson).properties?.memo);
}

export function createShapeMemoRuntime({
  escapeHtml,
  getLeaflet,
  getMap,
  renderIframe,
  renderMarkdown,
  sanitizeHtml,
  schedule = (callback) => window.setTimeout(callback, 0),
  setupDetailsLazyImages,
}: ShapeMemoDependencies) {
  const renderShapeMemoPopupContent = (
    shapeName: unknown,
    memo: unknown,
  ): string => {
    const normalizedMemo = normalizeShapeMemo(memo);
    if (!normalizedMemo.trim()) return "";

    const title = normalizeShapeName(shapeName);
    const titleHtml = title ? `<h1>${escapeHtml(title)}</h1>` : "";
    const markdownHtml = renderMarkdown(normalizedMemo);
    const cleanHtml = sanitizeHtml(markdownHtml);
    return `<div class="md-detail-contents">${titleHtml}${renderIframe(cleanHtml)}</div>`;
  };

  const openShapeMemoPopup = (
    layer: ShapeMemoLayer | null | undefined,
    latLng: unknown,
  ): boolean => {
    if (!layer || !latLng) return false;

    const popupContent = renderShapeMemoPopupContent(
      layer.shapeName,
      layer.shapeMemo,
    );
    if (!popupContent) return false;

    const popup = getLeaflet()
      .popup()
      .setLatLng(latLng)
      .setContent(popupContent)
      .openOn(getMap());
    schedule(() => {
      const popupElement = popup.getElement?.() ?? null;
      setupDetailsLazyImages(popupElement || document);
    });
    return true;
  };

  const attachShapeMemoPopup = (
    layer: ShapeMemoLayer | null | undefined,
  ): void => {
    if (!layer || layer.shapeMemoClickBound === true) return;
    layer.shapeMemoClickBound = true;
    layer.on("click", (event) => {
      openShapeMemoPopup(layer, event?.latlng);
    });
  };

  const attachShapeMemoTooltipOpen = (
    layer: ShapeMemoLayer | null | undefined,
    labelLatLng: unknown,
  ): void => {
    if (!layer || !labelLatLng) return;

    const tooltip = layer.getTooltip?.() ?? null;
    const tooltipElement = tooltip?.getElement?.() ?? null;
    if (
      !tooltipElement ||
      tooltipElement.dataset.shapeMemoOpenBound === "true"
    ) {
      return;
    }

    tooltipElement.dataset.shapeMemoOpenBound = "true";
    let lastTouchEndAt = 0;
    const openMemoFromLabel = (event: unknown) => {
      const leaflet = getLeaflet();
      leaflet.DomEvent.stop(event);
      const eventTimestamp = Date.now();
      const eventType =
        event && typeof event === "object" && "type" in event
          ? (event as { type?: unknown }).type
          : undefined;
      if (eventType === "click" && eventTimestamp - lastTouchEndAt < 500) {
        return;
      }
      if (eventType === "touchend") lastTouchEndAt = eventTimestamp;
      openShapeMemoPopup(layer, labelLatLng);
    };

    const leaflet = getLeaflet();
    leaflet.DomEvent.on(tooltipElement, "click", openMemoFromLabel);
    leaflet.DomEvent.on(tooltipElement, "touchend", openMemoFromLabel);
  };

  return {
    attachShapeMemoPopup,
    attachShapeMemoTooltipOpen,
    openShapeMemoPopup,
    renderShapeMemoPopupContent,
  };
}
