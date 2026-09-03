// @ts-nocheck -- Leaflet編集画面の共有スコープを保ったまま移行する統合境界。
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

// 折れ線ラベル用の代表位置を算出する
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
// ポリゴン/短形の各辺距離と面積を計算する
function measurePolygon(layer) {
  const latLngs = trimClosedLatLngs(flattenShapeLatLngs(layer?.getLatLngs?.()));
  const edges = [];

  for (let i = 0; i < latLngs.length; i += 1) {
    const start = latLngs[i];
    const end = latLngs[(i + 1) % latLngs.length];
    edges.push({
      label: `${i + 1}`,
      distance: map.distance(start, end),
    });
  }

  return {
    edges,
    area: calculateProjectedPolygonArea(latLngs),
  };
}

// 円の半径と面積を計算する
// 線分の中点を求める
// 計測表示用に図形の頂点一覧を取得する
// 図形の頂点を示す丸マーカーを置く
// 複数線分の距離上の中央位置を求める
// 混雑時に隣接線分をまとめた計測ラベルを作る
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

// 計測ラベルを図形グループへ登録する
function attachShapeMeasurementMarkers(layer, bounds = null) {
  if (!layer) {
    return;
  }

  const markers = filterMeasurementMarkersForBounds(
    createShapeMeasurementMarkers(layer),
    bounds,
  );
  layer.measurementMarkers = markers;
  if (markers.length === 0) {
    return;
  }

  markers.forEach((marker) => {
    if (mapEditorProfile.isShapeVisibleForMeasurement(layer)) {
      drawnShapesGroup.addLayer(marker);
    }
    setMeasurementMarkerVisibility(marker, isMeasurementVisible);
  });
}

// 計測ラベルを図形グループから取り除く
function removeShapeMeasurementMarkers(layer) {
  if (!layer || !Array.isArray(layer.measurementMarkers)) {
    return;
  }

  layer.measurementMarkers.forEach((marker) => {
    drawnShapesGroup.removeLayer(marker);
  });
  layer.measurementMarkers = [];
}

// 画面上の辺長に応じて図形の計測ラベルを再生成する
function refreshShapeMeasurementMarkers(layer) {
  if (!layer || !layer.shapeType || layer.isMeasurementLabel === true) {
    return;
  }

  removeShapeMeasurementMarkers(layer);
  shapeMeasurementManager?.scheduleRefresh();
}

// 表示中の図形計測ラベルをまとめて再生成する
function refreshAllShapeMeasurementMarkers() {
  shapeMeasurementManager?.scheduleRefresh();
}

// 計測ラベルマーカーの表示状態を反映する
// 描画図形グループ内の計測ラベルへ現在の表示状態を反映する
function applyMeasurementVisibilityToDrawnShapesGroup() {
  drawnShapesGroup.eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      setMeasurementMarkerVisibility(layer, isMeasurementVisible);
    }
  });
}

// 図形ラベルへ現在の図形色を反映する
function applyShapeLabelStyle(layer) {
  const tooltip =
    typeof layer?.getTooltip === "function" ? layer.getTooltip() : null;
  const tooltipElement =
    tooltip && typeof tooltip.getElement === "function"
      ? tooltip.getElement()
      : null;
  if (!tooltipElement) {
    return;
  }

  const shapeColor = normalizeShapeColor(
    layer?.shapeStyle?.color,
    SHAPE_STYLE.color,
  );
  tooltipElement.style.borderColor = shapeColor;
  tooltipElement.style.color = shapeColor;
}

// 図形ラベルクリックで名前編集を開けるようイベントを付与する
function attachShapeNameTooltipClick(layer) {
  if (!layer) {
    return;
  }
  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  const tooltipElement =
    tooltip && typeof tooltip.getElement === "function"
      ? tooltip.getElement()
      : null;
  if (
    !tooltipElement ||
    tooltipElement.dataset.shapeNameClickBound === "true"
  ) {
    return;
  }

  tooltipElement.dataset.shapeNameClickBound = "true";
  const openEditorFromLabel = (event) => {
    L.DomEvent.stop(event);
    if (activeDrawMode || mapEditorProfile.shouldSuppressShapeLabelClick()) {
      return;
    }
    if (currentMapMode === "edit") {
      selectShapeForGeometryEdit(layer);
      return;
    }
    openShapeNameEditor(layer);
  };
  L.DomEvent.on(tooltipElement, "click", openEditorFromLabel);
  L.DomEvent.on(tooltipElement, "touchend", openEditorFromLabel);
}

// 図形名ラベルの保持データを同期し、表示判定をやり直す
function updateShapeNameLabel(layer, name) {
  if (!layer) {
    return;
  }

  const normalizedName = normalizeShapeName(name);
  layer.shapeName = normalizedName;
  layer.isShapeNameLayer = true;
  if (!layer.options) {
    layer.options = {};
  }
  if (layer.options.shapeRecord) {
    layer.options.shapeRecord.name = normalizedName;
  }

  if (shapeNameLabelManager) {
    shapeNameLabelManager.invalidate(layer);
  } else if (typeof layer.unbindTooltip === "function") {
    layer.unbindTooltip();
  }
}

// 表示範囲内と判定された図形にだけ Tooltip を生成する
function bindShapeNameLabelTooltip(layer, labelLatLng) {
  if (typeof layer.bindTooltip !== "function") {
    return;
  }

  const normalizedName = normalizeShapeName(layer.shapeName);
  const labelClassName = normalizedName
    ? "shape-name-label"
    : "shape-name-label is-empty";
  const labelContent = normalizedName ? escapeHtml(normalizedName) : "&nbsp;";
  layer.bindTooltip(`<div class="${labelClassName}">${labelContent}</div>`, {
    interactive: true,
    permanent: true,
    direction: "center",
    className: "shape-name-tooltip",
  });

  const tooltip =
    typeof layer.getTooltip === "function" ? layer.getTooltip() : null;
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  if (typeof layer.openTooltip === "function") {
    layer.openTooltip();
  }
  applyShapeLabelStyle(layer);

  setTimeout(() => {
    attachShapeNameTooltipClick(layer);
    applyShapeLabelStyle(layer);
  }, 0);
}

// 現在の map 表示対象レイヤ ID を取得する
