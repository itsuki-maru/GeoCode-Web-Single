// @ts-nocheck -- 編集地図と親画面の差分・初期データ同期境界。
const editorRuntimeId = "runtime-" + Date.now() + "-" + Math.random().toString(36).slice(2);
let editorDataReady = window.__GEOCODE_MAP_BOOTSTRAP__?.dataSource !== "parent";
let editorSnapshotGeneration = 0;
let editorMutationSequence = 0;
const pendingParentChanges = new Map();
const pendingParentWrites = new Map();
const initialEditorParentOrigin = document.referrer
  ? new URL(document.referrer).origin
  : window.location.origin;
let editorParentOrigin = [
  window.location.origin,
  "http://localhost:5173",
  "http://localhost:3000",
].includes(initialEditorParentOrigin)
  ? initialEditorParentOrigin
  : null;
function announceEditorRuntime(requestId) {
  if (window.parent !== window && editorParentOrigin)
    window.parent.postMessage(
      { type: "mapRuntimeReady", runtimeId: editorRuntimeId, requestId },
      editorParentOrigin,
    );
}

// API保存と親画面の同期は独立させ、ACKが失われても保存を二重実行しない。
function notifyParentMapObjectChange(change) {
  if (window.parent === window || !editorParentOrigin) return;
  const mutationId = editorRuntimeId + "-" + ++editorMutationSequence;
  const message = {
    type: "mapObjectChanged",
    runtimeId: editorRuntimeId,
    change: { ...change, mutationId },
  };
  let attempts = 0;
  const send = () => {
    window.parent.postMessage(message, editorParentOrigin);
    const timer = setTimeout(() => {
      if (!pendingParentChanges.has(mutationId)) return;
      if (++attempts < 3) send();
      else {
        pendingParentChanges.delete(mutationId);
        setDrawStatus("保存しましたが一覧の同期に失敗しました。再読み込みしてください。", true);
      }
    }, 3000);
    pendingParentChanges.set(mutationId, timer);
  };
  send();
}

function isParentMapObjectWrite(url, method) {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin) return false;
  const path = target.pathname;
  return (
    (method === "POST" && ["/marker", "/shape"].includes(path)) ||
    (method === "PUT" &&
      (path === "/marker/update-marker-latlng" ||
        /^\/marker\/update\/[^/]+$/.test(path) ||
        /^\/shape\/[^/]+(?:\/geometry)?$/.test(path))) ||
    (method === "DELETE" &&
      (/^\/marker\/delete\/[^/]+$/.test(path) || /^\/shape\/[^/]+$/.test(path)))
  );
}

function requestParentMapObjectWrite(url, options) {
  const target = new URL(url, window.location.href);
  const requestId = editorRuntimeId + "-write-" + ++editorMutationSequence;
  const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  return new Promise((resolve, reject) => {
    pendingParentWrites.set(requestId, { resolve, reject });
    window.parent.postMessage(
      {
        type: "mapObjectWriteRequested",
        runtimeId: editorRuntimeId,
        request: {
          requestId,
          url: target.pathname + target.search,
          method: String(options.method || "GET").toUpperCase(),
          body,
        },
      },
      editorParentOrigin,
    );
  });
}

function applyMarkerUpdateFromParent(payload) {
  const supplied = payload?.object;
  const markerId = String(supplied?.id || payload?.id || "");
  if (!markerId) return false;
  const markerKey = "marker-" + markerId;
  const current = markersFromAxum[markerId];
  const nextRecord = supplied
    ? { ...supplied }
    : {
        ...current,
        id: markerId,
        layer_id: String(payload.layerId || ""),
        marker_name: String(payload.name || ""),
        detail: String(payload.detail || ""),
        latitude: Number(payload.latitude),
        longitude: Number(payload.longitude),
      };
  if (
    !Number.isFinite(Number(nextRecord.latitude)) ||
    !Number.isFinite(Number(nextRecord.longitude))
  )
    return false;
  let marker = markers[markerKey];
  const wasPopupOpen = Boolean(marker?.isPopupOpen?.());
  if (!marker) {
    marker = L.marker(
      [nextRecord.latitude, nextRecord.longitude],
      markerOptionsForLayer(nextRecord.layer_id, layersFromAxum, { draggable: false }),
    );
    marker.id = markerId;
    marker.on("dragend", (event) => {
      const position = event.target.getLatLng();
      updateServer(markerId, position.lat, position.lng);
    });
    marker.on("popupopen", () => setupDetailsLazyImages(document, renderMapMarkdown));
    markers[markerKey] = marker;
    markersClusterGroup.addLayer(marker);
  }
  markersFromAxum[markerId] = nextRecord;
  syncMarkerInputRestriction(marker, nextRecord);
  marker.setLatLng([nextRecord.latitude, nextRecord.longitude]);
  marker.unbindTooltip();
  marker.unbindPopup();
  marker.bindTooltip(
    '<div class="custom-tooltip">' + escapeHtml(nextRecord.marker_name || "No Name") + "</div>",
  );
  marker.bindPopup(
    popupContent.render({
      kind: "marker",
      id: markerId,
      name: nextRecord.marker_name || "",
      body: nextRecord.detail || "",
    }),
  );
  const options = markerOptionsForLayer(nextRecord.layer_id, layersFromAxum);
  marker.setIcon(options.icon || new L.Icon.Default());
  const element = marker.getElement();
  if (element) element.id = markerKey;
  if (
    typeof isTooltipVisible !== "undefined" &&
    isTooltipVisible &&
    map.hasLayer(markersClusterGroup) &&
    markersClusterGroup.hasLayer(marker)
  )
    marker.openTooltip();
  if (wasPopupOpen) marker.openPopup();
  return true;
}

function applyMarkerDeleteFromParent(markerIdValue) {
  const markerId = String(markerIdValue || "");
  if (!markerId) return false;
  const markerKey = "marker-" + markerId;
  const marker = markers[markerKey];
  if (marker) {
    marker.closePopup?.();
    marker.closeTooltip?.();
    markersClusterGroup.removeLayer(marker);
    marker.off?.();
    popupContent?.release?.("marker", markerId);
  }
  delete markers[markerKey];
  delete markersFromAxum[markerId];
  if (editorEntryProfile.isMobile) renderVisibleMarkers();
  return true;
}

function applyShapeDeleteFromParent(id) {
  const shapeId = String(id || "");
  if (!shapeId) return false;
  editorShapeRecords.delete(shapeId);
  shapeRenderManager?.remove(shapeId);
  renderVisibleShapes();
  return true;
}

function applyShapeUpdateFromParent(payload) {
  const supplied = payload?.object;
  const shapeId = String(supplied?.id || payload?.id || "");
  if (!shapeId) return false;
  const current = editorShapeRecords.get(shapeId);
  const nextRecord = supplied
    ? { ...supplied }
    : {
        ...current,
        id: shapeId,
        layer_id: String(payload.layerId || ""),
        shape_type: payload.shapeType,
        name: String(payload.name || ""),
        geojson: payload.geojson,
      };
  if (!nextRecord.geojson || !nextRecord.shape_type) return false;
  deletedShapeIds.delete(shapeId);
  const targetLayer = shapeRenderManager?.getLayer(shapeId);
  if (!targetLayer || (current && current.shape_type !== nextRecord.shape_type)) {
    editorShapeRecords.set(shapeId, nextRecord);
    shapeRenderManager?.upsert(nextRecord);
    renderVisibleShapes();
    return true;
  }
  if (JSON.stringify(current?.geojson?.geometry) !== JSON.stringify(nextRecord.geojson.geometry)) {
    const geometry = nextRecord.geojson.geometry;
    if (nextRecord.shape_type === "circle" && geometry?.type === "Point") {
      targetLayer.setLatLng([geometry.coordinates[1], geometry.coordinates[0]]);
      targetLayer.setRadius(getCircleRadiusFromGeoJson(nextRecord.geojson));
    } else if (geometry?.type === "LineString" || geometry?.type === "Polygon") {
      targetLayer.setLatLngs(
        L.GeoJSON.coordsToLatLngs(geometry.coordinates, geometry.type === "Polygon" ? 1 : 0),
      );
    } else return false;
  }
  applyShapeRecord(targetLayer, nextRecord);
  updateShapeNameLabel(targetLayer, nextRecord.name || "");
  applyShapeStyle(targetLayer, activeDrawMode === "delete");
  refreshShapeMeasurementMarkers(targetLayer);
  renderVisibleShapes();
  applyMeasurementVisibilityToDrawnShapesGroup();
  return true;
}

function applyMapObjectUpdateFromParent(payload) {
  if (payload?.objectType === "marker") return applyMarkerUpdateFromParent(payload);
  if (payload?.objectType === "shape") return applyShapeUpdateFromParent(payload);
  return false;
}

async function applyEditorMapSnapshot(snapshot) {
  if (
    !snapshot ||
    !snapshot.markers ||
    typeof snapshot.markers !== "object" ||
    !Array.isArray(snapshot.shapes)
  )
    return false;
  const markerRecords = Object.values(snapshot.markers);
  if (
    markerRecords.some(
      (record) =>
        !record?.id ||
        !Number.isFinite(Number(record.latitude)) ||
        !Number.isFinite(Number(record.longitude)),
    ) ||
    snapshot.shapes.some((record) => !record?.id || !record.geojson)
  )
    return false;
  const generation = ++editorSnapshotGeneration;
  const selectedShapeIds =
    typeof measurementSelectedShapes !== "undefined"
      ? [...measurementSelectedShapes].map((shape) => String(shape.shapeId))
      : [];
  const selectedShapeType =
    typeof measurementSelectionType !== "undefined" ? measurementSelectionType : null;
  editorDataReady = false;
  clearShapeGeometryEditing();
  closeShapeNameEditor();
  markersClusterGroup.clearLayers();
  for (const [key, marker] of Object.entries(markers)) {
    marker.off?.();
    popupContent?.release?.("marker", String(marker.id));
    delete markers[key];
  }
  for (const id of Object.keys(markersFromAxum)) delete markersFromAxum[id];
  // Register marker batches between frames; no repeated JSON encoding of all records.
  for (let offset = 0; offset < markerRecords.length; offset += 500) {
    if (generation !== editorSnapshotGeneration) return false;
    for (const record of markerRecords.slice(offset, offset + 500))
      applyMarkerUpdateFromParent({ objectType: "marker", object: record });
    if (offset + 500 < markerRecords.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (generation !== editorSnapshotGeneration) return false;
  shapesFromAxum = snapshot.shapes;
  window.__GEOCODE_MAP_BOOTSTRAP__.markers = markersFromAxum;
  window.__GEOCODE_MAP_BOOTSTRAP__.shapes = shapesFromAxum;
  editorShapeRecords.clear();
  for (const record of snapshot.shapes) editorShapeRecords.set(String(record.id), record);
  deletedShapeIds.clear();
  shapeRenderManager.replaceRecords(editorShapeRecords.values());
  if (typeof measurementSelectedShapes !== "undefined") {
    measurementSelectedShapes.clear();
    for (const id of selectedShapeIds) {
      const record = editorShapeRecords.get(id);
      if (record && (!selectedShapeType || record.shape_type === selectedShapeType)) {
        const selected = shapeRenderManager.ensureLayer(id);
        if (selected) measurementSelectedShapes.add(selected);
      }
    }
  }
  renderVisibleShapes();
  if (editorEntryProfile.isMobile) renderVisibleMarkers();
  editorDataReady = true;
  return true;
}

// 埋め込み表示の PC 版編集画面だけ、印刷処理をアプリケーション側へ委ねる。
if (!editorEntryProfile.isMobile && window.parent !== window) {
  const printParentOrigin = document.referrer
    ? new URL(document.referrer).origin
    : window.location.origin;
  if (
    [window.location.origin, "http://localhost:5173", "http://localhost:3000"].includes(
      printParentOrigin,
    )
  ) {
    window.addEventListener("keydown", (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key.toLowerCase() !== "p"
      )
        return;
      event.preventDefault();
      if (!event.repeat && editorDataReady)
        window.parent.postMessage({ type: "printOpen" }, printParentOrigin);
    });
  }
}

// iframe内でマーカーIDと座標を受け取る
window.addEventListener("message", function (event) {
  const allowOrigins = ["http://localhost:5173", "http://localhost:3000"];

  const isSameOrigin = event.origin === window.location.origin;

  if (event.source === window.parent && (allowOrigins.includes(event.origin) || isSameOrigin)) {
    editorParentOrigin = event.origin;
    const messageData = event.data;
    if (!messageData || typeof messageData !== "object") return;
    if (messageData.type === "mapRuntimeProbe") {
      announceEditorRuntime(messageData.requestId);
    } else if (messageData.type === "mapObjectWriteResult") {
      if (messageData.runtimeId !== editorRuntimeId) return;
      const pending = pendingParentWrites.get(messageData.requestId);
      if (!pending) return;
      pendingParentWrites.delete(messageData.requestId);
      const status = Number(messageData.status);
      pending.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => messageData.data,
        text: async () => JSON.stringify(messageData.data),
      });
    } else if (messageData.type === "mapObjectChangedResult") {
      if (messageData.runtimeId !== editorRuntimeId) return;
      const timer = pendingParentChanges.get(messageData.mutationId);
      if (timer) clearTimeout(timer);
      pendingParentChanges.delete(messageData.mutationId);
      if (messageData.success !== true)
        setDrawStatus("保存しましたが一覧を更新できませんでした。再読み込みしてください。", true);
    } else if (messageData.type === "mapObjectsInitialize") {
      if (messageData.runtimeId !== editorRuntimeId || !messageData.requestId) return;
      void applyEditorMapSnapshot(messageData.snapshot)
        .then((success) => {
          event.source.postMessage(
            {
              type: "mapObjectsInitializeResult",
              requestId: messageData.requestId,
              runtimeId: editorRuntimeId,
              success,
            },
            event.origin,
          );
        })
        .catch((error) => {
          console.error("Map snapshot failed:", error);
          event.source.postMessage(
            {
              type: "mapObjectsInitializeResult",
              requestId: messageData.requestId,
              runtimeId: editorRuntimeId,
              success: false,
            },
            event.origin,
          );
        });
    } else if (messageData.type === "mapViewRequest") {
      const center = map.getCenter();
      window.parent.postMessage(
        {
          type: "mapViewResult",
          requestId: messageData.requestId,
          view: { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() },
        },
        event.origin,
      );
    } else if (messageData.type === "layerInputPolicies") {
      let changed = false;
      for (const [id, restricted] of Object.entries(messageData.policies || {})) {
        if (layersFromAxum[id] && typeof restricted === "boolean") {
          changed ||= layersFromAxum[id].restrict_free_text !== restricted;
          layersFromAxum[id].restrict_free_text = restricted;
        }
      }
      if (changed) {
        clearShapeGeometryEditing();
        closeShapeNameEditor();
        for (const [key, marker] of Object.entries(markers))
          syncMarkerInputRestriction(marker, markersFromAxum[key.slice(7)]);
      }
    } else if (messageData.type === "printStateRequest" && !editorEntryProfile.isMobile) {
      if (!editorDataReady) {
        event.source.postMessage(
          { type: "printStateResult", requestId: messageData.requestId, error: "map-data-loading" },
          event.origin,
        );
        return;
      }
      const center = map.getCenter();
      window.parent.postMessage(
        {
          type: "printStateResult",
          requestId: messageData.requestId,
          state: {
            view: { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() },
            tileServerId: document.querySelector(".tile-radio:checked")?.value || "1",
            overlays: tileOverlayManager.getVisibility(),
            clusteringEnabled: markerClustering.getEnabled(),
            clusteringAllowed: markerClustering.isAllowed(),
            markersVisible: map.hasLayer(markersClusterGroup),
            shapesVisible: map.hasLayer(drawnShapesGroup),
            shapeNamesVisible: map.hasLayer(shapeNameVisibilityLayer),
            markerIds: externalMarkerFilterIds === null ? null : [...externalMarkerFilterIds],
            shapeIds: externalShapeFilterIdSet === null ? null : [...externalShapeFilterIdSet],
          },
        },
        event.origin,
      );
    } else if (messageData["type"] === "focus") {
      focusMapObject(
        messageData["objectType"],
        messageData["id"],
        messageData["lat"],
        messageData["lng"],
      );
    } else if (messageData["type"] === "attributeSearchState") {
      const button = document.getElementById("advanced-map-search-button");
      if (button && typeof messageData.active === "boolean") {
        button.textContent = messageData.active ? "詳しい検索（適用中）" : "詳しい検索";
        button.setAttribute("aria-pressed", String(messageData.active));
      }
    } else if (messageData["type"] === "mapObjectFilter") {
      applyMapObjectFilter(messageData["markerIds"], messageData["shapeIds"]);
    } else if (messageData["type"] === "markerFilter") {
      applyMarkerFilter(messageData["ids"]);
    } else if (messageData["type"] === "tileOverlaysUpdate") {
      let success = false;
      try {
        success = tileOverlayManager.sync(messageData.tiles);
      } catch {
        /* 失敗した場合は親画面で再読み込みする。 */
      }
      window.parent.postMessage(
        { type: "tileOverlaysUpdateResult", requestId: messageData.requestId, success },
        event.origin,
      );
    } else if (messageData["type"] === "mapObjectUpdate") {
      let success = false;
      try {
        success = applyMapObjectUpdateFromParent(messageData["payload"]);
        if (
          editorEntryProfile.isMobile &&
          success &&
          messageData["payload"]?.objectType === "marker"
        ) {
          renderVisibleMarkers();
        }
      } catch (error) {
        console.error("Map object update from parent failed:", error);
      }
      event.source.postMessage(
        {
          type: "mapObjectUpdateResult",
          requestId: messageData["requestId"],
          success,
        },
        event.origin,
      );
    } else if (messageData["type"] === "mapObjectDelete") {
      let success = false;
      try {
        success =
          messageData.objectType === "shape"
            ? applyShapeDeleteFromParent(messageData.id)
            : applyMarkerDeleteFromParent(messageData.id);
      } catch (error) {
        console.error("Map object delete from parent failed:", error);
      }
      event.source.postMessage(
        {
          type: "mapObjectDeleteResult",
          requestId: messageData["requestId"],
          success,
        },
        event.origin,
      );
    }
  }
});

// 親ウィンドウへログイン画面遷移要求を送る
function callParentLogin() {
  window.parent.postMessage({ type: "callParentLoginRedirect", message: "Token expired" }, "*");
}

// 親ウィンドウへ再読み込み要求を送る
function callParentReload(layerId = null) {
  window.parent.postMessage(
    {
      type: "callParentReload",
      message: "Reload",
      layerId: layerId,
    },
    "*",
  );
}

// 親ウィンドウへ画像プレビュー表示要求を送る
function callParentImagePreview(url) {
  window.parent.postMessage(
    {
      type: editorEntryProfile.isMobile ? "callParentImagePreview" : "callParentFunction",
      message: url,
    },
    "*",
  );
}

// トークンの認可管理と新規発行（認証切れ時の再試行を含めた fetch ラッパー）
async function fetchWithAuth(url, options = {}) {
  if (
    window.__GEOCODE_MAP_BOOTSTRAP__?.dataSource === "parent" &&
    window.parent !== window &&
    editorParentOrigin &&
    isParentMapObjectWrite(url, String(options.method || "GET").toUpperCase())
  )
    return requestParentMapObjectWrite(url, options);
  let response = await fetch(url, {
    ...options,
    credentials: "include", // `httpOnly` クッキーを送信
  });
  if (response.status === 401) {
    try {
      await refreshToken(); // リフレッシュトークンを取得
      response = await fetch(url, {
        ...options,
        credentials: "include", // 新しいアクセストークンを送信
      });
    } catch (error) {
      callParentLogin();
      throw new Error("Session expired, please log in again");
    }
  }
  return response;
}

// リフレッシュトークンでアクセストークンを更新する
async function refreshToken() {
  try {
    const response = await fetch("/account/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error("Refresh token expired");
    }
  } catch (error) {
    throw new Error("Token refresh failed");
  }
}

// セッションを破棄してログイン画面へ戻す
function logout() {
  callParentLogin();
}

announceEditorRuntime();
map.on("unload", () => {
  ++editorSnapshotGeneration;
  pendingParentChanges.forEach(clearTimeout);
  pendingParentChanges.clear();
  pendingParentWrites.forEach(({ reject }) => {
    reject(new Error("Map frame closed"));
  });
  pendingParentWrites.clear();
});
