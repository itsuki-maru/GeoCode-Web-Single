function filterMeasurementMarkersForBounds(markers, bounds) {
  if (!Array.isArray(markers)) {
    return [];
  }
  if (!bounds || typeof bounds.contains !== "function") {
    return markers;
  }
  return markers.filter((marker) => {
    const latLng = marker?.getLatLng?.();
    return !latLng || bounds.contains(latLng);
  });
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

function matchesShapeSearch(record, query) {
  const normalizedQuery = normalizeMarkerSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const searchableText = [record?.name, record?.geojson?.properties?.memo]
    .map(normalizeMarkerSearchText)
    .join(" ");

  return searchableText.includes(normalizedQuery);
}

function getShapeRecords(shapeRecords) {
  if (Array.isArray(shapeRecords)) {
    return shapeRecords;
  }
  if (shapeRecords && typeof shapeRecords === "object") {
    return Object.values(shapeRecords);
  }
  return [];
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

// 検索条件に一致する図形と、その図形に付随するラベルだけをレイヤ別グループへ戻す
function createLayeredShapeDisplayManager({
  map,
  shapeRecords,
  shapeLayers,
  shapeGroups,
  isLayerVisible,
  onRebuild = null,
}) {
  let searchQuery = "";

  const rebuildVisibleShapes = () => {
    if (!shapeLayers || !shapeGroups || typeof isLayerVisible !== "function") {
      return;
    }

    Object.values(shapeGroups).forEach((group) => group.clearLayers());

    getShapeRecords(shapeRecords).forEach((record) => {
      const layerId = record?.layer_id;
      const shapeLayer = shapeLayers[`shape-${record?.id}`];
      const targetGroup = shapeGroups[layerId];
      if (
        !shapeLayer ||
        !targetGroup ||
        !isLayerVisible(layerId) ||
        !matchesShapeSearch(record, searchQuery)
      ) {
        return;
      }

      targetGroup.addLayer(shapeLayer);
      if (Array.isArray(shapeLayer.measurementMarkers)) {
        shapeLayer.measurementMarkers.forEach((marker) => {
          targetGroup.addLayer(marker);
        });
      }
    });

    if (map && typeof map.closePopup === "function") {
      map.closePopup();
    }
    if (typeof onRebuild === "function") {
      onRebuild();
    }
  };

  const setSearchQuery = (query) => {
    searchQuery = normalizeMarkerSearchText(query) ? query : "";
    rebuildVisibleShapes();
  };

  const clearSearch = () => {
    searchQuery = "";
    rebuildVisibleShapes();
  };

  return {
    clearSearch,
    rebuildVisibleShapes,
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
            <input type="text" class="search-input marker-search-input" id="${inputId}" placeholder="マーカー・図形検索" title="マーカー名・詳細・座標、図形名・メモを検索します。">
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
            <input type="text" class="search-input marker-search-input" id="${inputId}" placeholder="マーカー・図形検索" title="マーカー名・詳細・座標、図形名・メモを検索します。">
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

