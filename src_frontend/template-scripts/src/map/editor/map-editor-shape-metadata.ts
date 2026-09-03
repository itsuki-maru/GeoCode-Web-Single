// @ts-nocheck -- Leaflet編集画面の共有スコープを保つ統合境界。
function getCurrentShapeLayerId() {
  if (typeof layer !== "string") {
    return null;
  }

  const trimmedLayerId = layer.trim();
  if (
    !trimmedLayerId ||
    trimmedLayerId === "null" ||
    trimmedLayerId === "None"
  ) {
    return null;
  }

  return trimmedLayerId;
}

// 図形編集用に選択可能なレイヤ一覧を取得する
function getEditableShapeLayers() {
  return Object.values(layersFromAxum || {})
    .filter(
      (layerRecord) => layerRecord && layerRecord.id && layerRecord.layer_name,
    )
    .sort((left, right) => {
      if (left.is_master && !right.is_master) {
        return -1;
      }
      if (!left.is_master && right.is_master) {
        return 1;
      }
      return left.layer_name.localeCompare(right.layer_name, "ja");
    });
}

// 図形編集ポップアップの既定レイヤを決める
function getShapeEditorLayerId(targetLayer) {
  return (
    targetLayer?.layerId ||
    getCurrentShapeLayerId() ||
    getEditableShapeLayers()[0]?.id ||
    ""
  );
}

// レイヤ選択プルダウンの option 群を組み立てる
function buildShapeLayerOptions(selectedLayerId) {
  return getEditableShapeLayers()
    .map((layerRecord) => {
      const selected = layerRecord.id === selectedLayerId ? "selected" : "";
      const layerLabel = escapeHtml(
        layerRecord.layer_name || "名称未設定レイヤ",
      );
      return `<option value="${layerRecord.id}" ${selected}>${layerLabel}</option>`;
    })
    .join("");
}

function buildShapeLineTypeOptions(selectedLineType) {
  const normalizedLineType = normalizeShapeLineType(selectedLineType);
  return SHAPE_LINE_TYPE_OPTIONS.map((option) => {
    const selected = option.value === normalizedLineType ? "selected" : "";
    return `<option value="${option.value}" ${selected}>${option.label}</option>`;
  }).join("");
}

function buildShapeArrowTypeOptions(selectedArrowType) {
  const normalizedArrowType = normalizeShapeArrowType(selectedArrowType);
  return SHAPE_ARROW_TYPE_OPTIONS.map((option) => {
    const selected = option.value === normalizedArrowType ? "selected" : "";
    return `<option value="${option.value}" ${selected}>${option.label}</option>`;
  }).join("");
}

// 図形レイヤに保存用メタデータをまとめて関連付ける
function applyShapeRecord(layer, shapeRecord) {
  if (!layer) {
    return;
  }

  if (!layer.options) {
    layer.options = {};
  }

  layer.options.shapeRecord = {
    id: shapeRecord.id || null,
    layer_id: shapeRecord.layer_id || null,
    shape_type: shapeRecord.shape_type,
    name: normalizeShapeName(shapeRecord.name || ""),
    geojson: shapeRecord.geojson,
  };
  layer.shapeId = shapeRecord.id || null;
  layer.layerId = shapeRecord.layer_id || null;
  layer.shapeType = shapeRecord.shape_type;
  layer.shapeName = normalizeShapeName(shapeRecord.name || "");
  layer.shapeMemo = getShapeMemoFromGeoJson(shapeRecord.geojson);
  layer.shapeStyle = getShapeStyleFromGeoJson(
    shapeRecord.shape_type,
    shapeRecord.geojson,
  );
  layer.feature = shapeRecord.geojson;
  bindShapeArrowStyle(layer);
  if (shapeRecord.id) {
    searchableShapeLayers.add(layer);
    renderVisibleShapes();
  }
}

function isShapeVisibleForSearch(layer) {
  return Boolean(
    layer &&
      !layer.isDeletedShape &&
      (!externalShapeFilterIdSet ||
        externalShapeFilterIdSet.has(String(layer.shapeId))) &&
      matchesShapeSearch(layer.options?.shapeRecord, localMarkerSearchQuery),
  );
}

function renderVisibleShapes() {
  searchableShapeLayers.forEach((layer) => {
    const isVisible = editorEntryProfile.isMobile
      ? isShapeVisibleForSearch(layer)
      : isShapeVisibleForExternalFilter(layer);
    if (isVisible) {
      if (!drawnShapesGroup.hasLayer(layer)) {
        drawnShapesGroup.addLayer(layer);
      }
      if (Array.isArray(layer.measurementMarkers)) {
        layer.measurementMarkers.forEach((marker) => {
          if (!drawnShapesGroup.hasLayer(marker)) {
            drawnShapesGroup.addLayer(marker);
          }
          setMeasurementMarkerVisibility(marker, isMeasurementVisible);
        });
      }
      return;
    }

    drawnShapesGroup.removeLayer(layer);
    if (Array.isArray(layer.measurementMarkers)) {
      layer.measurementMarkers.forEach((marker) => {
        drawnShapesGroup.removeLayer(marker);
      });
    }
  });

  if (map && typeof map.closePopup === "function") {
    map.closePopup();
  }
  shapeNameLabelManager?.scheduleRefresh();
  shapeMeasurementManager?.scheduleRefresh();
}

// 図形名と所属レイヤの変更をバックエンドへ保存する
async function persistShapeMetadata(
  layer,
  nextName,
  nextLayerId,
  nextGeoJson,
  nextShapeType = null,
) {
  if (!layer?.shapeId) {
    throw new Error("shape update target missing");
  }

  const response = await fetchWithAuth(`/shape/${layer.shapeId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: nextName,
      layer_id: nextLayerId,
      shape_type: nextShapeType,
      geojson: nextGeoJson,
    }),
  });

  if (!response.ok) {
    throw new Error("shape update failed");
  }
}

// 指定図形のラベル位置に名前編集ポップアップを開く
function openShapeNameEditor(layer) {
  if (!layer || activeDrawMode || currentMapMode === "edit") {
    return;
  }

  const labelLatLng = getShapeLabelLatLng(layer);
  if (!labelLatLng) {
    return;
  }

  closeShapeNameEditor();
  editingShapeLayer = layer;
  const selectedLayerId = getShapeEditorLayerId(layer);
  const selectedLineType = getShapeLineTypeFromDashArray(
    layer.shapeStyle?.dashArray,
  );
  const selectedArrowType = normalizeShapeArrowType(
    layer.shapeStyle?.arrowType,
  );
  const selectedWeight = normalizeShapeWeight(layer.shapeStyle?.weight);

  // 図形の編集ポップアップ（カラーピッカーはブラウザ標準のカラーピッカーを呼び出して使用）
  const editorPopup = L.popup({
    autoClose: false,
    closeButton: false,
    closeOnClick: false,
    className: "shape-name-editor-popup",
    offset: [0, -6],
  })
    .setLatLng(labelLatLng)
    .setContent(
      `
            <div class="shape-name-editor">
                <div class="shape-name-editor-title">図形を編集</div>
                <input
                    type="text"
                    class="shape-name-editor-input"
                    id="shape-name-editor-input"
                    maxlength="80"
                    value="${escapeHtml(layer.shapeName || "")}"
                    placeholder="未入力でラベルを外す"
                />
                <select class="shape-name-editor-select" id="shape-layer-editor-select">
                    ${buildShapeLayerOptions(selectedLayerId)}
                </select>
                <div class="shape-name-editor-color-row">
                    <span class="shape-name-editor-color-label">色</span>
                    <input
                        type="color"
                        class="shape-name-editor-color-input"
                        id="shape-color-editor-input"
                        value="${escapeHtml(normalizeShapeColor(layer.shapeStyle?.color, SHAPE_STYLE.color))}"
                        aria-label="図形色"
                    />
                </div>
                <div class="shape-name-editor-line-type-row">
                    <label class="shape-name-editor-line-type-label" for="shape-line-type-editor-select">線種</label>
                    <select class="shape-name-editor-select" id="shape-line-type-editor-select" aria-label="図形の線種">
                        ${buildShapeLineTypeOptions(selectedLineType)}
                    </select>
                </div>
                ${
                  layer.shapeType === "polyline"
                    ? `<div class="shape-name-editor-line-type-row">
                    <label class="shape-name-editor-line-type-label" for="shape-arrow-type-editor-select">矢印</label>
                    <select class="shape-name-editor-select" id="shape-arrow-type-editor-select" aria-label="折れ線の矢印">
                        ${buildShapeArrowTypeOptions(selectedArrowType)}
                    </select>
                </div>`
                    : ""
                }
                <div class="shape-name-editor-weight-row">
                    <label class="shape-name-editor-weight-label" for="shape-weight-editor-input">太さ</label>
                    <input
                        type="range"
                        class="shape-name-editor-weight-input"
                        id="shape-weight-editor-input"
                        min="${SHAPE_WEIGHT_MIN}"
                        max="${SHAPE_WEIGHT_MAX}"
                        step="1"
                        value="${selectedWeight}"
                        aria-label="図形の線の太さ"
                        aria-valuetext="${selectedWeight}px"
                    />
                    <output class="shape-name-editor-weight-value" id="shape-weight-editor-value" for="shape-weight-editor-input">${selectedWeight}px</output>
                </div>
                <label class="shape-name-editor-memo-label" for="shape-memo-editor-input">メモ（Markdown）</label>
                <textarea
                    class="shape-name-editor-memo-input"
                    id="shape-memo-editor-input"
                    maxlength="${SHAPE_MEMO_MAX_LENGTH}"
                    placeholder="Markdownでメモを入力"
                    aria-label="図形のメモ"
                >${escapeHtml(layer.shapeMemo || "")}</textarea>
                <div class="shape-name-editor-actions">
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-cancel">キャンセル</button>
                    <button type="button" class="shape-name-editor-button" id="shape-name-editor-save">保存</button>
                </div>
            </div>
        `,
    )
    .addTo(map);

  editingShapePopup = editorPopup;

  setTimeout(() => {
    const input = document.getElementById("shape-name-editor-input");
    const layerSelect = document.getElementById("shape-layer-editor-select");
    const colorInput = document.getElementById("shape-color-editor-input");
    const lineTypeSelect = document.getElementById(
      "shape-line-type-editor-select",
    );
    const arrowTypeSelect = document.getElementById(
      "shape-arrow-type-editor-select",
    );
    const weightInput = document.getElementById("shape-weight-editor-input");
    const weightValue = document.getElementById("shape-weight-editor-value");
    const memoInput = document.getElementById("shape-memo-editor-input");
    const saveButton = document.getElementById("shape-name-editor-save");
    const cancelButton = document.getElementById("shape-name-editor-cancel");
    const popupElement =
      editingShapePopup && typeof editingShapePopup.getElement === "function"
        ? editingShapePopup.getElement()
        : null;
    if (
      !input ||
      !layerSelect ||
      !colorInput ||
      !lineTypeSelect ||
      (layer.shapeType === "polyline" && !arrowTypeSelect) ||
      !weightInput ||
      !weightValue ||
      !memoInput ||
      !saveButton ||
      !cancelButton ||
      editingShapeLayer !== layer
    ) {
      return;
    }

    if (popupElement) {
      L.DomEvent.disableClickPropagation(popupElement);
      if (!editorEntryProfile.isMobile) {
        L.DomEvent.disableScrollPropagation(popupElement);
      }
    }

    input.focus();
    input.select();

    const updateWeightValue = () => {
      const normalizedWeight = normalizeShapeWeight(weightInput.value);
      weightValue.value = `${normalizedWeight}px`;
      weightInput.setAttribute("aria-valuetext", `${normalizedWeight}px`);
    };
    weightInput.addEventListener("input", updateWeightValue);
    updateWeightValue();

    const submitEdit = async () => {
      const nextName = normalizeShapeName(input.value);
      const previousLayerId =
        layer.layerId || layer.options?.shapeRecord?.layer_id || null;
      const nextLayerId = layerSelect.value || getShapeEditorLayerId(layer);
      const nextShapeStyle = buildShapeStyleFromColor(
        layer.shapeType,
        colorInput.value,
        lineTypeSelect.value,
        weightInput.value,
        arrowTypeSelect?.value,
      );
      const nextGeoJson = buildShapeGeoJson(
        layer,
        layer.shapeType,
        nextShapeStyle,
        memoInput.value,
      );
      try {
        await persistShapeMetadata(layer, nextName, nextLayerId, nextGeoJson);
        applyShapeRecord(layer, {
          id: layer.shapeId,
          layer_id: nextLayerId,
          shape_type: layer.shapeType,
          name: nextName,
          geojson: nextGeoJson,
        });
        updateShapeNameLabel(layer, nextName);
        setSelectedShapeColor(nextShapeStyle.color);
        applyShapeStyle(layer);
        refreshShapeMeasurementMarkers(layer);
        closeShapeNameEditor();
        if (editorEntryProfile.isMobile) {
          if (previousLayerId !== nextLayerId) callParentReload(nextLayerId);
        } else {
          callParentReload(previousLayerId !== nextLayerId ? nextLayerId : null);
        }
        if (!is_master && nextLayerId !== getCurrentShapeLayerId()) {
          removeShapeMeasurementMarkers(layer);
          drawnShapesGroup.removeLayer(layer);
          setDrawStatus("図形描画: 図形を別レイヤへ移動しました。");
          return;
        }

        setDrawStatus("図形描画: 図形情報を更新しました。");
      } catch (_error) {
        setDrawStatus("図形描画: 図形情報の更新に失敗しました。", true);
      }
    };

    saveButton.addEventListener("click", async () => {
      await submitEdit();
    });

    cancelButton.addEventListener("click", () => {
      if (!editorEntryProfile.isMobile) suppressShapeLabelClick();
      closeShapeNameEditor();
      setDrawStatus("図形描画: 編集をキャンセルしました。");
    });

    input.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        await submitEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (!editorEntryProfile.isMobile) suppressShapeLabelClick();
        closeShapeNameEditor();
        setDrawStatus("図形描画: 編集をキャンセルしました。");
      }
    });
  }, 0);
}

// 形状タイプと GeoJSON から Leaflet レイヤを生成する
// GeoJSON から描画用の図形レイヤを生成する
function createShapeLayer(shapeType, geojson, shapeName = "") {
  const shapeStyle = getShapeStyleFromGeoJson(shapeType, geojson);
  const shapeLayer = createLeafletShapeLayer(shapeType, geojson, shapeStyle);
  if (!shapeLayer) {
    return null;
  }

  applyShapeRecord(shapeLayer, {
    id: null,
    layer_id: null,
    shape_type: shapeType,
    name: shapeName,
    geojson,
  });
  shapeLayer.shapeStyle = shapeStyle;
  applyShapeStyle(shapeLayer, activeDrawMode === "delete");
  updateShapeNameLabel(shapeLayer, shapeName);
  return shapeLayer;
}

// テンプレートから受け取った図形一覧を配列として返す
function getSavedShapes() {
  if (Array.isArray(shapesFromAxum)) {
    return shapesFromAxum;
  }
  if (shapesFromAxum && typeof shapesFromAxum === "object") {
    return Object.values(shapesFromAxum);
  }
  return [];
}

// サーバーから渡された図形一覧を地図へ復元する
function restoreSavedShapes() {
  getSavedShapes().forEach((shape) => {
    const shapeStyle = getShapeStyleFromGeoJson(
      shape.shape_type,
      shape.geojson,
    );
    const shapeLayer = createLeafletShapeLayer(
      shape.shape_type,
      shape.geojson,
      shapeStyle,
    );
    if (!shapeLayer) {
      return;
    }

    applyShapeRecord(shapeLayer, {
      id: shape.id,
      layer_id: shape.layer_id,
      shape_type: shape.shape_type,
      name: shape.name || "",
      geojson: shape.geojson,
    });
    applyShapeStyle(shapeLayer);
    updateShapeNameLabel(shapeLayer, shape.name || "");
    attachShapeEvents(shapeLayer);
    drawnShapesGroup.addLayer(shapeLayer);
  });
}

// 現在表示中の図形ラベルへクリックイベントを再設定する
