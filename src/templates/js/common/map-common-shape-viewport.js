const DEFAULT_SHAPE_NAME_MIN_ZOOM = 8;
const SHAPE_NAME_RENDER_THRESHOLD = 50;
const INITIAL_SHAPE_RENDER_THRESHOLD = 400;

// 初回取得した図形が閾値を超える場合だけ、そのページの初期描画を抑止する
function shouldSuppressInitialShapeRendering(
  shapeRecords,
  threshold = INITIAL_SHAPE_RENDER_THRESHOLD,
) {
  return getShapeRecords(shapeRecords).length > threshold;
}

// 図形名 Tooltip をズームレベルと表示範囲に応じて必要な分だけ生成する。
function createViewportShapeLabelManager({
  map,
  getLayers,
  getLabelLatLng,
  bindLabel,
  shouldBind = () => true,
  minZoom = DEFAULT_SHAPE_NAME_MIN_ZOOM,
  renderThreshold = SHAPE_NAME_RENDER_THRESHOLD,
  enabled = true,
}) {
  const labelLatLngCache = new WeakMap();
  const boundLayers = new Set();
  let isZooming = false;
  let isEnabled = Boolean(enabled);
  let focusedLayer = null;
  let scheduledFrame = null;

  const listLayers = () => {
    const layers = typeof getLayers === "function" ? getLayers() : getLayers;
    if (!layers) {
      return [];
    }
    if (typeof layers[Symbol.iterator] === "function") {
      return Array.from(layers);
    }
    return Object.values(layers);
  };

  const unbindLabel = (layer) => {
    if (typeof layer?.unbindTooltip === "function" && layer.getTooltip?.()) {
      layer.unbindTooltip();
    }
    boundLayers.delete(layer);
  };

  const unbindAllLabels = () => {
    Array.from(boundLayers).forEach(unbindLabel);
  };

  const getCachedLabelLatLng = (layer) => {
    if (!labelLatLngCache.has(layer)) {
      labelLatLngCache.set(layer, getLabelLatLng(layer) || null);
    }
    return labelLatLngCache.get(layer);
  };

  const refresh = () => {
    if (isZooming || !map || typeof map.getBounds !== "function") {
      return;
    }
    if (!isEnabled && !focusedLayer) {
      unbindAllLabels();
      return;
    }

    const zoom = Number(map.getZoom?.());
    const isDetailedZoom = Number.isFinite(zoom) && zoom >= minZoom;
    if (!isDetailedZoom && !focusedLayer) {
      unbindAllLabels();
      return;
    }

    const bounds = map.getBounds();
    const candidates = [];
    if (isEnabled && isDetailedZoom) {
      for (const layer of listLayers()) {
        if (!layer || layer.isMeasurementLabel === true) {
          continue;
        }

        const canShowLayer = Boolean(
          map.hasLayer?.(layer) && shouldBind(layer),
        );
        const labelLatLng = canShowLayer ? getCachedLabelLatLng(layer) : null;
        const isVisible = Boolean(
          canShowLayer && labelLatLng && bounds?.contains?.(labelLatLng),
        );

        if (!isVisible) {
          continue;
        }

        candidates.push({ layer, labelLatLng });
        if (candidates.length >= renderThreshold) {
          candidates.length = 0;
          break;
        }
      }
    }

    const focusedName =
      typeof focusedLayer?.shapeName === "string"
        ? focusedLayer.shapeName.trim()
        : "";
    const canShowFocusedLayer = Boolean(
      focusedName && map.hasLayer?.(focusedLayer) && shouldBind(focusedLayer),
    );
    const focusedLabelLatLng = canShowFocusedLayer
      ? getCachedLabelLatLng(focusedLayer)
      : null;
    if (
      focusedLabelLatLng &&
      bounds?.contains?.(focusedLabelLatLng) &&
      !candidates.some(({ layer }) => layer === focusedLayer)
    ) {
      candidates.push({
        layer: focusedLayer,
        labelLatLng: focusedLabelLatLng,
      });
    }

    const candidateLayers = new Set(candidates.map(({ layer }) => layer));
    Array.from(boundLayers).forEach((layer) => {
      if (!candidateLayers.has(layer)) {
        unbindLabel(layer);
      }
    });

    candidates.forEach(({ layer, labelLatLng }) => {
      if (!layer.getTooltip?.()) {
        bindLabel(layer, labelLatLng);
      }
      if (layer.getTooltip?.() && typeof layer.openTooltip === "function") {
        boundLayers.add(layer);
        layer.openTooltip();
      }
    });
  };

  const cancelScheduledRefresh = () => {
    if (scheduledFrame === null) {
      return;
    }
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scheduledFrame);
    } else {
      clearTimeout(scheduledFrame);
    }
    scheduledFrame = null;
  };

  const scheduleRefresh = () => {
    if ((!isEnabled && !focusedLayer) || isZooming || scheduledFrame !== null) {
      return;
    }
    const run = () => {
      scheduledFrame = null;
      refresh();
    };
    scheduledFrame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : setTimeout(run, 0);
  };

  const closeForZoom = () => {
    isZooming = true;
    cancelScheduledRefresh();
    boundLayers.forEach((layer) => {
      if (layer?.getTooltip?.() && typeof layer.closeTooltip === "function") {
        layer.closeTooltip();
      }
    });
  };

  const finishZoom = () => {
    isZooming = false;
    scheduleRefresh();
  };

  const invalidate = (layer) => {
    if (!layer) {
      return;
    }
    labelLatLngCache.delete(layer);
    unbindLabel(layer);
    scheduleRefresh();
  };

  const setEnabled = (enabled) => {
    const nextEnabled = Boolean(enabled);
    if (isEnabled === nextEnabled) {
      if (isEnabled || focusedLayer) {
        scheduleRefresh();
      }
      return;
    }

    isEnabled = nextEnabled;
    if (!isEnabled) {
      cancelScheduledRefresh();
      if (focusedLayer) {
        refresh();
      } else {
        unbindAllLabels();
      }
      return;
    }
    scheduleRefresh();
  };

  const setFocusedLayer = (layer) => {
    const nextFocusedLayer = layer || null;
    if (focusedLayer === nextFocusedLayer) {
      scheduleRefresh();
      return;
    }

    const previousFocusedLayer = focusedLayer;
    focusedLayer = nextFocusedLayer;
    cancelScheduledRefresh();
    if (previousFocusedLayer && previousFocusedLayer !== focusedLayer) {
      unbindLabel(previousFocusedLayer);
    }
    refresh();
  };

  map.on("zoomstart", closeForZoom);
  map.on("zoomend", finishZoom);
  map.on("moveend resize overlayadd overlayremove", scheduleRefresh);

  const destroy = () => {
    cancelScheduledRefresh();
    map.off("zoomstart", closeForZoom);
    map.off("zoomend", finishZoom);
    map.off("moveend resize overlayadd overlayremove", scheduleRefresh);
  };

  return {
    destroy,
    invalidate,
    refresh,
    scheduleRefresh,
    setEnabled,
    setFocusedLayer,
  };
}

// 計測ラベルを、計測表示が有効かつ図形が表示範囲と交差する間だけ生成する
function createViewportShapeMeasurementManager({
  map,
  getLayers,
  attachMarkers,
  removeMarkers,
  isLayerVisible = (layer) => Boolean(map?.hasLayer?.(layer)),
  enabled = false,
}) {
  let isEnabled = Boolean(enabled);
  let isZooming = false;
  let scheduledFrame = null;

  const listLayers = () => {
    const layers = typeof getLayers === "function" ? getLayers() : getLayers;
    if (!layers) {
      return [];
    }
    if (typeof layers[Symbol.iterator] === "function") {
      return Array.from(layers);
    }
    return Object.values(layers);
  };

  const removeAllMarkers = () => {
    listLayers().forEach((layer) => removeMarkers?.(layer));
  };

  const intersectsViewport = (layer, bounds) => {
    const layerBounds = layer?.getBounds?.();
    if (layerBounds && typeof bounds?.intersects === "function") {
      return bounds.intersects(layerBounds);
    }
    const latLng = layer?.getLatLng?.();
    return Boolean(latLng && bounds?.contains?.(latLng));
  };

  const refresh = () => {
    if (isZooming || !map || typeof map.getBounds !== "function") {
      return;
    }

    const bounds = map.getBounds();
    listLayers().forEach((layer) => {
      removeMarkers?.(layer);
      if (
        isEnabled &&
        layer &&
        layer.isMeasurementLabel !== true &&
        isLayerVisible(layer) &&
        intersectsViewport(layer, bounds)
      ) {
        attachMarkers?.(layer, bounds);
      }
    });
  };

  const cancelScheduledRefresh = () => {
    if (scheduledFrame === null) {
      return;
    }
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scheduledFrame);
    } else {
      clearTimeout(scheduledFrame);
    }
    scheduledFrame = null;
  };

  const scheduleRefresh = () => {
    if (!isEnabled || isZooming || scheduledFrame !== null) {
      return;
    }
    const run = () => {
      scheduledFrame = null;
      refresh();
    };
    scheduledFrame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : setTimeout(run, 0);
  };

  const closeForZoom = () => {
    isZooming = true;
    cancelScheduledRefresh();
    if (isEnabled) {
      removeAllMarkers();
    }
  };

  const finishZoom = () => {
    isZooming = false;
    if (isEnabled) {
      scheduleRefresh();
    }
  };

  const setEnabled = (enabled) => {
    isEnabled = Boolean(enabled);
    cancelScheduledRefresh();
    if (!isEnabled) {
      removeAllMarkers();
      return;
    }
    scheduleRefresh();
  };

  map.on("zoomstart", closeForZoom);
  map.on("zoomend", finishZoom);
  map.on("moveend resize overlayadd overlayremove", scheduleRefresh);

  const destroy = () => {
    cancelScheduledRefresh();
    removeAllMarkers();
    map.off("zoomstart", closeForZoom);
    map.off("zoomend", finishZoom);
    map.off("moveend resize overlayadd overlayremove", scheduleRefresh);
  };

  return {
    destroy,
    refresh,
    scheduleRefresh,
    setEnabled,
  };
}

// 図形が画面と交差していても、配置座標が画面外の計測ラベルは保持しない
