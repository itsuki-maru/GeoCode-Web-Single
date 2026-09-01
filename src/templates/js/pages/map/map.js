// Vue 側で更新されたマーカー情報を、既存の Leaflet マーカーへ反映する
function applyMarkerUpdateFromParent(payload) {
  const markerId = String(payload?.id || "");
  const markerKey = `marker-${markerId}`;
  const marker = markers[markerKey];
  const current = markersFromAxum[markerId];
  if (
    !marker ||
    !current ||
    !Number.isFinite(Number(payload.latitude)) ||
    !Number.isFinite(Number(payload.longitude))
  ) {
    return false;
  }

  const nextRecord = {
    ...current,
    id: markerId,
    layer_id: String(payload.layerId || ""),
    marker_name: String(payload.name || ""),
    detail: String(payload.detail || ""),
    latitude: Number(payload.latitude),
    longitude: Number(payload.longitude),
  };
  markersFromAxum[markerId] = nextRecord;
  marker.setLatLng([nextRecord.latitude, nextRecord.longitude]);

  const wasPopupOpen =
    typeof marker.isPopupOpen === "function" && marker.isPopupOpen();
  marker.unbindTooltip();
  marker.unbindPopup();
  marker.bindTooltip(
    nextRecord.marker_name
      ? `<div class="custom-tooltip">${escapeHtml(nextRecord.marker_name)}</div>`
      : `<div class="custom-tooltip">No Name</div>`,
  );
  if (nextRecord.detail) {
    const mdText = `# ${nextRecord.marker_name}\n\n${nextRecord.detail}`;
    const cleanHtml = filterXSS(marked.parse(mdText), xssOptions);
    marker.bindPopup(
      `<div class="md-detail-contents">${renderIframe(cleanHtml)}</div>`,
    );
  }

  const markerOptions = markerOptionsForLayer(
    nextRecord.layer_id,
    layersFromAxum,
  );
  marker.setIcon(markerOptions.icon || new L.Icon.Default());
  const markerElement = marker.getElement();
  if (markerElement) {
    markerElement.id = markerKey;
  }
  if (wasPopupOpen && nextRecord.detail) {
    marker.openPopup();
  }
  return true;
}

// Vue 側で削除されたマーカーを、地図の管理データと表示グループから除去する
function applyMarkerDeleteFromParent(markerIdValue) {
  const markerId = String(markerIdValue || "");
  const markerKey = `marker-${markerId}`;
  const marker = markers[markerKey];
  if (!markerId || !marker || !markersFromAxum[markerId]) {
    return false;
  }

  if (typeof marker.closePopup === "function") marker.closePopup();
  if (typeof marker.closeTooltip === "function") marker.closeTooltip();
  markersClusterGroup.removeLayer(marker);
  delete markers[markerKey];
  delete markersFromAxum[markerId];
  return true;
}

// Vue 側で更新された図形情報を、既存の Leaflet レイヤへ反映する
function applyShapeUpdateFromParent(payload) {
  const shapeId = String(payload?.id || "");
  const targetLayer = Array.from(searchableShapeLayers).find(
    (shapeLayer) => String(shapeLayer?.shapeId || "") === shapeId,
  );
  if (
    !targetLayer ||
    !payload?.geojson ||
    targetLayer.shapeType !== payload.shapeType
  ) {
    return false;
  }

  const currentGeometry = targetLayer.options?.shapeRecord?.geojson?.geometry;
  if (
    JSON.stringify(currentGeometry) !== JSON.stringify(payload.geojson.geometry)
  ) {
    return false;
  }

  applyShapeRecord(targetLayer, {
    id: shapeId,
    layer_id: String(payload.layerId || ""),
    shape_type: payload.shapeType,
    name: String(payload.name || ""),
    geojson: payload.geojson,
  });
  updateShapeNameLabel(targetLayer, payload.name || "");
  applyShapeStyle(targetLayer, activeDrawMode === "delete");
  refreshShapeMeasurementMarkers(targetLayer);
  renderVisibleShapes();
  applyMeasurementVisibilityToDrawnShapesGroup();
  return true;
}

function applyMapObjectUpdateFromParent(payload) {
  if (payload?.objectType === "marker") {
    return applyMarkerUpdateFromParent(payload);
  }
  if (payload?.objectType === "shape") {
    return applyShapeUpdateFromParent(payload);
  }
  return false;
}

// iframe内でマーカーIDと座標を受け取る
window.addEventListener("message", function (event) {
  const allowOrigins = ["http://localhost:5173", "http://localhost:3000"];

  const isSameOrigin = event.origin === window.location.origin;

  if (
    event.source === window.parent &&
    (allowOrigins.includes(event.origin) || isSameOrigin)
  ) {
    const messageData = event.data;
    if (!messageData || typeof messageData !== "object") return;
    if (messageData["type"] === "focus") {
      focusMapObject(
        messageData["objectType"],
        messageData["id"],
        messageData["lat"],
        messageData["lng"],
      );
    } else if (messageData["type"] === "mapObjectFilter") {
      applyMapObjectFilter(messageData["markerIds"], messageData["shapeIds"]);
    } else if (messageData["type"] === "markerFilter") {
      applyMarkerFilter(messageData["ids"]);
    } else if (messageData["type"] === "mapObjectUpdate") {
      let success = false;
      try {
        success = applyMapObjectUpdateFromParent(messageData["payload"]);
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
        success = applyMarkerDeleteFromParent(messageData["id"]);
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

// 親ウィンドウへ画像プレビュー表示要求を送る
function callParent(filename) {
  window.parent.postMessage(
    { type: "callParentFunction", message: filename },
    "*",
  );
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

// 親ウィンドウへログイン画面遷移要求を送る
function callParentLogin() {
  window.parent.postMessage(
    { type: "callParentLoginRedirect", message: "Token expired" },
    "*",
  );
}

// トークンの認可管理と新規発行（認証切れ時の再試行を含めた fetch ラッパー）
async function fetchWithAuth(url, options = {}) {
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
