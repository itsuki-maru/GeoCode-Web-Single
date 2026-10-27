// @ts-nocheck -- Leaflet編集画面の共有スコープを保つ統合境界。
function mergeShapeFreeText(info, text) {
  if (text === info.free_text) return info.body;
  let first = true;
  let body = info.parts
    .map((part) => {
      if (part.type === "answer") return part.markdown;
      const value = first ? text : "";
      first = false;
      return value;
    })
    .join("");
  return first ? text + body : body;
}
function isLayerInputRestricted(id) {
  return layersFromAxum?.[id]?.restrict_free_text === true;
}
function isShapeInputRestricted(target) {
  return isLayerInputRestricted(target?.layerId || target?.options?.shapeRecord?.layer_id);
}
function syncMarkerInputRestriction(marker, record) {
  if (!marker?.dragging) return;
  if (currentMapMode === "edit" && !isLayerInputRestricted(record?.layer_id))
    marker.dragging.enable();
  else marker.dragging.disable();
}

function getCurrentShapeLayerId() {
  if (typeof layer !== "string") {
    return null;
  }

  const trimmedLayerId = layer.trim();
  if (!trimmedLayerId || trimmedLayerId === "null" || trimmedLayerId === "None") {
    return null;
  }

  return trimmedLayerId;
}

// 図形編集用に選択可能なレイヤ一覧を取得する
function getEditableShapeLayers() {
  return Object.values(layersFromAxum || {})
    .filter((layerRecord) => layerRecord && layerRecord.id && layerRecord.layer_name)
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
  return targetLayer?.layerId || getCurrentShapeLayerId() || getEditableShapeLayers()[0]?.id || "";
}

// レイヤ選択プルダウンの option 群を組み立てる
function buildShapeLayerOptions(selectedLayerId) {
  return getEditableShapeLayers()
    .map((layerRecord) => {
      const selected = layerRecord.id === selectedLayerId ? "selected" : "";
      const layerLabel = escapeHtml(layerRecord.layer_name || "名称未設定レイヤ");
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
function applyShapeRecord(layer, shapeRecord, syncRecord = true) {
  if (!layer) {
    return;
  }

  if (!layer.options) {
    layer.options = {};
  }

  layer.options.shapeRecord = {
    ...shapeRecord,
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
  layer.shapeStyle = getShapeStyleFromGeoJson(shapeRecord.shape_type, shapeRecord.geojson);
  layer.feature = shapeRecord.geojson;
  bindShapeArrowStyle(layer);
  if (shapeRecord.id) {
    searchableShapeLayers.add(layer);
    if (syncRecord) {
      editorShapeRecords.set(String(shapeRecord.id), layer.options.shapeRecord);
      shapeRenderManager?.upsert(layer.options.shapeRecord, layer);
      shapeRenderManager?.scheduleRefresh();
    }
  }
}

function isShapeVisibleForSearch(layer) {
  return Boolean(
    layer &&
      !layer.isDeletedShape &&
      (!externalShapeFilterIdSet || externalShapeFilterIdSet.has(String(layer.shapeId))) &&
      matchesShapeSearch(layer.options?.shapeRecord, localMarkerSearchQuery),
  );
}

function renderVisibleShapes() {
  shapeRenderManager?.refresh();
  shapeNameLabelManager?.scheduleRefresh();
  pruneMeasurementSelection();
  shapeMeasurementManager?.scheduleRefresh();
}

function matchesEditorShapeSearch(record) {
  if (!record || typeof record !== "object") return false;
  const cached = editorShapeSearchCache.get(record);
  if (cached && cached.query === localMarkerSearchQuery) return cached.matches;
  const matches = matchesShapeSearch(record, localMarkerSearchQuery);
  editorShapeSearchCache.set(record, { query: localMarkerSearchQuery, matches });
  return matches;
}

function beginSavingShape(id) {
  const key = String(id);
  savingShapeIds.set(key, (savingShapeIds.get(key) || 0) + 1);
}

function endSavingShape(id) {
  const key = String(id);
  const remaining = (savingShapeIds.get(key) || 0) - 1;
  if (remaining > 0) savingShapeIds.set(key, remaining);
  else savingShapeIds.delete(key);
  shapeRenderManager?.scheduleRefresh();
}

function isEditorShapeRecordVisible(record) {
  return Boolean(
    record &&
      !deletedShapeIds.has(String(record.id)) &&
      (is_master || record.layer_id === getCurrentShapeLayerId()) &&
      (!externalShapeFilterIdSet || externalShapeFilterIdSet.has(String(record.id))) &&
      (!editorEntryProfile.isMobile || matchesEditorShapeSearch(record)),
  );
}

function initializeEditorShapeRendering() {
  shapeRenderManager = createShapeRenderManager({
    map,
    records: editorShapeRecords.values(),
    isRecordVisible: (record) =>
      map.hasLayer(drawnShapesGroup) && isEditorShapeRecordVisible(record),
    isPinned: (id, layer) =>
      String(id) === focusedEditorShapeId ||
      String(id) === recentlyCreatedShapeId ||
      savingShapeIds.has(String(id)) ||
      Boolean(
        layer &&
          (layer === geometryEditingShapeLayer ||
            layer === editingShapeLayer ||
            layer === circleShapeDragState?.layer ||
            layer.isDeletingShape ||
            isEditorShapePopupOpen?.(layer) ||
            measurementSelectedShapes.has(layer)),
      ),
    createLayer: (record) => {
      const style = getShapeStyleFromGeoJson(record.shape_type, record.geojson);
      const layer = createLeafletShapeLayer(record.shape_type, record.geojson, style);
      if (!layer) return null;
      applyShapeRecord(layer, record, false);
      applyShapeStyle(layer, activeDrawMode === "delete");
      updateShapeNameLabel(layer, record.name || "");
      attachShapeEvents(layer);
      return layer;
    },
    addLayer: (layer) => {
      drawnShapesGroup.addLayer(layer);
      applyShapeArrowStyle(layer);
    },
    removeLayer: (layer) => {
      drawnShapesGroup.removeLayer(layer);
      removeShapeMeasurementMarkers(layer);
      shapeNameLabelManager?.invalidate(layer);
    },
    disposeLayer: (layer) => {
      removeShapeMeasurementMarkers(layer);
      shapeNameLabelManager?.invalidate(layer);
      searchableShapeLayers.delete(layer);
      releaseShapeMemoLayer?.(layer);
      if (typeof popupContent !== "undefined")
        popupContent.release?.("shape", String(layer.shapeId));
      layer.unbindPopup?.();
      layer.unbindTooltip?.();
      layer.off?.();
    },
    onRefresh: () => {
      shapeNameLabelManager?.scheduleRefresh();
      shapeMeasurementManager?.scheduleRefresh();
    },
  });
  shapeRenderManager.refresh();
  map.on("movestart zoomstart", () => {
    recentlyCreatedShapeId = null;
  });
  map.on("unload", () => {
    shapeRenderManager?.destroy();
    shapeNameLabelManager?.destroy();
    shapeMeasurementManager?.destroy();
    savingShapeIds.clear();
    recentlyCreatedShapeId = null;
  });
}

// 図形名と所属レイヤの変更をバックエンドへ保存する
async function persistShapeMetadata(
  layer,
  nextName,
  nextLayerId,
  nextGeoJson,
  nextShapeType = null,
  bodyEdit = null,
) {
  if (!layer?.shapeId) {
    throw new Error("shape update target missing");
  }

  const restricted = isShapeInputRestricted(layer) || isLayerInputRestricted(nextLayerId);
  if (
    restricted &&
    ((nextGeoJson &&
      JSON.stringify(nextGeoJson) !== JSON.stringify(layer.options?.shapeRecord?.geojson)) ||
      (nextShapeType && nextShapeType !== layer.shapeType))
  ) {
    throw new Error("入力が制限されています。");
  }
  beginSavingShape(layer.shapeId);
  try {
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
        ...bodyEdit,
      }),
    });

    if (!response.ok) {
      throw new Error("shape update failed");
    }
    const data = typeof response.json === "function" ? await response.json() : {};
    return (
      data.object || {
        ...(layer.options?.shapeRecord || {}),
        name: nextName,
        layer_id: nextLayerId,
        shape_type: nextShapeType || layer.shapeType,
        geojson: nextGeoJson || layer.options?.shapeRecord?.geojson,
      }
    );
  } finally {
    endSavingShape(layer.shapeId);
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
  const selectedLineType = getShapeLineTypeFromDashArray(layer.shapeStyle?.dashArray);
  const selectedArrowType = normalizeShapeArrowType(layer.shapeStyle?.arrowType);
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

  setTimeout(async () => {
    const input = document.getElementById("shape-name-editor-input");
    const layerSelect = document.getElementById("shape-layer-editor-select");
    const colorInput = document.getElementById("shape-color-editor-input");
    const lineTypeSelect = document.getElementById("shape-line-type-editor-select");
    const arrowTypeSelect = document.getElementById("shape-arrow-type-editor-select");
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

    let bodyInfo = null;
    let bodyUnavailable = false;
    saveButton.disabled = true;
    memoInput.readOnly = true;
    try {
      const response = await fetchWithAuth(`/shape/${layer.shapeId}/form/body`);
      if (response.ok) {
        const info = await response.json();
        if (typeof info.free_text === "string" && Array.isArray(info.parts)) {
          bodyInfo = info;
          if (!info.sync_required) memoInput.value = info.free_text;
          const note = document.createElement("div");
          note.className = "shape-name-editor-help";
          const title = document.createElement("p");
          title.textContent = info.sync_required
            ? "本文・メモと回答の対応確認が必要です。回答一覧から編集してください。"
            : "フォーム由来のメモは回答一覧から編集できます。";
          note.append(title);
          if (info.managed_markdown) {
            const details = document.createElement("details"),
              summary = document.createElement("summary"),
              content = document.createElement("pre");
            summary.textContent = "フォーム回答からのメモ";
            content.textContent = info.managed_markdown;
            content.style.whiteSpace = "pre-wrap";
            content.style.maxHeight = "120px";
            content.style.overflow = "auto";
            details.append(summary, content);
            note.append(details);
          }
          memoInput.after(note);
        }
      } else if (response.status !== 404) bodyUnavailable = true;
    } catch {
      bodyUnavailable = true;
    }
    if (editingShapeLayer !== layer) return;
    saveButton.disabled = false;
    if (bodyUnavailable)
      setDrawStatus(
        "本文・メモを確認できないため、メモは読み取り専用です。編集を開き直してください。",
        true,
      );

    const protectedInputs = [
      memoInput,
      colorInput,
      lineTypeSelect,
      arrowTypeSelect,
      weightInput,
    ].filter(Boolean);
    const initialValues = protectedInputs.map((el) => el.value);
    const updateRestriction = () => {
      const restricted = isShapeInputRestricted(layer) || isLayerInputRestricted(layerSelect.value);
      memoInput.readOnly = restricted || !!bodyInfo?.sync_required || bodyUnavailable;
      memoInput.placeholder = restricted ? "入力が制限されています。" : "Markdownでメモを入力";
      for (const el of protectedInputs) if (el !== memoInput) el.disabled = restricted;
    };
    let previousSelection = layerSelect.value;
    layerSelect.addEventListener("change", () => {
      if (
        isLayerInputRestricted(layerSelect.value) &&
        protectedInputs.some((el, i) => el.value !== initialValues[i])
      ) {
        layerSelect.value = previousSelection;
        setDrawStatus(
          "内容・メモ・図形スタイルの変更を保存してから移動先を選択してください。",
          true,
        );
        return;
      }
      previousSelection = layerSelect.value;
      updateRestriction();
    });
    if (isShapeInputRestricted(layer)) {
      const note = document.createElement("p");
      note.className = "shape-name-editor-help";
      note.textContent =
        "メモの自由記述が制限されています。名前・所属レイヤの変更と、地図上での頂点編集は可能です。";
      memoInput.after(note);
    }
    updateRestriction();

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
      const previousLayerId = layer.layerId || layer.options?.shapeRecord?.layer_id || null;
      const nextLayerId = layerSelect.value || getShapeEditorLayerId(layer);
      const nextShapeStyle = buildShapeStyleFromColor(
        layer.shapeType,
        colorInput.value,
        lineTypeSelect.value,
        weightInput.value,
        arrowTypeSelect?.value,
      );
      const restricted = isShapeInputRestricted(layer) || isLayerInputRestricted(nextLayerId);
      const bodyEdit =
        !restricted && bodyInfo && !bodyInfo.sync_required
          ? { free_text: memoInput.value, body_token: bodyInfo.body_token }
          : null;
      const nextMemo = bodyEdit ? mergeShapeFreeText(bodyInfo, memoInput.value) : memoInput.value;
      const nextGeoJson = restricted
        ? layer.options.shapeRecord.geojson
        : buildShapeGeoJson(layer, layer.shapeType, nextShapeStyle, nextMemo);
      try {
        const savedRecord = await persistShapeMetadata(
          layer,
          nextName,
          nextLayerId,
          restricted ? null : nextGeoJson,
          null,
          bodyEdit,
        );
        applyShapeRecord(layer, savedRecord);
        updateShapeNameLabel(layer, nextName);
        setSelectedShapeColor(nextShapeStyle.color);
        applyShapeStyle(layer);
        refreshShapeMeasurementMarkers(layer);
        closeShapeNameEditor();
        if (typeof notifyParentMapObjectChange === "function")
          notifyParentMapObjectChange({
            operation: "upsert",
            objectType: "shape",
            object: savedRecord,
            previousLayerId,
          });
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
  editorShapeRecords.clear();
  getSavedShapes().forEach((shape) => {
    if (shape?.id) editorShapeRecords.set(String(shape.id), shape);
  });
}

// 現在表示中の図形ラベルへクリックイベントを再設定する
