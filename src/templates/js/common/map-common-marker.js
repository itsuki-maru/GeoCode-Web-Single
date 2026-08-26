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

