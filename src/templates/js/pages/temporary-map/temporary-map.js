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
map.addControl(
  createLayerBulkToggleControl({
    map,
    overlayLayers: layerControlOverlayLayers,
  }),
);
syncAllShapeGroupsVisibility();
map.on("overlayadd", function (event) {
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(true);
    return;
  }
  if (event.layer === shapeVisibilityLayer) {
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
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(false);
    return;
  }
  if (event.layer === shapeVisibilityLayer) {
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

// ツールチップの制御
const TooltipVisibleControl = L.Control.extend({
  options: {
    position: "topright",
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
    position: "topright",
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

if (hasSharedShapes) {
  map.addControl(new MeasurementVisibleControl());
}

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

// 地図に検索コントロールを追加
map.addControl(createCodeSearchControl());
map.addControl(
  createMarkerSearchControl({
    markerRecords: markersObj,
    markers: markers,
    clusterGroups: clusterGroups,
    // 検索時も表示用グループの再構築へ委譲する
    onSearch: setMapObjectSearchQuery,
    onClear: clearMapObjectSearch,
  }),
);

const userLocationLayer = initializeUserLocation(map);
const mapVisibilityOverlays = {
  マーカー: visibleMarkerGroup,
};
if (hasSharedShapes) {
  mapVisibilityOverlays["図形"] = shapeVisibilityLayer;
  mapVisibilityOverlays["図形名"] = shapeNameVisibilityLayer;
}
if (userLocationLayer) {
  mapVisibilityOverlays["現在位置"] = userLocationLayer;
}
if (Object.keys(mapVisibilityOverlays).length > 0) {
  const mapVisibilityControl = L.control.layers(null, mapVisibilityOverlays, {
    collapsed: false,
    position: "topleft",
  });
  mapVisibilityControl.addTo(map);
}
