// Shared map helpers used by map and temporary map templates.

// This file is intentionally non-module so existing inline template scripts can use globals.

function createLayerBulkToggleControl({
  map,
  overlayLayers,
  position = "topright",
}) {
  const targetLayers = Array.isArray(overlayLayers)
    ? overlayLayers.filter(Boolean)
    : [];

  const LayerBulkToggleControl = L.Control.extend({
    options: {
      position,
    },
    onAdd: function () {
      const container = L.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control layer-bulk-toggle-control",
      );
      const button = L.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.type = "button";

      const hasVisibleLayer = () =>
        targetLayers.some((layer) => map.hasLayer(layer));

      const updateButtonState = () => {
        const shouldClear = hasVisibleLayer();
        button.textContent = shouldClear ? "全解除" : "全選択";
        button.setAttribute("aria-label", button.textContent);
      };

      const toggleAllLayers = () => {
        const shouldClear = hasVisibleLayer();
        targetLayers.forEach((layer) => {
          if (shouldClear) {
            if (map.hasLayer(layer)) {
              map.removeLayer(layer);
            }
            return;
          }

          if (!map.hasLayer(layer)) {
            map.addLayer(layer);
          }
        });
        updateButtonState();
      };

      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stop(event);
        toggleAllLayers();
      });

      map.on("overlayadd overlayremove", (event) => {
        if (!targetLayers.includes(event.layer)) {
          return;
        }
        updateButtonState();
      });

      L.DomEvent.disableClickPropagation(container);
      if (L.DomEvent.disableScrollPropagation) {
        L.DomEvent.disableScrollPropagation(container);
      }
      updateButtonState();
      return container;
    },
  });

  return new LayerBulkToggleControl();
}
function extractYouTubeId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const allowYouTubeList = [
      "www.youtube.com",
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com",
    ];
    if (!allowYouTubeList.includes(host)) return null;

    // shorts / watch / youtu.be に対応
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v") ?? "";
      return ID_RE.test(id) ? id : null;
    }
    if (url.pathname.startsWith("/embed/")) {
      const id = url.pathname.split("/")[2] ?? "";
      return ID_RE.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeShapeName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim();
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

function getDefaultShapeStyle(shapeType) {
  if (shapeType === "polyline") {
    return {
      color: SHAPE_STYLE.color,
      weight: SHAPE_STYLE.weight,
      fill: false,
    };
  }

  return {
    color: SHAPE_STYLE.color,
    weight: SHAPE_STYLE.weight,
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
  const nextWeight = Number(styleRecord.weight);
  if (shapeType === "polyline") {
    return {
      color: nextColor,
      weight: Number.isFinite(nextWeight) ? nextWeight : defaultStyle.weight,
      fill: false,
    };
  }

  const nextFillOpacity = Number(styleRecord.fillOpacity);
  return {
    color: nextColor,
    weight: Number.isFinite(nextWeight) ? nextWeight : defaultStyle.weight,
    fillColor: nextColor,
    fillOpacity: Number.isFinite(nextFillOpacity)
      ? nextFillOpacity
      : defaultStyle.fillOpacity,
  };
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
  return layers.length === 0 ? null : layers[0];
}

function toggleTooltips() {
  if (isTooltipVisible) {
    map.eachLayer(function (layer) {
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
      if (layer.getTooltip) {
        layer.openTooltip();
      }
    });
    isTooltipVisible = true;
  }
}

function updateMeasurementControlState() {
  const mergeButton = document.getElementById("measurement-merge-toggle-btn");
  if (mergeButton) {
    mergeButton.classList.toggle("is-hidden", !isMeasurementVisible);
    mergeButton.classList.toggle("is-active", isMeasurementSegmentMerged);
    mergeButton.setAttribute(
      "aria-pressed",
      isMeasurementSegmentMerged ? "true" : "false",
    );
  }
}

function toggleMeasurementSegmentMerge() {
  isMeasurementSegmentMerged = !isMeasurementSegmentMerged;
  refreshAllShapeMeasurementMarkers();
  updateMeasurementControlState();
}

function onSearchCode() {
  const latLng = document.getElementById("code-input").value;
  const cleandLatLng = latLng.replace(/[()\s]/g, "");
  const parts = cleandLatLng.split(",");
  if (parts.length === 2) {
    const lat = parts[0];
    const lng = parts[1];
    if (lat === "" || lng == "") {
      console.log("Not value.");
      return;
    }
    if (isValidCoordinate(lat, lng)) {
      let latLng = new L.LatLng(lat, lng);
      map.setView(latLng, 14);

      // カスタムアイコン
      let newIcon = L.icon({
        iconUrl: "/assets/marker.png",
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowUrl: null,
      });

      L.marker([lat, lng], { icon: newIcon })
        .addTo(map)
        .bindPopup(`緯度：${lat}<br>経度：${lng}`)
        .openPopup();
      return;
    } else {
      console.log("Not value.");
      return;
    }
  } else {
    console.log("Value error.");
    return;
  }
}

function createCodeSearchControl(options = {}) {
  const CodeSearchControl = L.Control.extend({
    options: {
      position: options.position ?? "topleft",
    },

    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      container.innerHTML = `
        <div class="search-zone">
            <input type="text" class="search-input" id="code-input" placeholder="緯度,経度" title="緯度経度を,区切りで入力してください。"><br>
            <button id="code-search-btn" class="custom-search">座標検索</button>
        </div>`;

      const searchBtn = container.querySelector(".custom-search");
      L.DomEvent.on(searchBtn, "click", function (event) {
        L.DomEvent.stop(event);
        onSearchCode();
      });

      L.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  return new CodeSearchControl();
}

function normalizeMarkerSearchText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function matchesMarkerSearch(record, query) {
  const normalizedQuery = normalizeMarkerSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const searchableText = [
    record?.marker_name,
    record?.detail,
    record?.latitude,
    record?.longitude,
  ]
    .map(normalizeMarkerSearchText)
    .join(" ");

  return searchableText.includes(normalizedQuery);
}

// レイヤのチェック状態と検索条件から、表示用の単一マーカーグループを再構築する
function createLayeredMarkerDisplayManager({
  map,
  markerRecords,
  markers,
  visibleMarkerGroup,
  layerVisibilityGroups,
  inputId = "marker-search-input",
}) {
  let searchQuery = "";

  // layersControl 用の管理レイヤが地図上にあるかでチェック状態を判定する
  const isLayerVisible = (layerId) => {
    const visibilityGroup = layerVisibilityGroups?.[layerId];
    return Boolean(visibilityGroup && map.hasLayer(visibilityGroup));
  };

  const findLayerIdByVisibilityGroup = (targetGroup) => {
    for (const layerId in layerVisibilityGroups) {
      if (layerVisibilityGroups[layerId] === targetGroup) {
        return layerId;
      }
    }

    return null;
  };

  // チェック済みレイヤと検索条件に一致するマーカーだけを表示用グループへ入れ直す
  const rebuildVisibleMarkers = () => {
    if (!markerRecords || !markers || !visibleMarkerGroup) {
      return;
    }

    visibleMarkerGroup.clearLayers();

    Object.keys(markerRecords).forEach((key) => {
      const record = markerRecords[key];
      const layerId = record?.layer_id;
      if (
        !isLayerVisible(layerId) ||
        !matchesMarkerSearch(record, searchQuery)
      ) {
        return;
      }

      const marker = markers[`marker-${record?.id}`];
      if (marker) {
        visibleMarkerGroup.addLayer(marker);
      }
    });

    if (map && typeof map.closePopup === "function") {
      map.closePopup();
    }
  };

  const setSearchQuery = (query) => {
    searchQuery = normalizeMarkerSearchText(query) ? query : "";
    rebuildVisibleMarkers();
  };

  const clearSearch = ({ clearInput = true } = {}) => {
    searchQuery = "";
    if (clearInput) {
      const input = document.getElementById(inputId);
      if (input) {
        input.value = "";
      }
    }
    rebuildVisibleMarkers();
  };

  return {
    clearSearch,
    findLayerIdByVisibilityGroup,
    isLayerVisible,
    rebuildVisibleMarkers,
    setSearchQuery,
  };
}

function filterLayeredMarkersByQuery({
  markerRecords,
  markers,
  clusterGroups,
  query,
}) {
  if (!markerRecords || !markers || !clusterGroups) {
    return;
  }

  if (!normalizeMarkerSearchText(query)) {
    clearLayeredMarkerSearch({
      markerRecords,
      markers,
      clusterGroups,
    });
    return;
  }

  Object.values(clusterGroups).forEach((group) => {
    group.clearLayers();
  });

  Object.keys(markerRecords).forEach((key) => {
    const record = markerRecords[key];
    const markerId = record?.id;
    const layerId = record?.layer_id;
    const marker = markers[`marker-${markerId}`];
    const targetGroup = clusterGroups[layerId];

    if (!marker || !targetGroup || !matchesMarkerSearch(record, query)) {
      return;
    }

    targetGroup.addLayer(marker);
  });

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
}

function restoreLayeredMarkers({ markerRecords, markers, clusterGroups }) {
  if (!markerRecords || !markers || !clusterGroups) {
    return;
  }

  Object.values(clusterGroups).forEach((group) => {
    group.clearLayers();
  });

  Object.keys(markerRecords).forEach((key) => {
    const record = markerRecords[key];
    const markerId = record?.id;
    const layerId = record?.layer_id;
    const marker = markers[`marker-${markerId}`];
    const targetGroup = clusterGroups[layerId];

    if (!marker || !targetGroup) {
      return;
    }

    targetGroup.addLayer(marker);
  });
}

function clearLayeredMarkerSearch({
  markerRecords,
  markers,
  clusterGroups,
  inputId = "marker-search-input",
}) {
  restoreLayeredMarkers({ markerRecords, markers, clusterGroups });

  const input = document.getElementById(inputId);
  if (input) {
    input.value = "";
  }

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
}

function createMarkerSearchControl(options = {}) {
  const MarkerSearchControl = L.Control.extend({
    options: {
      position: options.position ?? "topleft",
    },

    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      const inputId = options.inputId ?? "marker-search-input";
      container.innerHTML = `
        <div class="search-zone">
            <input type="text" class="search-input marker-search-input" id="${inputId}" placeholder="マーカー検索" title="マーカー名や詳細を検索します。">
        </div>`;

      const input = container.querySelector(`#${inputId}`);
      let isComposing = false;
      const search = function (event) {
        if (event) {
          L.DomEvent.stop(event);
        }
        // 画面側で独自の再構築処理を持つ場合はそちらへ委譲する
        if (typeof options.onSearch === "function") {
          options.onSearch(input?.value ?? "");
          return;
        }
        filterLayeredMarkersByQuery({
          markerRecords: options.markerRecords,
          markers: options.markers,
          clusterGroups: options.clusterGroups,
          query: input?.value ?? "",
        });
      };
      const searchFromInput = function () {
        if (isComposing) {
          return;
        }

        if (!normalizeMarkerSearchText(input?.value ?? "")) {
          // 検索解除時も画面側の表示用グループを復元できるようにする
          if (typeof options.onClear === "function") {
            options.onClear({ clearInput: false });
            return;
          }
          clearLayeredMarkerSearch({
            markerRecords: options.markerRecords,
            markers: options.markers,
            clusterGroups: options.clusterGroups,
            inputId,
          });
          return;
        }

        search();
      };

      L.DomEvent.on(input, "keydown", function (event) {
        if (event.key === "Enter") {
          search(event);
        }
      });
      L.DomEvent.on(input, "compositionstart", function () {
        isComposing = true;
      });
      L.DomEvent.on(input, "compositionend", function () {
        isComposing = false;
        searchFromInput();
      });
      L.DomEvent.on(input, "input", function () {
        searchFromInput();
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    },
  });

  return new MarkerSearchControl();
}

function restoreFlatMarkers({ markers, markerGroup, baseMarkerIds = null }) {
  if (!markers || !markerGroup) {
    return;
  }

  markerGroup.clearLayers();

  const baseMarkerIdSet = Array.isArray(baseMarkerIds)
    ? new Set(baseMarkerIds.map((id) => `marker-${id}`))
    : null;

  Object.entries(markers).forEach(([key, marker]) => {
    if (baseMarkerIdSet && !baseMarkerIdSet.has(key)) {
      return;
    }
    markerGroup.addLayer(marker);
  });
}

function filterFlatMarkersByQuery({
  markerRecords,
  markers,
  markerGroup,
  query,
  baseMarkerIds = null,
}) {
  if (!markerRecords || !markers || !markerGroup) {
    return;
  }

  if (!normalizeMarkerSearchText(query)) {
    restoreFlatMarkers({ markers, markerGroup, baseMarkerIds });
    return;
  }

  markerGroup.clearLayers();

  const baseMarkerIdSet = Array.isArray(baseMarkerIds)
    ? new Set(baseMarkerIds.map((id) => `marker-${id}`))
    : null;

  Object.keys(markerRecords).forEach((key) => {
    const record = markerRecords[key];
    const markerId = record?.id;
    const markerKey = `marker-${markerId}`;
    const marker = markers[markerKey];

    if (baseMarkerIdSet && !baseMarkerIdSet.has(markerKey)) {
      return;
    }

    if (!marker || !matchesMarkerSearch(record, query)) {
      return;
    }

    markerGroup.addLayer(marker);
  });

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
}

function createFlatMarkerSearchControl(options = {}) {
  const FlatMarkerSearchControl = L.Control.extend({
    options: {
      position: options.position ?? "topleft",
    },

    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      const inputId = options.inputId ?? "marker-search-input";
      container.innerHTML = `
        <div class="search-zone">
            <input type="text" class="search-input marker-search-input" id="${inputId}" placeholder="マーカー検索" title="マーカー名や詳細を検索します。">
        </div>`;

      const input = container.querySelector(`#${inputId}`);
      let isComposing = false;
      const emitSearch = function (event) {
        if (event) {
          L.DomEvent.stop(event);
        }

        if (typeof options.onSearch === "function") {
          options.onSearch(input?.value ?? "");
          return;
        }

        filterFlatMarkersByQuery({
          markerRecords: options.markerRecords,
          markers: options.markers,
          markerGroup: options.markerGroup,
          query: input?.value ?? "",
          baseMarkerIds:
            typeof options.getBaseMarkerIds === "function"
              ? options.getBaseMarkerIds()
              : options.baseMarkerIds,
        });
      };
      const searchFromInput = function () {
        if (isComposing) {
          return;
        }
        emitSearch();
      };

      L.DomEvent.on(input, "keydown", function (event) {
        if (event.key === "Enter") {
          emitSearch(event);
        }
      });
      L.DomEvent.on(input, "compositionstart", function () {
        isComposing = true;
      });
      L.DomEvent.on(input, "compositionend", function () {
        isComposing = false;
        searchFromInput();
      });
      L.DomEvent.on(input, "input", function () {
        searchFromInput();
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    },
  });

  return new FlatMarkerSearchControl();
}

function isValidCoordinate(lat, lng) {
  return (
    !isNaN(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    !isNaN(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function renderIframe(html) {
  return html.replace(
    /<app-youtube\s+[^>]*video-id=["']([\w-]{11})["'][^>]*>(?:<\/app-youtube>)?/g,
    (_, videoId) => {
      const src = `https://www.youtube-nocookie.com/embed/${videoId}`;
      return `
                <iframe
                    src="${src}"
                    title="YouTube video player"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"
                    allowfullscreen
                    width="100%" height="315"
                    style="border:0;"
                ></iframe>
            `.trim();
    },
  );
}

function createNestedTokenizer(typeName) {
  const self = this.lexer;
  return {
    name: typeName,
    level: "block",
    start(src) {
      const re = new RegExp(`^:::${typeName}\\s`, "m");
      return src.match(re)?.index;
    },
    tokenizer(src, tokens) {
      if (!src.startsWith(`:::${typeName}`)) return null;

      const lines = src.split(/\r?\n/);
      let nestLevel = 0;
      let endIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^:::(\w+)/.test(line)) {
          nestLevel++;
        } else if (/^:::\s*$/.test(line)) {
          nestLevel--;
          if (nestLevel === 0) {
            endIndex = i;
            break;
          }
        }
      }

      if (endIndex === -1) return null;

      const rawLines = lines.slice(0, endIndex + 1);
      const raw = rawLines.join("\n");

      const titleMatch = lines[0].match(new RegExp(`^:::${typeName}\\s+(.+)`));
      const title = titleMatch ? titleMatch[1].trim() : typeName.toUpperCase();

      const content = lines.slice(1, endIndex).join("\n");

      return {
        type: typeName,
        raw,
        title,
        tokens: this.lexer.blockTokens(content),
      };
    },
    renderer(token) {
      const body = marked.parser(token.tokens);
      if (token.type === "details") {
        return `<details class="details">\n<summary>${token.title}</summary>\n${body}\n</details>\n`;
      } else {
        return `<div class="box ${token.type}">\n<summary>${token.title}</summary>\n${body}\n</div>\n`;
      }
    },
  };
}

function isLocalhost(url) {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "[::1]"
    );
  } catch (e) {
    return false;
  }
}

function isPDF(filename) {
  return /\.pdf$/i.test(filename);
}

function setupDetailsLazyImages(root = document) {
  const detailsList = root.querySelectorAll(".details");

  detailsList.forEach((details) => {
    if (details.hasAttribute("data-lazy-img-initialized")) return;

    details.setAttribute("data-lazy-img-initialized", "true");

    // 初期化処理: src -> data-srcへ退避
    const resources = details.querySelectorAll("img[src], video[src]");
    resources.forEach((element) => {
      const src = element.getAttribute("src");
      if (src) {
        element.setAttribute("data-src", src);
        element.removeAttribute("src");
      }
    });

    // toggleイベントで開かれたとき、自分の直下（= ネストしたdetails内は含めない）だけを処理
    details.addEventListener("toggle", () => {
      if (!details.open) return;

      // 自分の中のすべてのimg/videoを取得するが、閉じたこのdetailsの中にあるものは除外
      const childDetails = details.querySelectorAll(".details");

      // 画像と動画の処理を共通化
      const loadVisibleMedia = (selector) => {
        const elements = details.querySelectorAll(selector);
        elements.forEach((el) => {
          // elが閉じた子detailsの中に含まれるならスキップ
          for (const child of childDetails) {
            if (!child.open && child.contains(el)) return;
          }
          if (!el.getAttribute("src") && el.getAttribute("data-src")) {
            el.setAttribute("src", el.getAttribute("data-src"));
          }
        });
      };

      loadVisibleMedia("img[data-src]");
      loadVisibleMedia("video[data-src]");
    });
  });
}

// 通常マップで最後に選択したタイルサーバーIDをブラウザに保存するためのキー
const SELECTED_TILE_SERVER_STORAGE_KEY = "geocode-web:selected-tile-server-id";
const USER_LOCATION_VISIBILITY_STORAGE_KEY =
  "geocode-web:user-location-visible";
const SHAPE_LAYER_VISIBILITY_STORAGE_KEY = "geocode-web:shape-layer-visible";
const MAP_MOBILE_UI_HIDDEN_STORAGE_KEY = "geocode-web:map-mobile-ui-hidden";
// 一時共有マップなどから通常マップの選択状態を書き換えないよう、必要な画面だけで有効化する
let isTileServerSelectionPersistenceEnabled = false;

// 通常マップの初期化時に呼び出し、タイルサーバー選択の保存・復元を有効にする
function enableTileServerSelectionPersistence() {
  isTileServerSelectionPersistenceEnabled = true;
}

// 従来の初期値 "1" を優先し、存在しない場合は取得した一覧の先頭を使用する
function getDefaultTileServerId() {
  if (tileServers["1"]) {
    return "1";
  }
  return Object.keys(tileServers)[0];
}

// 保存済みIDが現在のタイルサーバー一覧に存在する場合だけ初期選択として復元する
function getInitialTileServerId() {
  const defaultTileServerId = getDefaultTileServerId();
  if (!isTileServerSelectionPersistenceEnabled) {
    return defaultTileServerId;
  }

  try {
    const savedTileServerId = localStorage.getItem(
      SELECTED_TILE_SERVER_STORAGE_KEY,
    );
    if (savedTileServerId && tileServers[savedTileServerId]) {
      return savedTileServerId;
    }
  } catch (error) {
    console.warn("Failed to restore selected tile server:", error);
  }

  return defaultTileServerId;
}

// タイル切替後の選択IDを保存する。localStorageが利用できない環境でも地図表示は継続する
function saveSelectedTileServerId(tileServerId) {
  if (!isTileServerSelectionPersistenceEnabled || !tileServers[tileServerId]) {
    return;
  }

  try {
    localStorage.setItem(SELECTED_TILE_SERVER_STORAGE_KEY, tileServerId);
  } catch (error) {
    console.warn("Failed to save selected tile server:", error);
  }
}

// 通常マップの現在位置レイヤー表示状態を復元する。保存値がない場合は従来どおり表示する
function getInitialUserLocationVisibility() {
  try {
    const savedVisibility = localStorage.getItem(
      USER_LOCATION_VISIBILITY_STORAGE_KEY,
    );
    if (savedVisibility === "false") {
      return false;
    }
    if (savedVisibility === "true") {
      return true;
    }
  } catch (error) {
    console.warn("Failed to restore user location visibility:", error);
  }

  return true;
}

// 現在位置レイヤーの表示状態を保存する。localStorageが利用できない環境でも地図表示は継続する
function saveUserLocationVisibility(isVisible) {
  try {
    localStorage.setItem(
      USER_LOCATION_VISIBILITY_STORAGE_KEY,
      isVisible ? "true" : "false",
    );
  } catch (error) {
    console.warn("Failed to save user location visibility:", error);
  }
}

// 通常マップの図形レイヤー表示状態を復元する。保存値がない場合は従来どおり表示する
function getInitialShapeLayerVisibility() {
  try {
    const savedVisibility = localStorage.getItem(
      SHAPE_LAYER_VISIBILITY_STORAGE_KEY,
    );
    if (savedVisibility === "false") {
      return false;
    }
    if (savedVisibility === "true") {
      return true;
    }
  } catch (error) {
    console.warn("Failed to restore shape layer visibility:", error);
  }

  return true;
}

// 図形レイヤーの表示状態を保存する。localStorageが利用できない環境でも地図表示は継続する
function saveShapeLayerVisibility(isVisible) {
  try {
    localStorage.setItem(
      SHAPE_LAYER_VISIBILITY_STORAGE_KEY,
      isVisible ? "true" : "false",
    );
  } catch (error) {
    console.warn("Failed to save shape layer visibility:", error);
  }
}

// モバイルマップの操作 UI 表示状態を復元する。保存値がない場合は従来どおり表示する
function getInitialMapMobileUiHidden() {
  try {
    const savedHidden = localStorage.getItem(MAP_MOBILE_UI_HIDDEN_STORAGE_KEY);
    if (savedHidden === "true") {
      return true;
    }
    if (savedHidden === "false") {
      return false;
    }
  } catch (error) {
    console.warn("Failed to restore mobile map UI visibility:", error);
  }

  return false;
}

// モバイルマップの操作 UI 表示状態を保存する。localStorageが利用できない環境でも地図表示は継続する
function saveMapMobileUiHidden(isHidden) {
  try {
    localStorage.setItem(
      MAP_MOBILE_UI_HIDDEN_STORAGE_KEY,
      isHidden ? "true" : "false",
    );
  } catch (error) {
    console.warn("Failed to save mobile map UI visibility:", error);
  }
}

function handleTileChange(event) {
  // 選択されたタイル情報を取得
  const selectedTileServerId = event.target.value;
  const selectedTile = tileServers[selectedTileServerId];
  if (!selectedTile) {
    return;
  }

  // 現在のレイヤーを削除
  map.removeLayer(tileLayer);

  // タイルサーバーのフラグに基づいてsetMaxBoundsを設定または解除
  if (selectedTile && selectedTile.include_foreign_tiles) {
    map.setMaxBounds(null); // 制限を解除
  } else {
    map.setMaxBounds(bounds); // 制限を設定
  }

  // 新しいタイルレイヤーを設定
  tileLayer = L.tileLayer(selectedTile.url, {
    minZoom: selectedTile.min_zoom ?? 5,
    maxZoom: selectedTile.max_zoom ?? 18,
    attribution: selectedTile.attribution,
  }).addTo(map);

  saveSelectedTileServerId(selectedTileServerId);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openMarkerPopup(markerId) {
  if (markers[`marker-${markerId}`]) {
    // 新しいdivIconの定義
    let newIcon = L.icon({
      iconUrl: "/assets/marker.png", // 新しいアイコンの画像のパス
      iconSize: [25, 41], // アイコンのサイズ
      iconAnchor: [12, 41], // アイコンのアンカーポイント
      popupAnchor: [1, -34], // ポップアップのアンカーポイント
      shadowUrl: null,
    });
    // アイコンの変更
    markers[`marker-${markerId}`].setIcon(newIcon);
    markers[`marker-${markerId}`].openPopup();
  }
}

// 現在地の継続監視と「現在位置へ移動」コントロールを初期化する
function initializeUserLocation(map, options = {}) {
  if (!navigator.geolocation || map._userLocationInitialized) {
    return null;
  }

  map._userLocationInitialized = true;

  // 現在地の監視とマーカーの表示を管理するための変数
  const userLocationLayer = L.layerGroup().addTo(map);
  let userLocationMarker = null;
  let userLocationAccuracyCircle = null;
  let userLocationWatchId = null;
  let latestUserLatLng = null;
  let shouldCenterOnNextUserLocationUpdate = false;
  let hasShownUserLocationError = false;
  let shouldNotifyUserLocationError = false;

  // 現在地を示すマーカーを作成する関数
  function createUserLocationMarker(latLng) {
    return L.circleMarker(latLng, {
      radius: 8,
      fillColor: "#1a73e8",
      fillOpacity: 1,
      color: "#ffffff",
      weight: 3,
    }).addTo(userLocationLayer);
  }

  // ユーザー位置の精度円を作成する関数
  function createUserLocationAccuracyCircle(latLng, accuracy) {
    return L.circle(latLng, {
      radius: accuracy,
      fillColor: "#1a73e8",
      fillOpacity: 0.15,
      color: "#1a73e8",
      weight: 1,
      opacity: 0.25,
      interactive: false,
    }).addTo(userLocationLayer);
  }

  // 取得した現在地を地図上へ反映する
  function renderUserLocation(position) {
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    const latLng = new L.LatLng(latitude, longitude);
    const accuracy = position.coords.accuracy ?? 0;

    // 最新の現在地を保持して、ボタン押下時の再センタリングに使用
    latestUserLatLng = latLng;
    hasShownUserLocationError = false;
    shouldNotifyUserLocationError = false;

    // 常時表示用の現在地ドットは1つだけ生成し、以降は座標だけ更新する
    if (!userLocationMarker) {
      userLocationMarker = createUserLocationMarker(latLng);
    } else {
      userLocationMarker.setLatLng(latLng);
    }

    // Googleマップ風に精度範囲も淡い青円で追従させる
    if (!userLocationAccuracyCircle) {
      userLocationAccuracyCircle = createUserLocationAccuracyCircle(
        latLng,
        accuracy,
      );
    } else {
      userLocationAccuracyCircle.setLatLng(latLng);
      userLocationAccuracyCircle.setRadius(accuracy);
    }

    if (shouldCenterOnNextUserLocationUpdate) {
      map.setView(latLng, Math.max(map.getZoom(), 16));
      shouldCenterOnNextUserLocationUpdate = false;
    }
  }

  // 現在地取得エラー時の表示とログ出力を行う
  function handleUserLocationError(error) {
    if (shouldNotifyUserLocationError && hasShownUserLocationError) {
      return;
    }

    shouldCenterOnNextUserLocationUpdate = false;
    if (shouldNotifyUserLocationError) {
      hasShownUserLocationError = true;
      window.alert("位置情報の取得に失敗しました");
    }
    console.error("Get location error", error);
  }

  // 現在地の継続監視を開始
  function startUserLocationWatch() {
    // 監視は重複開始しない
    if (userLocationWatchId !== null) {
      return;
    }

    userLocationWatchId = navigator.geolocation.watchPosition(
      renderUserLocation,
      handleUserLocationError,
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      },
    );
  }

  // 現在地を手動で取得する関数
  function geoFindMe() {
    shouldNotifyUserLocationError = true;
    shouldCenterOnNextUserLocationUpdate = true;

    if (latestUserLatLng) {
      map.setView(latestUserLatLng, Math.max(map.getZoom(), 16));
      shouldCenterOnNextUserLocationUpdate = false;
      shouldNotifyUserLocationError = false;
      return;
    }
    startUserLocationWatch();
  }

  // 現在位置の取得ボタン
  const UserLocationControl = L.Control.extend({
    options: {
      position: options.position ?? "topright",
    },
    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      if (options.controlClassName) {
        container.classList.add(options.controlClassName);
      }
      const button = L.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.innerHTML = "現在位置";

      // ボタンのクリックイベント
      L.DomEvent.on(button, "click", function (event) {
        L.DomEvent.stop(event);
        geoFindMe();
      });

      L.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  map.addControl(new UserLocationControl());
  startUserLocationWatch();

  window.addEventListener("beforeunload", function () {
    if (userLocationWatchId !== null) {
      navigator.geolocation.clearWatch(userLocationWatchId);
      userLocationWatchId = null;
    }
  });

  return userLocationLayer;
}

// レイヤに設定されたアイコンをLeafletのオプションへ変換する。
function markerOptionsForLayer(layerId, layerRecords, extraOptions = {}) {
  const layerRecord = layerRecords && layerId ? layerRecords[layerId] : null;
  const filename = layerRecord?.marker_icon_filename;
  if (!filename) {
    return { ...extraOptions };
  }
  return {
    ...extraOptions,
    icon: L.icon({
      iconUrl: `/static/marker-icons/${encodeURIComponent(filename)}`,
      iconSize: [30, 30],
      iconAnchor: [20, 40],
      popupAnchor: [0, -40],
      tooltipAnchor: [0, -20],
    }),
  };
}

// カスタムアイコンを読み込めない場合、Leafletの標準アイコンへ切り替える。
function enableMarkerIconFallback(marker, layerId, layerRecords) {
  const layerRecord = layerRecords && layerId ? layerRecords[layerId] : null;
  if (!layerRecord?.marker_icon_filename) {
    return marker;
  }

  let fallbackApplied = false;
  const bindFallback = () => {
    if (fallbackApplied) {
      return;
    }

    const iconElement = marker.getElement();
    if (
      !iconElement ||
      iconElement.dataset.markerIconFallbackBound === "true"
    ) {
      return;
    }

    iconElement.dataset.markerIconFallbackBound = "true";
    iconElement.addEventListener(
      "error",
      () => {
        if (fallbackApplied) {
          return;
        }
        fallbackApplied = true;
        marker.setIcon(new L.Icon.Default());
      },
      { once: true },
    );
  };

  marker.on("add", bindFallback);
  bindFallback();
  return marker;
}



function resolveSameOriginContentUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const previewImage = target.closest("img.marker-preview-image");
  if (previewImage) {
    const parsed = resolveSameOriginContentUrl(previewImage.getAttribute("data-preview-src"));
    if (!parsed || !/^\/(?:static\/images|images\/html)\//.test(parsed.pathname)) return;
    const previewPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (typeof callParentImagePreview === "function") {
      callParentImagePreview(previewPath);
    } else if (typeof callParent === "function") {
      callParent(previewPath);
    }
    return;
  }

  const downloadLink = target.closest("a.markdown-download-link");
  if (downloadLink) {
    event.preventDefault();
    const parsed = resolveSameOriginContentUrl(downloadLink.getAttribute("data-download-href"));
    if (!parsed || typeof downloadFile !== "function") return;
    downloadFile(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  }
});
