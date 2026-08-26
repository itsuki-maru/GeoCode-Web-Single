const SELECTED_TILE_SERVER_STORAGE_KEY = "geocode-web:selected-tile-server-id";
const MARKER_VISIBILITY_STORAGE_KEY = "geocode-web:marker-visible";
const USER_LOCATION_VISIBILITY_STORAGE_KEY =
  "geocode-web:user-location-visible";
const SHAPE_LAYER_VISIBILITY_STORAGE_KEY = "geocode-web:shape-layer-visible";
const SHAPE_NAME_VISIBILITY_STORAGE_KEY = "geocode-web:shape-name-visible";
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

// 通常マップのマーカー表示状態を復元する。保存値がない場合は従来どおり表示する
function getInitialMarkerVisibility() {
  try {
    const savedVisibility = localStorage.getItem(MARKER_VISIBILITY_STORAGE_KEY);
    if (savedVisibility === "false") {
      return false;
    }
    if (savedVisibility === "true") {
      return true;
    }
  } catch (error) {
    console.warn("Failed to restore marker visibility:", error);
  }

  return true;
}

// マーカーの表示状態を保存する。localStorageが利用できない環境でも地図表示は継続する
function saveMarkerVisibility(isVisible) {
  try {
    localStorage.setItem(
      MARKER_VISIBILITY_STORAGE_KEY,
      isVisible ? "true" : "false",
    );
  } catch (error) {
    console.warn("Failed to save marker visibility:", error);
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

// 通常マップの図形名表示状態を復元する。保存値がない場合は表示する
function getInitialShapeNameVisibility() {
  try {
    const savedVisibility = localStorage.getItem(
      SHAPE_NAME_VISIBILITY_STORAGE_KEY,
    );
    if (savedVisibility === "false") {
      return false;
    }
    if (savedVisibility === "true") {
      return true;
    }
  } catch (error) {
    console.warn("Failed to restore shape name visibility:", error);
  }

  return true;
}

// 図形名の表示状態を保存する。localStorageが利用できない環境でも地図表示は継続する
function saveShapeNameVisibility(isVisible) {
  try {
    localStorage.setItem(
      SHAPE_NAME_VISIBILITY_STORAGE_KEY,
      isVisible ? "true" : "false",
    );
  } catch (error) {
    console.warn("Failed to save shape name visibility:", error);
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

