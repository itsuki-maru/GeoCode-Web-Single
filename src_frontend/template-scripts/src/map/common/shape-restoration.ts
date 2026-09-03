interface ShapeRecord {
  geojson?: unknown;
  id?: string | number;
  layer_id?: string | null;
  name?: unknown;
  shape_type?: string;
}

interface ShapeStyle {
  color?: unknown;
  [key: string]: unknown;
}

interface ShapeTooltip {
  getElement?(): HTMLElement | null;
  setLatLng?(latLng: unknown): void;
}

interface RestoredShapeLayer {
  bindTooltip?(
    content: string,
    options: Record<string, unknown>,
  ): unknown;
  getTooltip?(): ShapeTooltip | null;
  isShapeNameLayer?: boolean;
  layerId?: string | null;
  openTooltip?(): void;
  setStyle?(style: ShapeStyle): void;
  shapeId?: string | number;
  shapeMemo?: string;
  shapeName?: string;
  shapeStyle?: ShapeStyle;
  shapeType?: string;
  unbindTooltip?(): void;
}

interface ShapeNameLabelManager {
  invalidate(layer: RestoredShapeLayer): void;
}

type ShapeLabelAppearance = "pill" | "plain";

interface ShapeRestorationDependencies {
  attachShapeMemoPopup(layer: RestoredShapeLayer): void;
  attachShapeMemoTooltipOpen(
    layer: RestoredShapeLayer,
    labelLatLng: unknown,
  ): void;
  bindPolylineHoverHighlight(
    layer: RestoredShapeLayer,
    options?: { restoreStyle(): void },
  ): void;
  createLeafletShapeLayer(
    shapeType: string,
    geojson: unknown,
    shapeStyle: ShapeStyle,
  ): RestoredShapeLayer | null;
  escapeHtml(value: string): string;
  getDefaultShapeColor(): string;
  getShapeMemoFromGeoJson(geojson: unknown): string;
  getShapeNameLabelManager(): ShapeNameLabelManager | null;
  getShapeRecords(records: unknown): ShapeRecord[];
  getShapeStyleFromGeoJson(
    shapeType: string,
    geojson: unknown,
  ): ShapeStyle;
  labelAppearance?: ShapeLabelAppearance;
  normalizeShapeColor(value: unknown, fallback?: string): string;
  normalizeShapeName(value: unknown): string;
  scheduleTask?: (callback: () => void) => void;
}

interface RestoreSavedShapesOptions {
  addLayer(
    layer: RestoredShapeLayer,
    layerId: string | null | undefined,
  ): unknown;
  applyShapeStyle?: boolean;
  bindPolylineHover?: boolean;
  records: unknown;
  restoreShapeStyleOnHover?: boolean;
  shapeLayers: Record<string, RestoredShapeLayer>;
}

export function createReadOnlyShapeRestorationRuntime({
  attachShapeMemoPopup,
  attachShapeMemoTooltipOpen,
  bindPolylineHoverHighlight,
  createLeafletShapeLayer,
  escapeHtml,
  getDefaultShapeColor,
  getShapeMemoFromGeoJson,
  getShapeNameLabelManager,
  getShapeRecords,
  getShapeStyleFromGeoJson,
  labelAppearance = "plain",
  normalizeShapeColor,
  normalizeShapeName,
  scheduleTask = (callback) => {
    setTimeout(callback, 0);
  },
}: ShapeRestorationDependencies) {
  const applyShapeStyle = (layer: RestoredShapeLayer): void => {
    if (typeof layer?.setStyle !== "function") return;
    layer.setStyle({ ...(layer.shapeStyle ?? {}) });
  };

  const updateShapeNameLabel = (
    layer: RestoredShapeLayer | null | undefined,
    name: unknown,
  ): void => {
    if (!layer) return;
    layer.shapeName = normalizeShapeName(name);
    layer.isShapeNameLayer = true;

    const manager = getShapeNameLabelManager();
    if (manager) manager.invalidate(layer);
    else layer.unbindTooltip?.();
  };

  const bindShapeNameLabelTooltip = (
    layer: RestoredShapeLayer,
    labelLatLng: unknown,
  ): void => {
    if (typeof layer?.bindTooltip !== "function") return;

    const normalizedName = normalizeShapeName(layer.shapeName);
    if (!normalizedName && labelAppearance === "plain") return;

    const labelColor = normalizeShapeColor(
      layer.shapeStyle?.color,
      getDefaultShapeColor(),
    );
    const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
    const content =
      labelAppearance === "pill"
        ? `<div class="shape-name-label${normalizedName ? "" : " is-empty"}" style="background:rgba(255,255,255,0.92);border:1px solid ${labelColor};border-radius:999px;color:${labelColor};display:inline-block;padding:2px 8px;">${labelContent}</div>`
        : `<div class="shape-name-label" style="color:${labelColor};">${labelContent}</div>`;
    layer.bindTooltip(content, {
      className: "shape-name-tooltip",
      direction: "center",
      interactive: true,
      permanent: true,
    });

    const tooltip = layer.getTooltip?.() ?? null;
    if (labelLatLng) tooltip?.setLatLng?.(labelLatLng);
    layer.openTooltip?.();

    const applyTooltipStyle = (): void => {
      const style = tooltip?.getElement?.()?.style;
      if (!style) return;
      if (labelAppearance === "pill") {
        style.setProperty("background", "transparent", "important");
        style.setProperty("border", "none", "important");
        style.setProperty("box-shadow", "none", "important");
        style.setProperty("padding", "0", "important");
      } else {
        style.setProperty("border-color", labelColor, "important");
      }
      style.setProperty("color", labelColor, "important");
    };
    applyTooltipStyle();
    scheduleTask(() => {
      attachShapeMemoTooltipOpen(layer, labelLatLng);
      applyTooltipStyle();
    });
  };

  const restoreSavedShapes = ({
    addLayer,
    applyShapeStyle: shouldApplyShapeStyle = false,
    bindPolylineHover = false,
    records,
    restoreShapeStyleOnHover = false,
    shapeLayers,
  }: RestoreSavedShapesOptions): boolean => {
    let hasRestoredShapes = false;

    getShapeRecords(records).forEach((shape) => {
      if (!shape.shape_type) return;
      const shapeStyle = getShapeStyleFromGeoJson(
        shape.shape_type,
        shape.geojson,
      );
      const layer = createLeafletShapeLayer(
        shape.shape_type,
        shape.geojson,
        shapeStyle,
      );
      if (!layer) return;

      layer.shapeId = shape.id;
      layer.layerId = shape.layer_id ?? null;
      layer.shapeType = shape.shape_type;
      layer.shapeStyle = shapeStyle;
      layer.shapeMemo = getShapeMemoFromGeoJson(shape.geojson);
      updateShapeNameLabel(layer, shape.name);
      shapeLayers[`shape-${shape.id}`] = layer;
      if (shouldApplyShapeStyle) applyShapeStyle(layer);
      attachShapeMemoPopup(layer);
      if (bindPolylineHover) {
        if (restoreShapeStyleOnHover) {
          bindPolylineHoverHighlight(layer, {
            restoreStyle: () => applyShapeStyle(layer),
          });
        } else {
          bindPolylineHoverHighlight(layer);
        }
      }
      if (addLayer(layer, shape.layer_id) !== false) {
        hasRestoredShapes = true;
      }
    });

    return hasRestoredShapes;
  };

  return {
    bindShapeNameLabelTooltip,
    restoreSavedShapes,
    updateShapeNameLabel,
  };
}
