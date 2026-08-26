function createMarkerGroupForLayer(layerId) {
  if (!layerId) {
    return null;
  }

  if (!clusterGroups[layerId]) {
    clusterGroups[layerId] = L.featureGroup();
  }
  if (!layerVisibilityGroups[layerId]) {
    layerVisibilityGroups[layerId] = L.layerGroup();
  }

  return clusterGroups[layerId];
}

// データごとにクラスターグループを作成
for (const key in markersFromAxum) {
  const markerData = markersFromAxum[key];
  // layer_id ごとに markerClusterGroup を作成する
  createMarkerGroupForLayer(markerData["layer_id"]);

  // マーカーを作成してクラスターグループに追加する
  const marker = L.marker(
    [markerData["latitude"], markerData["longitude"]],
    markerOptionsForLayer(markerData["layer_id"], layersFromAxum),
  ).bindPopup(escapeHtml(markerData["marker_name"]));

  // ポップアップオープン時に遅延読み込みの処理を追加
  marker.on("popupopen", () => {
    setupDetailsLazyImages(document);
  });

  clusterGroups[markerData["layer_id"]].addLayer(marker);

  if (!markerData["marker_name"]) {
    marker.bindTooltip(`<div class="custom-tooltip">No Name</div>`, {
      permanent: false,
    });
  } else {
    marker.bindTooltip(
      `<div class="custom-tooltip">${escapeHtml(markerData["marker_name"])}</div>`,
      { permanent: false },
    );
  }
  if (markerData["detail"]) {
    const mdText = `# ${markerData["marker_name"]}\n\n${markerData["detail"]}`;
    const mdToHtml = marked.parse(mdText);
    const cleanHtml = filterXSS(mdToHtml, xssOptions);
    const renderHtml = renderIframe(cleanHtml);
    const bindMDToHtml = `<div class="md-detail-contents">${renderHtml}</div>`;
    marker.bindPopup(bindMDToHtml);
  }
  // マーカーのHTML要素を取得し、id属性を設定
  let markerIcon = marker.getElement();
  if (markerIcon) {
    markerIcon.id = `marker-${markerData["id"]}`;
  }
  markers[`marker-${markerData["id"]}`] = marker;
}

if (Array.isArray(shapesFromAxum)) {
  shapesFromAxum.forEach((shape) => {
    createMarkerGroupForLayer(shape.layer_id);
  });
}

// すべてのクラスターグループ及びマーカーグループを地図に追加する 初期値でチェックとする場合はコメントアウトを解除
//Object.values(clusterGroups).forEach(group => group.addTo(map));

// L.control.layers にクラスターグループを追加する
const layersControl = L.control.layers(null, null, { collapsed: false });

// 表示切替用の空レイヤをレイヤーコントロールに追加する
const layerControlOverlayLayers = [];
for (const layer_id in clusterGroups) {
  const layerName = escapeHtml(layerNames[layer_id]);
  layersControl.addOverlay(layerVisibilityGroups[layer_id], layerName);
  layerControlOverlayLayers.push(layerVisibilityGroups[layer_id]);
}

layersControl.addTo(map);
// チェック状態に応じて単一の表示用グループへマーカーを集約する
const layeredMarkerDisplay = createLayeredMarkerDisplayManager({
  map,
  markerRecords: markersFromAxum,
  markers,
  visibleMarkerGroup,
  layerVisibilityGroups,
});
layeredMarkerDisplay.rebuildVisibleMarkers();
map.addControl(
  createLayerBulkToggleControl({
    map,
    overlayLayers: layerControlOverlayLayers,
  }),
);

// HTMLエスケープを行う関数
// ラベルやポップアップ表示用に HTML をエスケープする
// 図形名を表示しやすい形に正規化する関数
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// GeoJSON に保存された円の半径を取り出す
// レイヤ単位の図形グループを必要に応じて生成する
function ensureShapeGroup(layerId) {
  if (!layerId) {
    return null;
  }

  if (!shapeGroups[layerId]) {
    shapeGroups[layerId] = L.featureGroup();
  }

  return shapeGroups[layerId];
}

// 図形を全体管理グループとレイヤ別グループへ登録する
function addShapeLayerToManagedGroups(layer, layerId) {
  if (!layer) {
    return;
  }

  drawnShapesGroup.addLayer(layer);
  const targetShapeGroup = ensureShapeGroup(layerId);
  if (targetShapeGroup) {
    targetShapeGroup.addLayer(layer);
  }
}

// マーカーグループから対応するレイヤ ID を逆引きする
function findLayerIdByMarkerGroup(targetGroup) {
  return layeredMarkerDisplay.findLayerIdByVisibilityGroup(targetGroup);
}

// 指定レイヤのチェック状態に合わせて図形表示を同期する
function syncShapeGroupVisibility(layerId) {
  if (!layerId || !shapeGroups[layerId]) {
    return;
  }

  if (
    map.hasLayer(shapeVisibilityLayer) &&
    layeredMarkerDisplay.isLayerVisible(layerId)
  ) {
    if (!map.hasLayer(shapeGroups[layerId])) {
      shapeGroups[layerId].addTo(map);
    }

    shapeGroups[layerId].eachLayer((layer) => {
      if (layer?.isMeasurementLabel === true) {
        setMeasurementMarkerVisibility(layer, isMeasurementVisible);
      }
      if (typeof layer.openTooltip === "function") {
        layer.openTooltip();
      }
    });
    return;
  }

  if (map.hasLayer(shapeGroups[layerId])) {
    map.removeLayer(shapeGroups[layerId]);
  }
}

// 全レイヤ分の図形表示を現在のチェック状態へ同期する
function syncAllShapeGroupsVisibility() {
  Object.keys(shapeGroups).forEach((layerId) => {
    syncShapeGroupVisibility(layerId);
  });
  shapeMeasurementManager?.scheduleRefresh();
}

// 図形のスタイル適用
function applyShapeStyle(layer) {
  if (!layer || typeof layer.setStyle !== "function") {
    return;
  }

  const nextStyle = {
    ...(layer.shapeStyle || getDefaultShapeStyle(layer.shapeType)),
  };
  layer.setStyle(nextStyle);
}

// 図形の座標を平坦化
function flattenShapeLatLngs(latLngs) {
  if (!Array.isArray(latLngs)) {
    return [];
  }

  if (latLngs.length === 0) {
    return [];
  }

  if (Array.isArray(latLngs[0])) {
    return flattenShapeLatLngs(latLngs[0]);
  }

  return latLngs;
}

// ポリラインの中心座標を取得
// 図形ラベルを配置する中心座標を求める
function getShapeLabelLatLng(layer) {
  if (!layer) {
    return null;
  }

  if (layer.shapeType === "polyline") {
    return getPolylineCenterLatLng(layer);
  }

  if (layer.shapeType === "circle" && typeof layer.getLatLng === "function") {
    return layer.getLatLng();
  }

  if (typeof layer.getBounds === "function") {
    return layer.getBounds().getCenter();
  }

  return null;
}

// 距離をメートル/キロメートル表記へ整形する
// 面積を平方メートル/平方キロメートル表記へ整形する
// 閉じたリングの終点重複を除去する
// ポリラインの各区間距離と総延長を計算する
// ポリゴン面積を EPSG:3857 の平面近似で求める
// ポリゴン/短形の各辺距離・周長・面積を計算する
function measurePolygon(layer) {
  const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer?.getLatLngs?.()));
  const edges = [];
  let perimeter = 0;

  for (let i = 0; i < latLngs.length; i += 1) {
    const start = latLngs[i];
    const end = latLngs[(i + 1) % latLngs.length];
    const distance = map.distance(start, end);
    edges.push({
      label: `${i + 1}`,
      distance,
    });
    perimeter += distance;
  }

  return {
    edges,
    perimeter,
    area: calculateProjectedPolygonArea(latLngs),
  };
}

// 円の半径と面積を計算する
// 線分の中点を求める
// 計測表示用に図形の頂点一覧を取得する
// 図形の頂点を示す丸マーカーを置く
// 複数線分の距離上の中央位置を求める
// 隣接線分をまとめた計測ラベルを作る
// 結合表示時に各結合区間の両端だけを示す丸マーカーを作る
// 計測ラベルの HTML を組み立てる
// 指定位置に計測ラベルマーカーを置く
// 図形ごとの計測ラベル一覧を生成する
function createShapeMeasurementMarkers(layer) {
  if (!layer) {
    return [];
  }

  const markers = [];
  let measurementSegments = [];

  if (layer.shapeType === "polyline") {
    const latLngs = flattenShapeLatLngs(layer.getLatLngs());
    const measurement = measurePolyline(layer);
    const segments = measurement.segments
      .map((segment, index) => ({
        ...segment,
        start: latLngs[index],
        end: latLngs[index + 1],
      }))
      .filter((segment) => segment.start && segment.end);
    measurementSegments = segments;

    if (isMeasurementSegmentMerged) {
      markers.push(...createGroupedSegmentMeasurementMarkers(segments));
    } else {
      segments.forEach((segment) => {
        markers.push(
          createMeasurementLabelMarker(
            getSegmentMidpoint(segment.start, segment.end),
            [formatDistance(segment.distance)],
          ),
        );
      });
    }

    const summaryLatLng = getShapeLabelLatLng(layer);
    if (summaryLatLng) {
      markers.push(
        createMeasurementLabelMarker(
          summaryLatLng,
          [`総延長 ${formatDistance(measurement.totalDistance)}`],
          "summary-polyline",
        ),
      );
    }
  } else if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
    const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer.getLatLngs()));
    const measurement = measurePolygon(layer);
    const segments = measurement.edges
      .map((edge, index) => ({
        ...edge,
        start: latLngs[index],
        end: latLngs[(index + 1) % latLngs.length],
      }))
      .filter((segment) => segment.start && segment.end);
    measurementSegments = segments;

    if (isMeasurementSegmentMerged) {
      markers.push(...createGroupedSegmentMeasurementMarkers(segments));
    } else {
      segments.forEach((segment) => {
        markers.push(
          createMeasurementLabelMarker(
            getSegmentMidpoint(segment.start, segment.end),
            [formatDistance(segment.distance)],
          ),
        );
      });
    }

    const summaryLatLng = getShapeLabelLatLng(layer);
    if (summaryLatLng) {
      const summaryVariant =
        layer.shapeType === "rectangle" ? "summary-rectangle" : "summary";
      markers.push(
        createMeasurementLabelMarker(
          summaryLatLng,
          [`面積 ${formatArea(measurement.area)}`],
          summaryVariant,
        ),
      );
    }
  } else if (layer.shapeType === "circle") {
    const measurement = measureCircle(layer);
    const centerLatLng = getShapeLabelLatLng(layer);
    if (centerLatLng) {
      markers.push(
        createMeasurementLabelMarker(
          centerLatLng,
          [
            `半径 ${formatDistance(measurement.radius)}`,
            `面積 ${formatArea(measurement.area)}`,
          ],
          "summary-circle",
        ),
      );
    }
  }

  if (isMeasurementSegmentMerged) {
    markers.push(
      ...createGroupedSegmentEndpointMarkers(measurementSegments, layer),
    );
  } else {
    getMeasurementVertexLatLngs(layer).forEach((latLng) => {
      markers.push(createMeasurementVertexMarker(latLng, layer));
    });
  }

  return markers.filter(Boolean);
}

// 計測ラベルを図形と同じレイヤグループへ登録する
function attachShapeMeasurementMarkers(layer, layerId, bounds = null) {
  if (!layer) {
    return;
  }

  const markers = filterMeasurementMarkersForBounds(
    createShapeMeasurementMarkers(layer),
    bounds,
  );
  layer.measurementMarkers = markers;
  layer.measurementLayerId = layerId;
  if (markers.length === 0) {
    return;
  }

  const targetShapeGroup = ensureShapeGroup(layerId);
  if (targetShapeGroup) {
    markers.forEach((marker) => {
      targetShapeGroup.addLayer(marker);
      setMeasurementMarkerVisibility(marker, isMeasurementVisible);
    });
  }
}

// 計測ラベルを図形グループから取り除く
function removeShapeMeasurementMarkers(layer) {
  if (!layer || !Array.isArray(layer.measurementMarkers)) {
    return;
  }

  const targetShapeGroup = ensureShapeGroup(layer.measurementLayerId);
  layer.measurementMarkers.forEach((marker) => {
    if (targetShapeGroup) {
      targetShapeGroup.removeLayer(marker);
    }
  });
  layer.measurementMarkers = [];
}

// 辺結合の切り替えに合わせて図形の計測ラベルを再生成する
function refreshShapeMeasurementMarkers(layer) {
  if (!layer || !layer.shapeType || layer.isMeasurementLabel === true) {
    return;
  }

  const layerId = layer.measurementLayerId;
  removeShapeMeasurementMarkers(layer);
  if (layerId) {
    shapeMeasurementManager?.scheduleRefresh();
  }
}

// すべての図形計測ラベルをまとめて再生成する
function refreshAllShapeMeasurementMarkers() {
  shapeMeasurementManager?.scheduleRefresh();
}

// 計測ラベルマーカーの表示状態を反映する
// 指定レイヤ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToShapeGroup(layerId) {
  if (!layerId || !shapeGroups[layerId]) {
    return;
  }

  shapeGroups[layerId].eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      setMeasurementMarkerVisibility(layer, isMeasurementVisible);
    }
  });
}

// すべての計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToAllShapeGroups() {
  Object.keys(shapeGroups).forEach((layerId) => {
    applyMeasurementVisibilityToShapeGroup(layerId);
  });
}

// 図形名の保持データを更新し、表示判定をやり直す
function updateShapeNameLabel(layer, name) {
  if (!layer) {
    return;
  }

  const normalizedName = normalizeShapeName(name);
  layer.shapeName = normalizedName;
  layer.isShapeNameLayer = true;

  if (shapeNameLabelManager) {
    shapeNameLabelManager.invalidate(layer);
  } else if (typeof layer.unbindTooltip === "function") {
    layer.unbindTooltip();
  }
}

// 表示範囲内と判定された名前付き図形にだけ Tooltip を生成する
function bindShapeNameLabelTooltip(layer, labelLatLng) {
  if (typeof layer.bindTooltip !== "function") {
    return;
  }

  const normalizedName = normalizeShapeName(layer.shapeName);
  const labelClassName = normalizedName
    ? "shape-name-label"
    : "shape-name-label is-empty";
  const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
  const labelColor = normalizeShapeColor(
    layer.shapeStyle ? layer.shapeStyle.color : null,
    SHAPE_STYLE.color,
  );
  layer.bindTooltip(
    `<div class="${labelClassName}" style="background:rgba(255,255,255,0.92);border:1px solid ${labelColor};border-radius:999px;color:${labelColor};display:inline-block;padding:2px 8px;">${labelContent}</div>`,
    {
      interactive: true,
      permanent: true,
      direction: "center",
      className: "shape-name-tooltip",
    },
  );

  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  if (typeof layer.openTooltip === "function") {
    layer.openTooltip();
  }
  const applyTooltipBorderColor = () => {
    const tooltipElement =
      tooltip && typeof tooltip.getElement === "function"
        ? tooltip.getElement()
        : null;
    if (!tooltipElement) {
      return;
    }
    tooltipElement.style.setProperty("background", "transparent", "important");
    tooltipElement.style.setProperty("border", "none", "important");
    tooltipElement.style.setProperty("box-shadow", "none", "important");
    tooltipElement.style.setProperty("padding", "0", "important");
    tooltipElement.style.setProperty("color", labelColor, "important");
  };
  applyTooltipBorderColor();
  setTimeout(() => {
    attachShapeMemoTooltipOpen(layer, labelLatLng);
    applyTooltipBorderColor();
  }, 0);
}

// 形状タイプと GeoJSON から Leaflet レイヤを生成する
// GeoJSON から描画用の図形レイヤを生成する
function createShapeLayer(shapeType, geojson, shapeName = "") {
  const shapeStyle = getShapeStyleFromGeoJson(shapeType, geojson);
  const layer = createLeafletShapeLayer(shapeType, geojson, shapeStyle);
  if (!layer) {
    return null;
  }

  layer.shapeType = shapeType;
  layer.shapeStyle = shapeStyle;
  layer.shapeMemo = getShapeMemoFromGeoJson(geojson);
  applyShapeStyle(layer);
  updateShapeNameLabel(layer, shapeName);
  attachShapeMemoPopup(layer);
  bindPolylineHoverHighlight(layer, {
    restoreStyle: () => applyShapeStyle(layer),
  });
  return layer;
}

// サーバーから渡された図形一覧を地図へ復元する
function restoreSavedShapes() {
  if (!Array.isArray(shapesFromAxum)) {
    return;
  }

  shapesFromAxum.forEach((shape) => {
    const shapeStyle = getShapeStyleFromGeoJson(
      shape.shape_type,
      shape.geojson,
    );
    const layer = createLeafletShapeLayer(
      shape.shape_type,
      shape.geojson,
      shapeStyle,
    );
    if (!layer) {
      return;
    }

    layer.shapeId = shape.id;
    layer.layerId = shape.layer_id || null;
    layer.shapeType = shape.shape_type;
    layer.shapeName = shape.name || "";
    layer.shapeStyle = shapeStyle;
    layer.shapeMemo = getShapeMemoFromGeoJson(shape.geojson);
    shapeLayers[`shape-${shape.id}`] = layer;
    applyShapeStyle(layer);
    updateShapeNameLabel(layer, shape.name || "");
    attachShapeMemoPopup(layer);
    bindPolylineHoverHighlight(layer, {
      restoreStyle: () => applyShapeStyle(layer),
    });
    addShapeLayerToManagedGroups(layer, shape.layer_id);
  });

  syncAllShapeGroupsVisibility();
}

restoreSavedShapes();
shapeNameLabelManager = createViewportShapeLabelManager({
  map,
  getLayers: () => Object.values(shapeLayers),
  getLabelLatLng: (layer) => getShapeLabelLatLng(layer),
  bindLabel: bindShapeNameLabelTooltip,
  shouldBind: (layer) => Boolean(normalizeShapeName(layer.shapeName)),
  enabled: map.hasLayer(shapeNameVisibilityLayer),
});
shapeNameLabelManager.refresh();
shapeMeasurementManager = createViewportShapeMeasurementManager({
  map,
  getLayers: () => Object.values(shapeLayers),
  attachMarkers: (layer, bounds) =>
    attachShapeMeasurementMarkers(layer, layer.layerId, bounds),
  removeMarkers: removeShapeMeasurementMarkers,
});
const layeredShapeDisplay = createLayeredShapeDisplayManager({
  map,
  shapeRecords: shapesFromAxum,
  shapeLayers,
  shapeGroups,
  isLayerVisible: layeredMarkerDisplay.isLayerVisible,
  onRebuild: () => shapeNameLabelManager.scheduleRefresh(),
});
