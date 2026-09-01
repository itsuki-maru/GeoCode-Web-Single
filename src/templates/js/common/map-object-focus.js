const mapObjectFocusController = (() => {
  let focusedShapeLayer = null;
  let focusedShapeLayerIsTemporary = false;

  function clearFocusedShapeFocus(targetLayer = null) {
    if (
      !focusedShapeLayer ||
      (targetLayer && focusedShapeLayer !== targetLayer)
    ) {
      return;
    }

    shapeNameLabelManager?.setFocusedLayer(null);
    if (focusedShapeLayerIsTemporary && map.hasLayer(focusedShapeLayer)) {
      map.removeLayer(focusedShapeLayer);
    }
    if (map && typeof map.closePopup === "function") {
      map.closePopup();
    }
    focusedShapeLayer = null;
    focusedShapeLayerIsTemporary = false;
  }

  function releaseFocusedShapeToVisibleGroup() {
    if (!focusedShapeLayer) {
      return;
    }

    shapeNameLabelManager?.setFocusedLayer(null);
    if (!drawnShapesGroup.hasLayer(focusedShapeLayer)) {
      map.removeLayer(focusedShapeLayer);
    }
    focusedShapeLayer = null;
    focusedShapeLayerIsTemporary = false;
  }

  function onFocusMarker(markerId, lat, lng) {
    clearFocusedShapeFocus();
    if (lat === "" || lng == "") {
      console.log("Not value.");
      return;
    }
    if (isValidCoordinate(lat, lng)) {
      const latLng = new L.LatLng(lat, lng);
      map.setView(latLng, 16);
      if (!markerId) {
        return;
      }

      const marker = markers[`marker-${markerId}`];
      if (!marker) {
        return;
      }
      if (!markersClusterGroup.hasLayer(marker)) {
        markersClusterGroup.addLayer(marker);
      }

      if (typeof markersClusterGroup.zoomToShowLayer === "function") {
        markersClusterGroup.zoomToShowLayer(marker, () => {
          openMarkerPopup(markerId);
        });
      } else {
        openMarkerPopup(markerId);
      }
    }
  }

  function onFocusShape(shapeIdValue, lat, lng) {
    clearFocusedShapeFocus();
    if (map && typeof map.closePopup === "function") {
      map.closePopup();
    }
    if (lat === "" || lng === "" || !isValidCoordinate(lat, lng)) {
      console.log("Not value.");
      return;
    }

    const latLng = new L.LatLng(lat, lng);
    map.setView(latLng, 16);
    const shapeId = String(shapeIdValue || "");
    if (!shapeId) {
      return;
    }

    const targetLayer = Array.from(searchableShapeLayers).find(
      (shapeLayer) => String(shapeLayer?.shapeId || "") === shapeId,
    );
    if (!targetLayer || targetLayer.isDeletedShape) {
      return;
    }

    focusedShapeLayer = targetLayer;
    focusedShapeLayerIsTemporary = !map.hasLayer(targetLayer);
    if (focusedShapeLayerIsTemporary) {
      targetLayer.addTo(map);
    }
    shapeNameLabelManager?.setFocusedLayer(
      normalizeShapeName(targetLayer.shapeName) ? targetLayer : null,
    );
    openShapeMemoPopup(targetLayer, latLng);
  }

  function focusMapObject(objectType, id, lat, lng) {
    if (objectType === "shape") {
      onFocusShape(id, lat, lng);
      return;
    }
    onFocusMarker(id, lat, lng);
  }

  map.on("overlayadd", (event) => {
    if (event.layer === drawnShapesGroup) {
      releaseFocusedShapeToVisibleGroup();
    }
  });
  map.on("overlayremove", (event) => {
    if (event.layer === drawnShapesGroup) {
      clearFocusedShapeFocus();
    }
  });

  return { clearFocusedShapeFocus, focusMapObject };
})();

function clearFocusedShapeFocus(targetLayer = null) {
  mapObjectFocusController.clearFocusedShapeFocus(targetLayer);
}

function focusMapObject(objectType, id, lat, lng) {
  mapObjectFocusController.focusMapObject(objectType, id, lat, lng);
}
