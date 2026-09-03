interface ViewportBounds {
  contains?(latLng: unknown): boolean;
  intersects?(bounds: unknown): boolean;
}

interface ViewportLayer {
  closeTooltip?(): void;
  getBounds?(): unknown;
  getLatLng?(): unknown;
  getTooltip?(): unknown;
  isMeasurementLabel?: boolean;
  openTooltip?(): void;
  shapeName?: unknown;
  unbindTooltip?(): void;
}

interface ViewportMap {
  getBounds?(): ViewportBounds;
  getZoom?(): unknown;
  hasLayer?(layer: ViewportLayer): boolean;
  off(eventNames: string, listener: () => void): void;
  on(eventNames: string, listener: () => void): void;
}

type LayerCollection =
  | Iterable<ViewportLayer>
  | Record<string, ViewportLayer>
  | null
  | undefined;

type LayerSource = LayerCollection | (() => LayerCollection);

interface ShapeLabelManagerOptions {
  bindLabel(layer: ViewportLayer, latLng: unknown): void;
  enabled?: boolean;
  getLabelLatLng(layer: ViewportLayer): unknown;
  getLayers: LayerSource;
  map: ViewportMap;
  minZoom?: number;
  renderThreshold?: number;
  shouldBind?: (layer: ViewportLayer) => boolean;
}

interface ShapeMeasurementManagerOptions {
  attachMarkers?: (layer: ViewportLayer, bounds: ViewportBounds) => void;
  enabled?: boolean;
  getLayers: LayerSource;
  isLayerVisible?: (layer: ViewportLayer) => boolean;
  map: ViewportMap;
  removeMarkers?: (layer: ViewportLayer) => void;
}

interface ShapeViewportDependencies {
  cancelFrame?: (handle: number) => void;
  getShapeRecords(records: unknown): unknown[];
  scheduleFrame?: (callback: () => void) => number;
}

const DEFAULT_SHAPE_NAME_MIN_ZOOM = 8;
const SHAPE_NAME_RENDER_THRESHOLD = 50;
const INITIAL_SHAPE_RENDER_THRESHOLD = 400;

function listLayers(source: LayerSource): ViewportLayer[] {
  const layers = typeof source === "function" ? source() : source;
  if (!layers) return [];
  if (Symbol.iterator in Object(layers)) {
    return Array.from(layers as Iterable<ViewportLayer>);
  }
  return Object.values(layers as Record<string, ViewportLayer>);
}

export function createShapeViewportRuntime({
  cancelFrame = (handle) => {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle);
    }
  },
  getShapeRecords,
  scheduleFrame = (callback) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : window.setTimeout(callback, 0),
}: ShapeViewportDependencies) {
  const shouldSuppressInitialShapeRendering = (
    shapeRecords: unknown,
    threshold = INITIAL_SHAPE_RENDER_THRESHOLD,
  ): boolean => getShapeRecords(shapeRecords).length > threshold;

  const createViewportShapeLabelManager = ({
    map,
    getLayers,
    getLabelLatLng,
    bindLabel,
    shouldBind = () => true,
    minZoom = DEFAULT_SHAPE_NAME_MIN_ZOOM,
    renderThreshold = SHAPE_NAME_RENDER_THRESHOLD,
    enabled = true,
  }: ShapeLabelManagerOptions) => {
    const labelLatLngCache = new WeakMap<ViewportLayer, unknown>();
    const boundLayers = new Set<ViewportLayer>();
    let isZooming = false;
    let isEnabled = Boolean(enabled);
    let focusedLayer: ViewportLayer | null = null;
    let scheduledFrame: number | null = null;

    const unbindLabel = (layer: ViewportLayer) => {
      if (layer?.unbindTooltip && layer.getTooltip?.()) layer.unbindTooltip();
      boundLayers.delete(layer);
    };

    const unbindAllLabels = () => {
      Array.from(boundLayers).forEach(unbindLabel);
    };

    const getCachedLabelLatLng = (layer: ViewportLayer): unknown => {
      if (!labelLatLngCache.has(layer)) {
        labelLatLngCache.set(layer, getLabelLatLng(layer) || null);
      }
      return labelLatLngCache.get(layer);
    };

    const refresh = () => {
      if (isZooming || !map || typeof map.getBounds !== "function") return;
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
      const candidates: Array<{ layer: ViewportLayer; labelLatLng: unknown }> = [];
      if (isEnabled && isDetailedZoom) {
        for (const layer of listLayers(getLayers)) {
          if (!layer || layer.isMeasurementLabel === true) continue;
          const canShowLayer = Boolean(map.hasLayer?.(layer) && shouldBind(layer));
          const labelLatLng = canShowLayer
            ? getCachedLabelLatLng(layer)
            : null;
          const isVisible = Boolean(
            canShowLayer && labelLatLng && bounds?.contains?.(labelLatLng),
          );
          if (!isVisible) continue;

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
        focusedName &&
          map.hasLayer?.(focusedLayer!) &&
          shouldBind(focusedLayer!),
      );
      const focusedLabelLatLng = canShowFocusedLayer
        ? getCachedLabelLatLng(focusedLayer!)
        : null;
      if (
        focusedLabelLatLng &&
        bounds?.contains?.(focusedLabelLatLng) &&
        !candidates.some(({ layer }) => layer === focusedLayer)
      ) {
        candidates.push({
          layer: focusedLayer!,
          labelLatLng: focusedLabelLatLng,
        });
      }

      const candidateLayers = new Set(candidates.map(({ layer }) => layer));
      Array.from(boundLayers).forEach((layer) => {
        if (!candidateLayers.has(layer)) unbindLabel(layer);
      });

      candidates.forEach(({ layer, labelLatLng }) => {
        if (!layer.getTooltip?.()) bindLabel(layer, labelLatLng);
        if (layer.getTooltip?.() && layer.openTooltip) {
          boundLayers.add(layer);
          layer.openTooltip();
        }
      });
    };

    const cancelScheduledRefresh = () => {
      if (scheduledFrame === null) return;
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
    };

    const scheduleRefresh = () => {
      if ((!isEnabled && !focusedLayer) || isZooming || scheduledFrame !== null) {
        return;
      }
      scheduledFrame = scheduleFrame(() => {
        scheduledFrame = null;
        refresh();
      });
    };

    const closeForZoom = () => {
      isZooming = true;
      cancelScheduledRefresh();
      boundLayers.forEach((layer) => {
        if (layer?.getTooltip?.() && layer.closeTooltip) layer.closeTooltip();
      });
    };

    const finishZoom = () => {
      isZooming = false;
      scheduleRefresh();
    };

    const invalidate = (layer: ViewportLayer | null | undefined) => {
      if (!layer) return;
      labelLatLngCache.delete(layer);
      unbindLabel(layer);
      scheduleRefresh();
    };

    const setEnabled = (nextValue: boolean) => {
      const nextEnabled = Boolean(nextValue);
      if (isEnabled === nextEnabled) {
        if (isEnabled || focusedLayer) scheduleRefresh();
        return;
      }
      isEnabled = nextEnabled;
      if (!isEnabled) {
        cancelScheduledRefresh();
        if (focusedLayer) refresh();
        else unbindAllLabels();
        return;
      }
      scheduleRefresh();
    };

    const setFocusedLayer = (layer: ViewportLayer | null | undefined) => {
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
  };

  const createViewportShapeMeasurementManager = ({
    map,
    getLayers,
    attachMarkers,
    removeMarkers,
    isLayerVisible = (layer) => Boolean(map?.hasLayer?.(layer)),
    enabled = false,
  }: ShapeMeasurementManagerOptions) => {
    let isEnabled = Boolean(enabled);
    let isZooming = false;
    let scheduledFrame: number | null = null;

    const removeAllMarkers = () => {
      listLayers(getLayers).forEach((layer) => removeMarkers?.(layer));
    };

    const intersectsViewport = (
      layer: ViewportLayer,
      bounds: ViewportBounds,
    ): boolean => {
      const layerBounds = layer?.getBounds?.();
      if (layerBounds && typeof bounds?.intersects === "function") {
        return bounds.intersects(layerBounds);
      }
      const latLng = layer?.getLatLng?.();
      return Boolean(latLng && bounds?.contains?.(latLng));
    };

    const refresh = () => {
      if (isZooming || !map || typeof map.getBounds !== "function") return;
      const bounds = map.getBounds();
      listLayers(getLayers).forEach((layer) => {
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
      if (scheduledFrame === null) return;
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
    };

    const scheduleRefresh = () => {
      if (!isEnabled || isZooming || scheduledFrame !== null) return;
      scheduledFrame = scheduleFrame(() => {
        scheduledFrame = null;
        refresh();
      });
    };

    const closeForZoom = () => {
      isZooming = true;
      cancelScheduledRefresh();
      if (isEnabled) removeAllMarkers();
    };

    const finishZoom = () => {
      isZooming = false;
      if (isEnabled) scheduleRefresh();
    };

    const setEnabled = (nextValue: boolean) => {
      isEnabled = Boolean(nextValue);
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

    return { destroy, refresh, scheduleRefresh, setEnabled };
  };

  return {
    createViewportShapeLabelManager,
    createViewportShapeMeasurementManager,
    shouldSuppressInitialShapeRendering,
  };
}
