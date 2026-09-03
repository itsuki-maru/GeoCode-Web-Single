interface ShapeLayer {
  getTooltip?(): unknown;
  isShapeNameLayer?: boolean;
  openTooltip?(): void;
  shapeStyle?: Record<string, unknown>;
  shapeType?: string;
}

interface ShapeLayerMap {
  closeTooltip(tooltip: unknown): void;
  eachLayer(callback: (layer: ShapeLayer) => void): void;
}

interface ShapeLayerLeaflet {
  circle(
    latLng: unknown,
    options: Record<string, unknown>,
  ): ShapeLayer;
  geoJSON(
    geojson: unknown,
    options: { style: () => Record<string, unknown> },
  ): { getLayers(): ShapeLayer[] };
  latLng(latitude: unknown, longitude: unknown): unknown;
}

interface ShapeLayerDependencies {
  bindShapeArrowStyle(layer: ShapeLayer): void;
  getCircleRadiusFromGeoJson(geojson: unknown): number | null;
  getLeaflet(): ShapeLayerLeaflet;
  getMap(): ShapeLayerMap;
  getTooltipVisible(): boolean;
  setTooltipVisible(visible: boolean): void;
}

export function createShapeLayerRuntime({
  bindShapeArrowStyle,
  getCircleRadiusFromGeoJson,
  getLeaflet,
  getMap,
  getTooltipVisible,
  setTooltipVisible,
}: ShapeLayerDependencies) {
  const createLeafletShapeLayer = (
    shapeType: string,
    geojson: unknown,
    shapeStyle: Record<string, unknown>,
  ): ShapeLayer | null => {
    const leaflet = getLeaflet();
    if (shapeType === "circle") {
      const coordinates =
        geojson && typeof geojson === "object"
          ? (geojson as { geometry?: { coordinates?: unknown } }).geometry
              ?.coordinates
          : undefined;
      const radius = getCircleRadiusFromGeoJson(geojson);
      if (!Array.isArray(coordinates) || coordinates.length < 2 || !radius) {
        return null;
      }
      return leaflet.circle(leaflet.latLng(coordinates[1], coordinates[0]), {
        ...shapeStyle,
        radius,
      });
    }

    const layers = leaflet
      .geoJSON(geojson, { style: () => shapeStyle })
      .getLayers();
    const layer = layers.length === 0 ? null : (layers[0] ?? null);
    if (layer) {
      layer.shapeType = shapeType;
      layer.shapeStyle = shapeStyle;
      bindShapeArrowStyle(layer);
    }
    return layer;
  };

  const toggleTooltips = (): void => {
    const map = getMap();
    if (getTooltipVisible()) {
      map.eachLayer((layer) => {
        if (layer?.isShapeNameLayer === true) return;
        const tooltip = layer.getTooltip?.();
        if (tooltip) map.closeTooltip(tooltip);
      });
      setTooltipVisible(false);
      return;
    }

    map.eachLayer((layer) => {
      if (layer?.isShapeNameLayer === true) return;
      if (layer.getTooltip) layer.openTooltip?.();
    });
    setTooltipVisible(true);
  };

  return { createLeafletShapeLayer, toggleTooltips };
}
