export type ShapeLineType = "solid" | "dashed" | "dotted" | "dash-dot";
export type ShapeArrowType = "none" | "start" | "end" | "both";

export interface DefaultShapeStyle {
  color: string;
  fillOpacity: number;
  weight: number;
}

export interface PolylineShapeStyle {
  arrowType: ShapeArrowType;
  color: string;
  dashArray: string | null;
  fill: false;
  weight: number;
}

export interface AreaShapeStyle {
  color: string;
  dashArray: string | null;
  fillColor: string;
  fillOpacity: number;
  weight: number;
}

export type ShapeStyle = PolylineShapeStyle | AreaShapeStyle;

export const SHAPE_LINE_TYPE_OPTIONS: ReadonlyArray<{
  label: string;
  value: ShapeLineType;
  dashArray: string | null;
}> = [
  { value: "solid", label: "実線", dashArray: null },
  { value: "dashed", label: "破線", dashArray: "12,8" },
  { value: "dotted", label: "点線", dashArray: "1,6" },
  { value: "dash-dot", label: "一点鎖線", dashArray: "12,6,1,6" },
];
export const SHAPE_ARROW_TYPE_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "start", label: "始点" },
  { value: "end", label: "終点" },
  { value: "both", label: "両端" },
] as const;
const ARROW_TYPES = new Set<ShapeArrowType>(
  SHAPE_ARROW_TYPE_OPTIONS.map(({ value }) => value),
);
export const SHAPE_WEIGHT_MIN = 1;
export const SHAPE_WEIGHT_MAX = 10;

export function createShapeStyleCore(
  getDefaultStyle: () => DefaultShapeStyle,
) {
  const normalizeShapeColor = (
    color: unknown,
    fallback = getDefaultStyle().color,
  ): string => {
    if (typeof color !== "string") return fallback;
    const trimmedColor = color.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) {
      return trimmedColor.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{3}$/.test(trimmedColor)) {
      const expanded = trimmedColor
        .slice(1)
        .split("")
        .map((value) => value + value)
        .join("");
      return ("#" + expanded).toLowerCase();
    }
    return fallback;
  };

  const normalizeShapeWeight = (
    weight: unknown,
    fallback: unknown = getDefaultStyle().weight,
  ): number => {
    const numericFallback = Number(fallback);
    const normalizedFallback = Number.isFinite(numericFallback)
      ? Math.min(SHAPE_WEIGHT_MAX, Math.max(SHAPE_WEIGHT_MIN, numericFallback))
      : 5;
    if (weight === null || weight === "") return normalizedFallback;
    const numericWeight = Number(weight);
    return Number.isFinite(numericWeight)
      ? Math.min(SHAPE_WEIGHT_MAX, Math.max(SHAPE_WEIGHT_MIN, numericWeight))
      : normalizedFallback;
  };

  const normalizeShapeLineType = (
    lineType: unknown,
    fallback: ShapeLineType = "solid",
  ): ShapeLineType => {
    const normalizedFallback = SHAPE_LINE_TYPE_OPTIONS.some(
      (option) => option.value === fallback,
    )
      ? fallback
      : "solid";
    if (typeof lineType !== "string") return normalizedFallback;
    const normalized = lineType.trim().toLowerCase();
    return SHAPE_LINE_TYPE_OPTIONS.some((option) => option.value === normalized)
      ? (normalized as ShapeLineType)
      : normalizedFallback;
  };

  const normalizeShapeArrowType = (
    arrowType: unknown,
    fallback: ShapeArrowType = "none",
  ): ShapeArrowType => {
    const normalizedFallback = ARROW_TYPES.has(fallback) ? fallback : "none";
    if (typeof arrowType !== "string") return normalizedFallback;
    const normalized = arrowType.trim().toLowerCase() as ShapeArrowType;
    return ARROW_TYPES.has(normalized) ? normalized : normalizedFallback;
  };

  const normalizeDashArrayValue = (dashArray: unknown): string =>
    typeof dashArray === "string"
      ? dashArray.trim().split(/[\s,]+/).filter(Boolean).join(",")
      : "";

  const getShapeLineTypeFromDashArray = (
    dashArray: unknown,
  ): ShapeLineType => {
    const normalized = normalizeDashArrayValue(dashArray);
    return (
      SHAPE_LINE_TYPE_OPTIONS.find(
        (option) =>
          normalizeDashArrayValue(option.dashArray) === normalized,
      )?.value ?? "solid"
    );
  };

  const getShapeDashArray = (lineType: unknown): string | null => {
    const normalized = normalizeShapeLineType(lineType);
    return (
      SHAPE_LINE_TYPE_OPTIONS.find((option) => option.value === normalized)?.dashArray ??
      null
    );
  };

  const normalizeShapeDashArray = (
    dashArray: unknown,
  ): string | null =>
    getShapeDashArray(getShapeLineTypeFromDashArray(dashArray));

  const getDefaultShapeStyle = (shapeType: string): ShapeStyle => {
    const defaults = getDefaultStyle();
    if (shapeType === "polyline") {
      return {
        color: defaults.color,
        weight: defaults.weight,
        dashArray: null,
        arrowType: "none",
        fill: false,
      };
    }
    return {
      color: defaults.color,
      weight: defaults.weight,
      dashArray: null,
      fillColor: defaults.color,
      fillOpacity: defaults.fillOpacity,
    };
  };

  const getShapeStyleFromGeoJson = (
    shapeType: string,
    geojson: unknown,
  ): ShapeStyle => {
    const defaultStyle = getDefaultShapeStyle(shapeType);
    const styleRecord = getStyleRecord(geojson);
    if (!styleRecord) return defaultStyle;

    const color = normalizeShapeColor(styleRecord.color, defaultStyle.color);
    const weight = normalizeShapeWeight(
      styleRecord.weight,
      defaultStyle.weight,
    );
    const dashArray = normalizeShapeDashArray(styleRecord.dashArray);
    if (shapeType === "polyline") {
      return {
        color,
        weight,
        dashArray,
        arrowType: normalizeShapeArrowType(styleRecord.arrowType),
        fill: false,
      };
    }

    const fillOpacity = Number(styleRecord.fillOpacity);
    const fallbackOpacity =
      "fillOpacity" in defaultStyle ? defaultStyle.fillOpacity : 0.2;
    return {
      color,
      weight,
      dashArray,
      fillColor: color,
      fillOpacity: Number.isFinite(fillOpacity)
        ? fillOpacity
        : fallbackOpacity,
    };
  };

  return {
    getDefaultShapeStyle,
    getShapeDashArray,
    getShapeLineTypeFromDashArray,
    getShapeStyleFromGeoJson,
    normalizeDashArrayValue,
    normalizeShapeArrowType,
    normalizeShapeColor,
    normalizeShapeDashArray,
    normalizeShapeLineType,
    normalizeShapeWeight,
  };
}

function getStyleRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const properties = value.properties;
  if (!isRecord(properties) || !isRecord(properties.style)) return null;
  return properties.style;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
