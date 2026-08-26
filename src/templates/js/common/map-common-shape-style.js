function normalizeShapeName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim();
}

const SHAPE_MEMO_MAX_LENGTH = 10000;

function normalizeShapeMemo(memo) {
  return typeof memo === "string" ? memo : "";
}

function getShapeMemoFromGeoJson(geojson) {
  return normalizeShapeMemo(geojson?.properties?.memo);
}

function renderShapeMemoPopupContent(shapeName, memo) {
  const normalizedMemo = normalizeShapeMemo(memo);
  if (!normalizedMemo.trim()) {
    return "";
  }

  const title = normalizeShapeName(shapeName);
  const titleHtml = title ? `<h1>${escapeHtml(title)}</h1>` : "";
  const markdownHtml = marked.parse(normalizedMemo);
  const cleanHtml = filterXSS(markdownHtml, xssOptions);
  return `<div class="md-detail-contents">${titleHtml}${renderIframe(cleanHtml)}</div>`;
}

function openShapeMemoPopup(layer, latLng) {
  if (!layer || !latLng) {
    return false;
  }

  const popupContent = renderShapeMemoPopupContent(
    layer.shapeName,
    layer.shapeMemo,
  );
  if (!popupContent) {
    return false;
  }

  const popup = L.popup()
    .setLatLng(latLng)
    .setContent(popupContent)
    .openOn(map);
  setTimeout(() => {
    const popupElement =
      popup && typeof popup.getElement === "function"
        ? popup.getElement()
        : null;
    setupDetailsLazyImages(popupElement || document);
  }, 0);
  return true;
}

function attachShapeMemoPopup(layer) {
  if (!layer || layer.shapeMemoClickBound === true) {
    return;
  }
  layer.shapeMemoClickBound = true;
  layer.on("click", (event) => {
    openShapeMemoPopup(layer, event?.latlng);
  });
}

// 図形名ラベルのクリック・タップでも、図形本体と同じメモを開く
function attachShapeMemoTooltipOpen(layer, labelLatLng) {
  if (!layer || !labelLatLng) {
    return;
  }

  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  const tooltipElement =
    tooltip && typeof tooltip.getElement === "function"
      ? tooltip.getElement()
      : null;
  if (!tooltipElement || tooltipElement.dataset.shapeMemoOpenBound === "true") {
    return;
  }

  tooltipElement.dataset.shapeMemoOpenBound = "true";
  let lastTouchEndAt = 0;
  const openMemoFromLabel = (event) => {
    L.DomEvent.stop(event);
    const eventTimestamp = Date.now();
    if (event?.type === "click" && eventTimestamp - lastTouchEndAt < 500) {
      return;
    }
    if (event?.type === "touchend") {
      lastTouchEndAt = eventTimestamp;
    }
    openShapeMemoPopup(layer, labelLatLng);
  };

  L.DomEvent.on(tooltipElement, "click", openMemoFromLabel);
  L.DomEvent.on(tooltipElement, "touchend", openMemoFromLabel);
}

function normalizeShapeColor(color, fallback = SHAPE_STYLE.color) {
  if (typeof color !== "string") {
    return fallback;
  }

  const trimmedColor = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) {
    return trimmedColor.toLowerCase();
  }

  if (/^#[0-9a-fA-F]{3}$/.test(trimmedColor)) {
    const expandedColor = trimmedColor
      .slice(1)
      .split("")
      .map((value) => value + value)
      .join("");
    return `#${expandedColor}`.toLowerCase();
  }

  return fallback;
}

const SHAPE_LINE_TYPE_OPTIONS = [
  { value: "solid", label: "実線", dashArray: null },
  { value: "dashed", label: "破線", dashArray: "12,8" },
  { value: "dotted", label: "点線", dashArray: "1,6" },
  { value: "dash-dot", label: "一点鎖線", dashArray: "12,6,1,6" },
];

const SHAPE_ARROW_TYPE_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "start", label: "始点" },
  { value: "end", label: "終点" },
  { value: "both", label: "両端" },
];

const SHAPE_ARROW_MARKER_ID_PREFIX = "geocode-shape-arrowhead";

const SHAPE_WEIGHT_MIN = 1;
const SHAPE_WEIGHT_MAX = 10;
const POLYLINE_HOVER_MIN_WEIGHT = 8;
const POLYLINE_HOVER_WEIGHT_INCREMENT = 4;

function normalizeShapeWeight(weight, fallback = SHAPE_STYLE.weight) {
  const numericFallback = Number(fallback);
  const normalizedFallback = Number.isFinite(numericFallback)
    ? Math.min(SHAPE_WEIGHT_MAX, Math.max(SHAPE_WEIGHT_MIN, numericFallback))
    : 5;
  if (weight === null || weight === "") {
    return normalizedFallback;
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) {
    return normalizedFallback;
  }
  return Math.min(SHAPE_WEIGHT_MAX, Math.max(SHAPE_WEIGHT_MIN, numericWeight));
}

function normalizeShapeLineType(lineType, fallback = "solid") {
  const normalizedFallback = SHAPE_LINE_TYPE_OPTIONS.some(
    (option) => option.value === fallback,
  )
    ? fallback
    : "solid";
  if (typeof lineType !== "string") {
    return normalizedFallback;
  }

  const normalizedLineType = lineType.trim().toLowerCase();
  return SHAPE_LINE_TYPE_OPTIONS.some(
    (option) => option.value === normalizedLineType,
  )
    ? normalizedLineType
    : normalizedFallback;
}

function normalizeShapeArrowType(arrowType, fallback = "none") {
  const normalizedFallback = SHAPE_ARROW_TYPE_OPTIONS.some(
    (option) => option.value === fallback,
  )
    ? fallback
    : "none";
  if (typeof arrowType !== "string") {
    return normalizedFallback;
  }

  const normalizedArrowType = arrowType.trim().toLowerCase();
  return SHAPE_ARROW_TYPE_OPTIONS.some(
    (option) => option.value === normalizedArrowType,
  )
    ? normalizedArrowType
    : normalizedFallback;
}

function normalizeDashArrayValue(dashArray) {
  if (typeof dashArray !== "string") {
    return "";
  }
  return dashArray
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(",");
}

function getShapeLineTypeFromDashArray(dashArray) {
  const normalizedDashArray = normalizeDashArrayValue(dashArray);
  const matchingOption = SHAPE_LINE_TYPE_OPTIONS.find(
    (option) =>
      normalizeDashArrayValue(option.dashArray) === normalizedDashArray,
  );
  return matchingOption ? matchingOption.value : "solid";
}

function getShapeDashArray(lineType) {
  const normalizedLineType = normalizeShapeLineType(lineType);
  return (
    SHAPE_LINE_TYPE_OPTIONS.find(
      (option) => option.value === normalizedLineType,
    )?.dashArray || null
  );
}

function normalizeShapeDashArray(dashArray) {
  return getShapeDashArray(getShapeLineTypeFromDashArray(dashArray));
}

function getDefaultShapeStyle(shapeType) {
  if (shapeType === "polyline") {
    return {
      color: SHAPE_STYLE.color,
      weight: SHAPE_STYLE.weight,
      dashArray: null,
      arrowType: "none",
      fill: false,
    };
  }

  return {
    color: SHAPE_STYLE.color,
    weight: SHAPE_STYLE.weight,
    dashArray: null,
    fillColor: SHAPE_STYLE.color,
    fillOpacity: SHAPE_STYLE.fillOpacity,
  };
}

function getShapeStyleFromGeoJson(shapeType, geojson) {
  const defaultStyle = getDefaultShapeStyle(shapeType);
  const styleRecord = geojson?.properties?.style;
  if (!styleRecord || typeof styleRecord !== "object") {
    return defaultStyle;
  }

  const nextColor = normalizeShapeColor(styleRecord.color, defaultStyle.color);
  const nextWeight = normalizeShapeWeight(
    styleRecord.weight,
    defaultStyle.weight,
  );
  const nextDashArray = normalizeShapeDashArray(styleRecord.dashArray);
  if (shapeType === "polyline") {
    return {
      color: nextColor,
      weight: nextWeight,
      dashArray: nextDashArray,
      arrowType: normalizeShapeArrowType(styleRecord.arrowType),
      fill: false,
    };
  }

  const nextFillOpacity = Number(styleRecord.fillOpacity);
  return {
    color: nextColor,
    weight: nextWeight,
    dashArray: nextDashArray,
    fillColor: nextColor,
    fillOpacity: Number.isFinite(nextFillOpacity)
      ? nextFillOpacity
      : defaultStyle.fillOpacity,
  };
}

function getShapeArrowMarkerId(color) {
  const normalizedColor = normalizeShapeColor(color, SHAPE_STYLE.color);
  return `${SHAPE_ARROW_MARKER_ID_PREFIX}-${normalizedColor.slice(1)}`;
}

function ensureShapeArrowMarker(color) {
  const normalizedColor = normalizeShapeColor(color, SHAPE_STYLE.color);
  const markerId = getShapeArrowMarkerId(normalizedColor);
  if (document.getElementById(markerId)) {
    return markerId;
  }

  const svgNamespace = "http://www.w3.org/2000/svg";
  let definitionsSvg = document.getElementById("geocode-shape-svg-definitions");
  if (!definitionsSvg) {
    definitionsSvg = document.createElementNS(svgNamespace, "svg");
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
    definitions = document.createElementNS(svgNamespace, "defs");
    definitionsSvg.appendChild(definitions);
  }

  const marker = document.createElementNS(svgNamespace, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("viewBox", "0 0 4 4");
  marker.setAttribute("refX", "3.25");
  marker.setAttribute("refY", "2");
  marker.setAttribute("markerWidth", "4.5");
  marker.setAttribute("markerHeight", "4.5");
  marker.setAttribute("markerUnits", "strokeWidth");
  marker.setAttribute("orient", "auto-start-reverse");

  const arrowPath = document.createElementNS(svgNamespace, "path");
  arrowPath.setAttribute("d", "M 0 0 L 4 2 L 0 4 z");
  // WebKit では context-stroke が未対応のため、線色を明示的に設定する。
  arrowPath.setAttribute("fill", normalizedColor);
  marker.appendChild(arrowPath);
  definitions.appendChild(marker);
  return markerId;
}

function applyShapeArrowStyle(layer) {
  const path = layer?._path;
  if (!path) {
    return;
  }

  path.removeAttribute("marker-start");
  path.removeAttribute("marker-end");
  if (layer.shapeType !== "polyline") {
    return;
  }

  const arrowType = normalizeShapeArrowType(layer.shapeStyle?.arrowType);
  if (arrowType === "none") {
    return;
  }

  const fallbackColor = normalizeShapeColor(
    layer.shapeStyle?.color,
    SHAPE_STYLE.color,
  );
  const strokeColor = normalizeShapeColor(
    path.getAttribute("stroke"),
    fallbackColor,
  );
  const markerId = ensureShapeArrowMarker(strokeColor);
  const markerReference = `url(#${markerId})`;
  if (arrowType === "start" || arrowType === "both") {
    path.setAttribute("marker-start", markerReference);
  }
  if (arrowType === "end" || arrowType === "both") {
    path.setAttribute("marker-end", markerReference);
  }
}

function bindShapeArrowStyle(layer) {
  if (!layer || layer.shapeArrowStyleBound === true) {
    return;
  }
  layer.shapeArrowStyleBound = true;
  layer.on("add", () => applyShapeArrowStyle(layer));
  applyShapeArrowStyle(layer);
}

// マウス操作できるPC環境で、折れ線を捉えた間だけ線幅を広げる
function bindPolylineHoverHighlight(layer, { restoreStyle } = {}) {
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

  const supportsMouseHover = () =>
    typeof matchMedia === "function" &&
    matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;

  const clearHighlight = () => {
    if (!isHighlighted) {
      return;
    }
    isHighlighted = false;
    if (typeof restoreStyle === "function") {
      restoreStyle(layer);
    } else {
      layer.setStyle({
        weight: normalizeShapeWeight(
          layer.shapeStyle?.weight,
          SHAPE_STYLE.weight,
        ),
      });
      applyShapeArrowStyle(layer);
    }
  };

  layer.on("mouseover", () => {
    if (isHighlighted || !supportsMouseHover()) {
      return;
    }

    const currentWeight = normalizeShapeWeight(
      layer.options?.weight,
      layer.shapeStyle?.weight,
    );
    isHighlighted = true;
    layer.setStyle({
      weight: Math.max(
        POLYLINE_HOVER_MIN_WEIGHT,
        currentWeight + POLYLINE_HOVER_WEIGHT_INCREMENT,
      ),
    });
    applyShapeArrowStyle(layer);
  });
  layer.on("mouseout", clearHighlight);
  layer.on("remove", clearHighlight);
}

function getCircleRadiusFromGeoJson(geojson) {
  const radius = Number(geojson?.properties?.radius);
  return Number.isFinite(radius) && radius > 0 ? radius : null;
}

function getPolylineCenterLatLng(layer) {
  const latLngs = flattenShapeLatLngs(layer.getLatLngs());
  if (latLngs.length === 0) {
    return null;
  }
  if (latLngs.length === 1) {
    return latLngs[0];
  }

  let totalDistance = 0;
  for (let i = 1; i < latLngs.length; i += 1) {
    totalDistance += map.distance(latLngs[i - 1], latLngs[i]);
  }

  if (totalDistance === 0) {
    return latLngs[Math.floor(latLngs.length / 2)];
  }

  const targetDistance = totalDistance / 2;
  let accumulatedDistance = 0;
  for (let i = 1; i < latLngs.length; i += 1) {
    const start = latLngs[i - 1];
    const end = latLngs[i];
    const segmentDistance = map.distance(start, end);
    if (accumulatedDistance + segmentDistance >= targetDistance) {
      const ratio = (targetDistance - accumulatedDistance) / segmentDistance;
      return L.latLng(
        start.lat + (end.lat - start.lat) * ratio,
        start.lng + (end.lng - start.lng) * ratio,
      );
    }
    accumulatedDistance += segmentDistance;
  }

  return latLngs[Math.floor(latLngs.length / 2)];
}

function formatDistance(distanceInMeters) {
  if (!Number.isFinite(distanceInMeters)) {
    return "-";
  }

  if (distanceInMeters >= 1000) {
    return `${(distanceInMeters / 1000).toFixed(2)} km`;
  }

  if (distanceInMeters >= 100) {
    return `${Math.round(distanceInMeters)} m`;
  }

  return `${distanceInMeters.toFixed(1)} m`;
}

function formatArea(areaInSquareMeters) {
  if (!Number.isFinite(areaInSquareMeters)) {
    return "-";
  }

  if (areaInSquareMeters >= 1000000) {
    return `${(areaInSquareMeters / 1000000).toFixed(2)} km²`;
  }

  return `${Math.round(areaInSquareMeters)} m²`;
}

function trimClosedLatLngs(latLngs) {
  if (!Array.isArray(latLngs) || latLngs.length < 2) {
    return Array.isArray(latLngs) ? [...latLngs] : [];
  }

  const normalizedLatLngs = [...latLngs];
  const first = normalizedLatLngs[0];
  const last = normalizedLatLngs[normalizedLatLngs.length - 1];
  if (first && last && first.lat === last.lat && first.lng === last.lng) {
    normalizedLatLngs.pop();
  }

  return normalizedLatLngs;
}

function measurePolyline(layer) {
  const latLngs = flattenShapeLatLngs(layer?.getLatLngs?.());
  const segments = [];
  let totalDistance = 0;

  for (let i = 1; i < latLngs.length; i += 1) {
    const distance = map.distance(latLngs[i - 1], latLngs[i]);
    segments.push({
      label: `${i}`,
      distance,
    });
    totalDistance += distance;
  }

  return {
    segments,
    totalDistance,
  };
}

function calculateProjectedPolygonArea(latLngs) {
  const vertices = trimClosedLatLngs(latLngs);
  if (vertices.length < 3) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const current = map.options.crs.project(vertices[i]);
    const next = map.options.crs.project(vertices[(i + 1) % vertices.length]);
    sum += current.x * next.y - next.x * current.y;
  }

  return Math.abs(sum) / 2;
}

function measureCircle(layer) {
  const radius = Number(layer?.getRadius?.());
  return {
    radius,
    area: Number.isFinite(radius) ? Math.PI * radius * radius : 0,
  };
}

function getSegmentMidpoint(startLatLng, endLatLng) {
  return L.latLng(
    startLatLng.lat + (endLatLng.lat - startLatLng.lat) / 2,
    startLatLng.lng + (endLatLng.lng - startLatLng.lng) / 2,
  );
}

function getMeasurementVertexLatLngs(layer) {
  if (!layer) {
    return [];
  }

  if (layer.shapeType === "polyline") {
    return flattenShapeLatLngs(layer.getLatLngs());
  }

  if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
    return trimClosedLatLngs(flattenShapeLatLngs(layer.getLatLngs()));
  }

  return [];
}

function createMeasurementVertexMarker(latLng, layer, emphasized = false) {
  if (!latLng) {
    return null;
  }

  const shapeColor = normalizeShapeColor(
    layer?.shapeStyle?.color,
    SHAPE_STYLE.color,
  );
  const marker = L.circleMarker(latLng, {
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
}

function getSegmentGroupCenterLatLng(segments) {
  const validSegments = Array.isArray(segments)
    ? segments.filter((segment) => segment?.start && segment?.end)
    : [];
  if (validSegments.length === 0) {
    return null;
  }

  let totalDistance = 0;
  validSegments.forEach((segment) => {
    totalDistance += map.distance(segment.start, segment.end);
  });

  if (totalDistance <= 0) {
    return getSegmentMidpoint(validSegments[0].start, validSegments[0].end);
  }

  const targetDistance = totalDistance / 2;
  let accumulatedDistance = 0;
  for (const segment of validSegments) {
    const segmentDistance = map.distance(segment.start, segment.end);
    if (accumulatedDistance + segmentDistance >= targetDistance) {
      const ratio =
        segmentDistance > 0
          ? (targetDistance - accumulatedDistance) / segmentDistance
          : 0;
      return L.latLng(
        segment.start.lat + (segment.end.lat - segment.start.lat) * ratio,
        segment.start.lng + (segment.end.lng - segment.start.lng) * ratio,
      );
    }
    accumulatedDistance += segmentDistance;
  }

  const lastSegment = validSegments[validSegments.length - 1];
  return getSegmentMidpoint(lastSegment.start, lastSegment.end);
}

function createGroupedSegmentMeasurementMarkers(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const markers = [];
  for (
    let i = 0;
    i < segments.length;
    i += MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE
  ) {
    const group = segments.slice(i, i + MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE);
    const totalDistance = group.reduce((sum, segment) => {
      return sum + (Number.isFinite(segment.distance) ? segment.distance : 0);
    }, 0);
    const marker = createMeasurementLabelMarker(
      getSegmentGroupCenterLatLng(group),
      [formatDistance(totalDistance)],
    );
    if (marker) {
      markers.push(marker);
    }
  }

  return markers;
}

function createGroupedSegmentEndpointMarkers(segments, layer) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const markers = [];
  const seenEndpointKeys = new Set();
  for (
    let i = 0;
    i < segments.length;
    i += MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE
  ) {
    const group = segments.slice(i, i + MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE);
    const endpoints = [group[0]?.start, group[group.length - 1]?.end];
    endpoints.forEach((latLng) => {
      if (!latLng) {
        return;
      }

      const endpointKey = `${latLng.lat}:${latLng.lng}`;
      if (seenEndpointKeys.has(endpointKey)) {
        return;
      }

      seenEndpointKeys.add(endpointKey);
      markers.push(createMeasurementVertexMarker(latLng, layer, true));
    });
  }

  return markers;
}

function buildMeasurementLabelHtml(lines, variant = "segment") {
  const classNameMap = {
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
}

function createMeasurementLabelMarker(latLng, lines, variant = "segment") {
  if (!latLng || !Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  const marker = L.marker(latLng, {
    interactive: false,
    keyboard: false,
    zIndexOffset: 900,
    icon: L.divIcon({
      className: "shape-measure-marker",
      html: buildMeasurementLabelHtml(lines, variant),
    }),
  });

  marker.isMeasurementLabel = true;
  return marker;
}

function setMeasurementMarkerVisibility(marker, visible) {
  if (!marker || marker.isMeasurementLabel !== true) {
    return;
  }

  if (typeof marker.setOpacity === "function") {
    marker.setOpacity(visible ? 1 : 0);
  }

  if (
    marker.isMeasurementVertex === true &&
    typeof marker.setStyle === "function"
  ) {
    marker.setStyle({
      fillOpacity: visible ? 1 : 0,
      opacity: visible ? 1 : 0,
    });
  }

  const markerElement =
    typeof marker.getElement === "function" ? marker.getElement() : null;
  if (markerElement) {
    markerElement.style.display = visible ? "" : "none";
  }
}

function createLeafletShapeLayer(shapeType, geojson, shapeStyle) {
  if (shapeType === "circle") {
    const coordinates = geojson?.geometry?.coordinates;
    const radius = getCircleRadiusFromGeoJson(geojson);
    if (!Array.isArray(coordinates) || coordinates.length < 2 || !radius) {
      return null;
    }
    return L.circle(L.latLng(coordinates[1], coordinates[0]), {
      ...shapeStyle,
      radius,
    });
  }

  const geoJsonLayer = L.geoJSON(geojson, {
    style: () => shapeStyle,
  });
  const layers = geoJsonLayer.getLayers();
  const layer = layers.length === 0 ? null : layers[0];
  if (layer) {
    layer.shapeType = shapeType;
    layer.shapeStyle = shapeStyle;
    bindShapeArrowStyle(layer);
  }
  return layer;
}

function toggleTooltips() {
  if (isTooltipVisible) {
    map.eachLayer(function (layer) {
      if (layer?.isShapeNameLayer === true) {
        return;
      }
      if (layer.getTooltip) {
        var tooltip = layer.getTooltip();
        if (tooltip) {
          map.closeTooltip(tooltip);
        }
      }
    });
    isTooltipVisible = false;
  } else {
    map.eachLayer(function (layer) {
      if (layer?.isShapeNameLayer === true) {
        return;
      }
      if (layer.getTooltip) {
        layer.openTooltip();
      }
    });
    isTooltipVisible = true;
  }
}
