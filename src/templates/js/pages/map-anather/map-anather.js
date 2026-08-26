function setMapObjectSearchQuery(query) {
  layeredMarkerDisplay.setSearchQuery(query);
  layeredShapeDisplay.setSearchQuery(query);
  syncAllShapeGroupsVisibility();
}

function clearMapObjectSearch(options = {}) {
  layeredMarkerDisplay.clearSearch(options);
  layeredShapeDisplay.clearSearch();
  syncAllShapeGroupsVisibility();
}

map.on("overlayadd", function (event) {
  if (event.layer === visibleMarkerGroup) {
    saveMarkerVisibility(true);
    return;
  }
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(true);
    saveShapeNameVisibility(true);
    return;
  }
  if (event.layer === shapeVisibilityLayer) {
    saveShapeLayerVisibility(true);
    syncAllShapeGroupsVisibility();
    return;
  }

  const layerId = findLayerIdByMarkerGroup(event.layer);
  if (!layerId) {
    return;
  }

  // レイヤ切替時は検索状態を解除し、表示用グループを作り直す
  clearMapObjectSearch();

  setTimeout(() => {
    syncShapeGroupVisibility(layerId);
  }, 0);
});
map.on("overlayremove", function (event) {
  if (event.layer === visibleMarkerGroup) {
    saveMarkerVisibility(false);
    return;
  }
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(false);
    saveShapeNameVisibility(false);
    return;
  }
  if (event.layer === shapeVisibilityLayer) {
    saveShapeLayerVisibility(false);
    syncAllShapeGroupsVisibility();
    return;
  }

  const layerId = findLayerIdByMarkerGroup(event.layer);
  if (!layerId) {
    return;
  }

  layeredMarkerDisplay.rebuildVisibleMarkers();
  layeredShapeDisplay.rebuildVisibleShapes();
  syncShapeGroupVisibility(layerId);
});

// 地図に検索コントロールを追加
map.addControl(createCodeSearchControl());
map.addControl(
  createMarkerSearchControl({
    markerRecords: markersFromAxum,
    markers: markers,
    clusterGroups: clusterGroups,
    // 検索時も表示用グループの再構築へ委譲する
    onSearch: setMapObjectSearchQuery,
    onClear: clearMapObjectSearch,
  }),
);

const userLocationLayer = initializeUserLocation(map);
if (userLocationLayer && !getInitialUserLocationVisibility()) {
  map.removeLayer(userLocationLayer);
}
const mapVisibilityOverlays = {
  マーカー: visibleMarkerGroup,
  図形: shapeVisibilityLayer,
  図形名: shapeNameVisibilityLayer,
};
if (userLocationLayer) {
  mapVisibilityOverlays["現在位置"] = userLocationLayer;
}
L.control
  .layers(null, mapVisibilityOverlays, {
    collapsed: false,
    position: "topleft",
  })
  .addTo(map);
if (userLocationLayer) {
  map.on("overlayadd", function (event) {
    if (event.layer === userLocationLayer) {
      saveUserLocationVisibility(true);
    }
  });
  map.on("overlayremove", function (event) {
    if (event.layer === userLocationLayer) {
      saveUserLocationVisibility(false);
    }
  });
}

// マーカー名表示・非表示コントロールツールチップの定義
const TooltipVisibleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");

    // ラジオボタンのHTMLを動的に生成
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "マーカー名表示";

    // ボタンのクリックイベント
    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      // ここにカスタム機能を実装
      toggleTooltips();
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 地図にタイルコントロールを追加
map.addControl(new TooltipVisibleControl());

// 測定結果ラベル表示・非表示コントロールの定義
const MeasurementVisibleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create(
      "div",
      "leaflet-bar leaflet-control measurement-control",
    );

    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "図形の計測";
    const mergeButton = L.DomUtil.create(
      "button",
      "custom-control-button is-hidden",
      container,
    );
    mergeButton.id = "measurement-merge-toggle-btn";
    mergeButton.type = "button";
    mergeButton.innerHTML = "辺を結合";
    mergeButton.setAttribute("aria-pressed", "false");

    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementLabels();
    });

    L.DomEvent.on(mergeButton, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementSegmentMerge();
    });

    L.DomEvent.disableClickPropagation(container);
    updateMeasurementControlState();
    return container;
  },
});

// 地図に測定結果ラベルコントロールを追加
map.addControl(new MeasurementVisibleControl());

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
  isMeasurementVisible = !isMeasurementVisible;
  shapeMeasurementManager?.setEnabled(isMeasurementVisible);
  updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える
// 親ウィンドウへファイル表示要求を送る
function callParent(filename) {
  window.parent.postMessage(
    { type: "callParentFunction", message: filename },
    "*",
  );
}
