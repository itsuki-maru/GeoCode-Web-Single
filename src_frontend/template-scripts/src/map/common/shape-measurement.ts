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

interface MeasurementLayer {
  getLatLngs?(): unknown;
  getRadius?(): unknown;
  shapeStyle?: { color?: unknown };
  shapeType?: string;
}

interface MeasurementMarker {
  getElement?(): HTMLElement | null;
  isMeasurementLabel?: boolean;
  isMeasurementVertex?: boolean;
  setOpacity?(opacity: number): void;
  setStyle?(style: { fillOpacity: number; opacity: number }): void;
}

interface MeasurementMap {
  distance(start: LatLng, end: LatLng): number;
  options: {
    crs: {
      project(latLng: LatLng): { x: number; y: number };
    };
  };
}

interface MeasurementLeaflet {
  circleMarker(
    latLng: LatLng,
    options: Record<string, unknown>,
  ): MeasurementMarker;
  divIcon(options: { className: string; html: string }): unknown;
  latLng(latitude: number, longitude: number): LatLng;
  marker(
    latLng: LatLng,
    options: Record<string, unknown>,
  ): MeasurementMarker;
}

interface ShapeMeasurementDependencies {
  escapeHtml(value: string): string;
  flattenShapeLatLngs(value: unknown): LatLng[];
  getDefaultShapeColor(): string;
  getLeaflet(): MeasurementLeaflet;
  getMap(): MeasurementMap;
  getSegmentLabelGroupSize(): number;
  normalizeShapeColor(value: unknown, fallback?: string): string;
}

type MeasurementLabelVariant =
  | "segment"
  | "summary"
  | "summary-circle"
  | "summary-polyline"
  | "summary-rectangle";

export function createShapeMeasurementRuntime({
  escapeHtml,
  flattenShapeLatLngs,
  getDefaultShapeColor,
  getLeaflet,
  getMap,
  getSegmentLabelGroupSize,
  normalizeShapeColor,
}: ShapeMeasurementDependencies) {
  const getCircleRadiusFromGeoJson = (geojson: unknown): number | null => {
    const radius = Number(
      geojson && typeof geojson === "object"
        ? (geojson as { properties?: { radius?: unknown } }).properties?.radius
        : undefined,
    );
    return Number.isFinite(radius) && radius > 0 ? radius : null;
  };

  const getPolylineCenterLatLng = (
    layer: MeasurementLayer,
  ): LatLng | null => {
    const latLngs = flattenShapeLatLngs(layer.getLatLngs?.());
    if (latLngs.length === 0) return null;
    if (latLngs.length === 1) return latLngs[0] ?? null;

    const map = getMap();
    let totalDistance = 0;
    for (let index = 1; index < latLngs.length; index += 1) {
      totalDistance += map.distance(latLngs[index - 1]!, latLngs[index]!);
    }
    if (totalDistance === 0) {
      return latLngs[Math.floor(latLngs.length / 2)] ?? null;
    }

    const targetDistance = totalDistance / 2;
    let accumulatedDistance = 0;
    for (let index = 1; index < latLngs.length; index += 1) {
      const start = latLngs[index - 1]!;
      const end = latLngs[index]!;
      const segmentDistance = map.distance(start, end);
      if (accumulatedDistance + segmentDistance >= targetDistance) {
        const ratio = (targetDistance - accumulatedDistance) / segmentDistance;
        return getLeaflet().latLng(
          start.lat + (end.lat - start.lat) * ratio,
          start.lng + (end.lng - start.lng) * ratio,
        );
      }
      accumulatedDistance += segmentDistance;
    }
    return latLngs[Math.floor(latLngs.length / 2)] ?? null;
  };

  const formatDistance = (distanceInMeters: number): string => {
    if (!Number.isFinite(distanceInMeters)) return "-";
    if (distanceInMeters >= 1000) {
      return `${(distanceInMeters / 1000).toFixed(2)} km`;
    }
    if (distanceInMeters >= 100) return `${Math.round(distanceInMeters)} m`;
    return `${distanceInMeters.toFixed(1)} m`;
  };

  const formatArea = (areaInSquareMeters: number): string => {
    if (!Number.isFinite(areaInSquareMeters)) return "-";
    if (areaInSquareMeters >= 1_000_000) {
      return `${(areaInSquareMeters / 1_000_000).toFixed(2)} km²`;
    }
    return `${Math.round(areaInSquareMeters)} m²`;
  };

  const trimClosedLatLngs = (latLngs: unknown): LatLng[] => {
    if (!Array.isArray(latLngs) || latLngs.length < 2) {
      return Array.isArray(latLngs) ? [...latLngs] : [];
    }
    const normalizedLatLngs = [...latLngs] as LatLng[];
    const first = normalizedLatLngs[0];
    const last = normalizedLatLngs[normalizedLatLngs.length - 1];
    if (first && last && first.lat === last.lat && first.lng === last.lng) {
      normalizedLatLngs.pop();
    }
    return normalizedLatLngs;
  };

  const measurePolyline = (layer?: MeasurementLayer | null) => {
    const latLngs = flattenShapeLatLngs(layer?.getLatLngs?.());
    const segments: MeasurementSegment[] = [];
    let totalDistance = 0;
    for (let index = 1; index < latLngs.length; index += 1) {
      const distance = getMap().distance(latLngs[index - 1]!, latLngs[index]!);
      segments.push({ label: `${index}`, distance });
      totalDistance += distance;
    }
    return { segments, totalDistance };
  };

  const calculateProjectedPolygonArea = (latLngs: unknown): number => {
    const vertices = trimClosedLatLngs(latLngs);
    if (vertices.length < 3) return 0;
    const map = getMap();
    let sum = 0;
    for (let index = 0; index < vertices.length; index += 1) {
      const current = map.options.crs.project(vertices[index]!);
      const next = map.options.crs.project(
        vertices[(index + 1) % vertices.length]!,
      );
      sum += current.x * next.y - next.x * current.y;
    }
    return Math.abs(sum) / 2;
  };

  const measureCircle = (layer?: MeasurementLayer | null) => {
    const radius = Number(layer?.getRadius?.());
    return {
      radius,
      area: Number.isFinite(radius) ? Math.PI * radius * radius : 0,
    };
  };

  const getSegmentMidpoint = (start: LatLng, end: LatLng): LatLng =>
    getLeaflet().latLng(
      start.lat + (end.lat - start.lat) / 2,
      start.lng + (end.lng - start.lng) / 2,
    );

  const getMeasurementVertexLatLngs = (
    layer?: MeasurementLayer | null,
  ): LatLng[] => {
    if (!layer) return [];
    if (layer.shapeType === "polyline") {
      return flattenShapeLatLngs(layer.getLatLngs?.());
    }
    if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
      return trimClosedLatLngs(flattenShapeLatLngs(layer.getLatLngs?.()));
    }
    return [];
  };

  const createMeasurementVertexMarker = (
    latLng: LatLng | null | undefined,
    layer?: MeasurementLayer | null,
    emphasized = false,
  ): MeasurementMarker | null => {
    if (!latLng) return null;
    const shapeColor = normalizeShapeColor(
      layer?.shapeStyle?.color,
      getDefaultShapeColor(),
    );
    const marker = getLeaflet().circleMarker(latLng, {
      color: shapeColor,
      fillColor: emphasized ? shapeColor : "#ffffff",
      fillOpacity: 1,
      interactive: false,
      opacity: 1,
      radius: emphasized ? 5 : 4,
      weight: 2,
    });
    marker.isMeasurementLabel = true;
    marker.isMeasurementVertex = true;
    return marker;
  };

  const getSegmentGroupCenterLatLng = (
    segments: unknown,
  ): LatLng | null => {
    const validSegments = Array.isArray(segments)
      ? (segments as MeasurementSegment[]).filter(
          (segment) => segment?.start && segment?.end,
        )
      : [];
    if (validSegments.length === 0) return null;

    const map = getMap();
    let totalDistance = 0;
    validSegments.forEach((segment) => {
      totalDistance += map.distance(segment.start!, segment.end!);
    });
    if (totalDistance <= 0) {
      return getSegmentMidpoint(
        validSegments[0]!.start!,
        validSegments[0]!.end!,
      );
    }

    const targetDistance = totalDistance / 2;
    let accumulatedDistance = 0;
    for (const segment of validSegments) {
      const segmentDistance = map.distance(segment.start!, segment.end!);
      if (accumulatedDistance + segmentDistance >= targetDistance) {
        const ratio =
          segmentDistance > 0
            ? (targetDistance - accumulatedDistance) / segmentDistance
            : 0;
        return getLeaflet().latLng(
          segment.start!.lat + (segment.end!.lat - segment.start!.lat) * ratio,
          segment.start!.lng + (segment.end!.lng - segment.start!.lng) * ratio,
        );
      }
      accumulatedDistance += segmentDistance;
    }
    const lastSegment = validSegments[validSegments.length - 1]!;
    return getSegmentMidpoint(lastSegment.start!, lastSegment.end!);
  };

  const buildMeasurementLabelHtml = (
    lines: string[],
    variant: MeasurementLabelVariant = "segment",
  ): string => {
    const classNameMap: Record<MeasurementLabelVariant, string> = {
      segment: "shape-measure-label",
      summary: "shape-measure-label shape-measure-label--summary",
      "summary-polyline":
        "shape-measure-label shape-measure-label--summary shape-measure-label--summary-polyline",
      "summary-circle":
        "shape-measure-label shape-measure-label--summary shape-measure-label--summary-circle",
      "summary-rectangle":
        "shape-measure-label shape-measure-label--summary shape-measure-label--summary-rectangle",
    };
    const className = classNameMap[variant] || classNameMap.segment;
    const lineHtml = lines
      .map(
        (line) =>
          `<div class="shape-measure-label-line">${escapeHtml(line)}</div>`,
      )
      .join("");
    return `<div class="${className}">${lineHtml}</div>`;
  };

  const createMeasurementLabelMarker = (
    latLng: LatLng | null | undefined,
    lines: string[],
    variant: MeasurementLabelVariant = "segment",
  ): MeasurementMarker | null => {
    if (!latLng || !Array.isArray(lines) || lines.length === 0) return null;
    const leaflet = getLeaflet();
    const marker = leaflet.marker(latLng, {
      interactive: false,
      keyboard: false,
      zIndexOffset: 900,
      icon: leaflet.divIcon({
        className: "shape-measure-marker",
        html: buildMeasurementLabelHtml(lines, variant),
      }),
    });
    marker.isMeasurementLabel = true;
    return marker;
  };

  const createGroupedSegmentMeasurementMarkers = (
    segments: MeasurementSegment[],
  ): MeasurementMarker[] => {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const markers: MeasurementMarker[] = [];
    const groupSize = getSegmentLabelGroupSize();
    for (let index = 0; index < segments.length; index += groupSize) {
      const group = segments.slice(index, index + groupSize);
      const totalDistance = group.reduce(
        (sum, segment) =>
          sum + (Number.isFinite(segment.distance) ? segment.distance : 0),
        0,
      );
      const marker = createMeasurementLabelMarker(
        getSegmentGroupCenterLatLng(group),
        [formatDistance(totalDistance)],
      );
      if (marker) markers.push(marker);
    }
    return markers;
  };

  const createGroupedSegmentEndpointMarkers = (
    segments: MeasurementSegment[],
    layer?: MeasurementLayer | null,
  ): MeasurementMarker[] => {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const markers: MeasurementMarker[] = [];
    const seenEndpointKeys = new Set<string>();
    const groupSize = getSegmentLabelGroupSize();
    for (let index = 0; index < segments.length; index += groupSize) {
      const group = segments.slice(index, index + groupSize);
      const endpoints = [group[0]?.start, group[group.length - 1]?.end];
      endpoints.forEach((latLng) => {
        if (!latLng) return;
        const endpointKey = `${latLng.lat}:${latLng.lng}`;
        if (seenEndpointKeys.has(endpointKey)) return;
        seenEndpointKeys.add(endpointKey);
        const marker = createMeasurementVertexMarker(latLng, layer, true);
        if (marker) markers.push(marker);
      });
    }
    return markers;
  };

  const setMeasurementMarkerVisibility = (
    marker: MeasurementMarker | null | undefined,
    visible: boolean,
  ): void => {
    if (!marker || marker.isMeasurementLabel !== true) return;
    marker.setOpacity?.(visible ? 1 : 0);
    if (marker.isMeasurementVertex === true) {
      marker.setStyle?.({
        fillOpacity: visible ? 1 : 0,
        opacity: visible ? 1 : 0,
      });
    }
    const markerElement = marker.getElement?.() ?? null;
    if (markerElement) markerElement.style.display = visible ? "" : "none";
  };

  return {
    buildMeasurementLabelHtml,
    calculateProjectedPolygonArea,
    createGroupedSegmentEndpointMarkers,
    createGroupedSegmentMeasurementMarkers,
    createMeasurementLabelMarker,
    createMeasurementVertexMarker,
    formatArea,
    formatDistance,
    getCircleRadiusFromGeoJson,
    getMeasurementVertexLatLngs,
    getPolylineCenterLatLng,
    getSegmentGroupCenterLatLng,
    getSegmentMidpoint,
    measureCircle,
    measurePolyline,
    setMeasurementMarkerVisibility,
    trimClosedLatLngs,
  };
}
