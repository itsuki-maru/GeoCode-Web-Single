interface LatLng {
  lat: number;
  lng: number;
}

interface MeasurementSegment {
  distance: number;
  end?: LatLng;
  label?: string;
  start?: LatLng;
}

interface MeasurementMarker {
  getLatLng?(): unknown;
  isMeasurementLabel?: boolean;
}

interface MeasurementLayer {
  getBounds?(): { getCenter(): LatLng };
  getLatLng?(): LatLng;
  getLatLngs?(): unknown;
  isMeasurementLabel?: boolean;
  measurementLayerId?: string | null;
  measurementMarkers?: MeasurementMarker[];
  shapeType?: string;
}

interface MeasurementGroup {
  addLayer(layer: MeasurementMarker): unknown;
  removeLayer(layer: MeasurementMarker): unknown;
}

interface MeasurementManager {
  scheduleRefresh(): void;
}

interface MeasurementBounds {
  contains(latLng: unknown): boolean;
}

type MeasurementLabelVariant =
  | "segment"
  | "summary"
  | "summary-circle"
  | "summary-polyline"
  | "summary-rectangle";

interface ShapeMeasurementDisplayDependencies {
  calculateProjectedPolygonArea(latLngs: unknown): number;
  createGroupedSegmentEndpointMarkers(
    segments: MeasurementSegment[],
    layer?: MeasurementLayer | null,
  ): MeasurementMarker[];
  createGroupedSegmentMeasurementMarkers(
    segments: MeasurementSegment[],
  ): MeasurementMarker[];
  createMeasurementLabelMarker(
    latLng: LatLng | null | undefined,
    lines: string[],
    variant?: MeasurementLabelVariant,
  ): MeasurementMarker | null;
  createMeasurementVertexMarker(
    latLng: LatLng | null | undefined,
    layer?: MeasurementLayer | null,
    emphasized?: boolean,
  ): MeasurementMarker | null;
  ensureShapeGroup(
    layerId: string | null | undefined,
  ): MeasurementGroup | null;
  filterMeasurementMarkersForBounds<TMarker extends MeasurementMarker>(
    markers: TMarker[] | unknown,
    bounds: MeasurementBounds | null | undefined,
  ): TMarker[];
  formatArea(areaInSquareMeters: number): string;
  formatDistance(distanceInMeters: number): string;
  getMeasurementSegmentMerged(): boolean;
  getMeasurementVertexLatLngs(
    layer?: MeasurementLayer | null,
  ): LatLng[];
  getMeasurementVisible(): boolean;
  getPolylineCenterLatLng(layer: MeasurementLayer): LatLng | null;
  getSegmentMidpoint(start: LatLng, end: LatLng): LatLng;
  getShapeMeasurementManager(): MeasurementManager | null;
  map: { distance(start: LatLng, end: LatLng): number };
  measureCircle(layer?: MeasurementLayer | null): {
    area: number;
    radius: number;
  };
  measurePolyline(layer?: MeasurementLayer | null): {
    segments: MeasurementSegment[];
    totalDistance: number;
  };
  setMeasurementMarkerVisibility(
    marker: MeasurementMarker,
    visible: boolean,
  ): void;
  trimClosedLatLngs(latLngs: unknown): LatLng[];
}

export function createReadOnlyShapeMeasurementDisplayRuntime({
  calculateProjectedPolygonArea,
  createGroupedSegmentEndpointMarkers,
  createGroupedSegmentMeasurementMarkers,
  createMeasurementLabelMarker,
  createMeasurementVertexMarker,
  ensureShapeGroup,
  filterMeasurementMarkersForBounds,
  formatArea,
  formatDistance,
  getMeasurementSegmentMerged,
  getMeasurementVertexLatLngs,
  getMeasurementVisible,
  getPolylineCenterLatLng,
  getSegmentMidpoint,
  getShapeMeasurementManager,
  map,
  measureCircle,
  measurePolyline,
  setMeasurementMarkerVisibility,
  trimClosedLatLngs,
}: ShapeMeasurementDisplayDependencies) {
  const flattenShapeLatLngs = (latLngs: unknown): LatLng[] => {
    if (!Array.isArray(latLngs) || latLngs.length === 0) return [];
    if (Array.isArray(latLngs[0])) return flattenShapeLatLngs(latLngs[0]);
    return latLngs as LatLng[];
  };

  const getShapeLabelLatLng = (
    layer: MeasurementLayer | null | undefined,
    shapeType = layer?.shapeType,
  ): LatLng | null => {
    if (!layer) return null;
    if (shapeType === "polyline") return getPolylineCenterLatLng(layer);
    if (shapeType === "circle" && typeof layer.getLatLng === "function") {
      return layer.getLatLng();
    }
    if (typeof layer.getBounds === "function") {
      return layer.getBounds().getCenter();
    }
    return null;
  };

  const measurePolygon = (layer: MeasurementLayer) => {
    const latLngs = trimClosedLatLngs(
      flattenShapeLatLngs(layer?.getLatLngs?.()),
    );
    const edges: MeasurementSegment[] = [];
    let perimeter = 0;

    for (let index = 0; index < latLngs.length; index += 1) {
      const start = latLngs[index]!;
      const end = latLngs[(index + 1) % latLngs.length]!;
      const distance = map.distance(start, end);
      edges.push({ label: `${index + 1}`, distance });
      perimeter += distance;
    }

    return {
      area: calculateProjectedPolygonArea(latLngs),
      edges,
      perimeter,
    };
  };

  const addSegmentMarkers = (
    markers: MeasurementMarker[],
    segments: MeasurementSegment[],
  ): void => {
    if (getMeasurementSegmentMerged()) {
      markers.push(...createGroupedSegmentMeasurementMarkers(segments));
      return;
    }
    segments.forEach((segment) => {
      const marker = createMeasurementLabelMarker(
        getSegmentMidpoint(segment.start!, segment.end!),
        [formatDistance(segment.distance)],
      );
      if (marker) markers.push(marker);
    });
  };

  const createShapeMeasurementMarkers = (
    layer: MeasurementLayer | null | undefined,
  ): MeasurementMarker[] => {
    if (!layer) return [];

    const markers: MeasurementMarker[] = [];
    let measurementSegments: MeasurementSegment[] = [];

    if (layer.shapeType === "polyline") {
      const latLngs = flattenShapeLatLngs(layer.getLatLngs?.());
      const measurement = measurePolyline(layer);
      measurementSegments = measurement.segments
        .map((segment, index) => ({
          ...segment,
          end: latLngs[index + 1],
          start: latLngs[index],
        }))
        .filter(
          (segment): segment is MeasurementSegment & {
            end: LatLng;
            start: LatLng;
          } => Boolean(segment.start && segment.end),
        );
      addSegmentMarkers(markers, measurementSegments);

      const summaryMarker = createMeasurementLabelMarker(
        getShapeLabelLatLng(layer),
        [`総延長 ${formatDistance(measurement.totalDistance)}`],
        "summary-polyline",
      );
      if (summaryMarker) markers.push(summaryMarker);
    } else if (
      layer.shapeType === "polygon" ||
      layer.shapeType === "rectangle"
    ) {
      const latLngs = trimClosedLatLngs(
        flattenShapeLatLngs(layer.getLatLngs?.()),
      );
      const measurement = measurePolygon(layer);
      measurementSegments = measurement.edges
        .map((edge, index) => ({
          ...edge,
          end: latLngs[(index + 1) % latLngs.length],
          start: latLngs[index],
        }))
        .filter(
          (segment): segment is MeasurementSegment & {
            end: LatLng;
            start: LatLng;
          } => Boolean(segment.start && segment.end),
        );
      addSegmentMarkers(markers, measurementSegments);

      const summaryMarker = createMeasurementLabelMarker(
        getShapeLabelLatLng(layer),
        [`面積 ${formatArea(measurement.area)}`],
        layer.shapeType === "rectangle" ? "summary-rectangle" : "summary",
      );
      if (summaryMarker) markers.push(summaryMarker);
    } else if (layer.shapeType === "circle") {
      const measurement = measureCircle(layer);
      const summaryMarker = createMeasurementLabelMarker(
        getShapeLabelLatLng(layer),
        [
          `半径 ${formatDistance(measurement.radius)}`,
          `面積 ${formatArea(measurement.area)}`,
        ],
        "summary-circle",
      );
      if (summaryMarker) markers.push(summaryMarker);
    }

    if (getMeasurementSegmentMerged()) {
      markers.push(
        ...createGroupedSegmentEndpointMarkers(measurementSegments, layer),
      );
    } else {
      getMeasurementVertexLatLngs(layer).forEach((latLng) => {
        const marker = createMeasurementVertexMarker(latLng, layer);
        if (marker) markers.push(marker);
      });
    }

    return markers;
  };

  const attachShapeMeasurementMarkers = (
    layer: MeasurementLayer | null | undefined,
    layerId: string | null | undefined,
    bounds: MeasurementBounds | null = null,
  ): void => {
    if (!layer) return;

    const markers = filterMeasurementMarkersForBounds(
      createShapeMeasurementMarkers(layer),
      bounds,
    );
    layer.measurementMarkers = markers;
    layer.measurementLayerId = layerId;
    if (markers.length === 0) return;

    const targetShapeGroup = ensureShapeGroup(layerId);
    if (!targetShapeGroup) return;

    markers.forEach((marker) => {
      targetShapeGroup.addLayer(marker);
      setMeasurementMarkerVisibility(marker, getMeasurementVisible());
    });
  };

  const removeShapeMeasurementMarkers = (
    layer: MeasurementLayer | null | undefined,
  ): void => {
    if (!layer || !Array.isArray(layer.measurementMarkers)) return;

    const targetShapeGroup = ensureShapeGroup(layer.measurementLayerId);
    layer.measurementMarkers.forEach((marker) => {
      targetShapeGroup?.removeLayer(marker);
    });
    layer.measurementMarkers = [];
  };

  const refreshAllShapeMeasurementMarkers = (): void => {
    getShapeMeasurementManager()?.scheduleRefresh();
  };

  return {
    attachShapeMeasurementMarkers,
    flattenShapeLatLngs,
    getShapeLabelLatLng,
    refreshAllShapeMeasurementMarkers,
    removeShapeMeasurementMarkers,
  };
}
