import type {
  DefaultShapeStyle,
  ShapeArrowType,
} from "./shape-style";

interface ArrowLayer {
  _path?: SVGElement | null;
  options?: { weight?: unknown };
  polylineHoverHighlightBound?: boolean;
  shapeArrowStyleBound?: boolean;
  shapeStyle?: { arrowType?: unknown; color?: unknown; weight?: unknown };
  shapeType?: string;
  on(eventName: string, listener: () => void): void;
  setStyle?(style: { weight: number }): void;
}

interface ShapeArrowDependencies {
  getDefaultStyle(): DefaultShapeStyle;
  normalizeShapeArrowType(value: unknown): ShapeArrowType;
  normalizeShapeColor(value: unknown, fallback?: string): string;
  normalizeShapeWeight(value: unknown, fallback?: unknown): number;
  supportsMouseHover?: () => boolean;
}

const ARROW_MARKER_ID_PREFIX = "geocode-shape-arrowhead";
const HOVER_MIN_WEIGHT = 8;
const HOVER_WEIGHT_INCREMENT = 4;

export function createShapeArrowRuntime({
  getDefaultStyle,
  normalizeShapeArrowType,
  normalizeShapeColor,
  normalizeShapeWeight,
  supportsMouseHover = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches,
}: ShapeArrowDependencies) {
  const getShapeArrowMarkerId = (color: unknown): string => {
    const normalized = normalizeShapeColor(
      color,
      getDefaultStyle().color,
    );
    return ARROW_MARKER_ID_PREFIX + "-" + normalized.slice(1);
  };

  const ensureShapeArrowMarker = (color: unknown): string => {
    const normalized = normalizeShapeColor(
      color,
      getDefaultStyle().color,
    );
    const markerId = getShapeArrowMarkerId(normalized);
    if (document.getElementById(markerId)) return markerId;

    const namespace = "http://www.w3.org/2000/svg";
    let definitionsSvg = document.getElementById(
      "geocode-shape-svg-definitions",
    ) as SVGSVGElement | null;
    if (!definitionsSvg) {
      definitionsSvg = document.createElementNS(namespace, "svg");
      definitionsSvg.setAttribute("id", "geocode-shape-svg-definitions");
      definitionsSvg.setAttribute("width", "0");
      definitionsSvg.setAttribute("height", "0");
      definitionsSvg.setAttribute("aria-hidden", "true");
      definitionsSvg.style.position = "absolute";
      definitionsSvg.style.overflow = "hidden";
      document.body.appendChild(definitionsSvg);
    }

    let definitions = definitionsSvg.querySelector("defs");
    if (!definitions) {
      definitions = document.createElementNS(namespace, "defs");
      definitionsSvg.appendChild(definitions);
    }
    const marker = document.createElementNS(namespace, "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("viewBox", "0 0 4 4");
    marker.setAttribute("refX", "3.25");
    marker.setAttribute("refY", "2");
    marker.setAttribute("markerWidth", "4.5");
    marker.setAttribute("markerHeight", "4.5");
    marker.setAttribute("markerUnits", "strokeWidth");
    marker.setAttribute("orient", "auto-start-reverse");

    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", "M 0 0 L 4 2 L 0 4 z");
    path.setAttribute("fill", normalized);
    marker.appendChild(path);
    definitions.appendChild(marker);
    return markerId;
  };

  const applyShapeArrowStyle = (layer: ArrowLayer | null | undefined): void => {
    const path = layer?._path;
    if (!path) return;
    path.removeAttribute("marker-start");
    path.removeAttribute("marker-end");
    if (layer.shapeType !== "polyline") return;

    const arrowType = normalizeShapeArrowType(
      layer.shapeStyle?.arrowType,
    );
    if (arrowType === "none") return;
    const fallbackColor = normalizeShapeColor(
      layer.shapeStyle?.color,
      getDefaultStyle().color,
    );
    const strokeColor = normalizeShapeColor(
      path.getAttribute("stroke"),
      fallbackColor,
    );
    const reference = "url(#" + ensureShapeArrowMarker(strokeColor) + ")";
    if (arrowType === "start" || arrowType === "both") {
      path.setAttribute("marker-start", reference);
    }
    if (arrowType === "end" || arrowType === "both") {
      path.setAttribute("marker-end", reference);
    }
  };

  const bindShapeArrowStyle = (
    layer: ArrowLayer | null | undefined,
  ): void => {
    if (!layer || layer.shapeArrowStyleBound === true) return;
    layer.shapeArrowStyleBound = true;
    layer.on("add", () => applyShapeArrowStyle(layer));
    applyShapeArrowStyle(layer);
  };

  const bindPolylineHoverHighlight = (
    layer: ArrowLayer | null | undefined,
    { restoreStyle }: { restoreStyle?: (layer: ArrowLayer) => void } = {},
  ): void => {
    if (
      !layer ||
      layer.shapeType !== "polyline" ||
      layer.polylineHoverHighlightBound === true ||
      typeof layer.on !== "function" ||
      typeof layer.setStyle !== "function"
    ) {
      return;
    }

    layer.polylineHoverHighlightBound = true;
    let isHighlighted = false;
    const clearHighlight = () => {
      if (!isHighlighted) return;
      isHighlighted = false;
      if (restoreStyle) {
        restoreStyle(layer);
      } else {
        layer.setStyle?.({
          weight: normalizeShapeWeight(
            layer.shapeStyle?.weight,
            getDefaultStyle().weight,
          ),
        });
        applyShapeArrowStyle(layer);
      }
    };

    layer.on("mouseover", () => {
      if (isHighlighted || !supportsMouseHover()) return;
      const currentWeight = normalizeShapeWeight(
        layer.options?.weight,
        layer.shapeStyle?.weight,
      );
      isHighlighted = true;
      layer.setStyle?.({
        weight: Math.max(
          HOVER_MIN_WEIGHT,
          currentWeight + HOVER_WEIGHT_INCREMENT,
        ),
      });
      applyShapeArrowStyle(layer);
    });
    layer.on("mouseout", clearHighlight);
    layer.on("remove", clearHighlight);
  };

  return {
    applyShapeArrowStyle,
    bindPolylineHoverHighlight,
    bindShapeArrowStyle,
    ensureShapeArrowMarker,
    getShapeArrowMarkerId,
  };
}
