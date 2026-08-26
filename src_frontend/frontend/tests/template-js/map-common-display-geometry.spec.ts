import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMapCommon, type LoadedClassicScript } from "./helpers/load-classic-script";

interface LayerGroup {
  addLayer: ReturnType<typeof vi.fn>;
  clearLayers: ReturnType<typeof vi.fn>;
}

function layerGroup(): LayerGroup {
  return {
    addLayer: vi.fn(),
    clearLayers: vi.fn(),
  };
}

type DisplayApi = {
  bindPolylineHoverHighlight: (
    layer: unknown,
    options?: { restoreStyle?: (layer: unknown) => void },
  ) => void;
  calculateProjectedPolygonArea: (points: unknown[]) => number;
  createLayeredMarkerDisplayManager: (options: Record<string, unknown>) => {
    clearSearch: (options?: { clearInput?: boolean }) => void;
    findLayerIdByVisibilityGroup: (group: unknown) => string | null;
    rebuildVisibleMarkers: () => void;
    setSearchQuery: (query: string) => void;
  };
  createViewportShapeLabelManager: (options: Record<string, unknown>) => {
    destroy: () => void;
    invalidate: (layer: unknown) => void;
    refresh: () => void;
    scheduleRefresh: () => void;
    setEnabled: (enabled: boolean) => void;
  };
  createViewportShapeMeasurementManager: (options: Record<string, unknown>) => {
    destroy: () => void;
    refresh: () => void;
    scheduleRefresh: () => void;
    setEnabled: (enabled: boolean) => void;
  };
  filterMeasurementMarkersForBounds: (markers: unknown, bounds: unknown) => unknown[];
  createLayeredShapeDisplayManager: (options: Record<string, unknown>) => {
    clearSearch: () => void;
    setSearchQuery: (query: string) => void;
  };
  filterFlatMarkersByQuery: (options: Record<string, unknown>) => void;
  measureCircle: (layer: unknown) => { area: number; radius: number };
  restoreFlatMarkers: (options: Record<string, unknown>) => void;
  shouldSuppressInitialShapeRendering: (records: unknown, threshold?: number) => boolean;
  toggleTooltips: () => void;
  trimClosedLatLngs: (points: unknown) => unknown[];
};

const exportedNames = [
  "bindPolylineHoverHighlight",
  "calculateProjectedPolygonArea",
  "createLayeredMarkerDisplayManager",
  "createLayeredShapeDisplayManager",
  "createViewportShapeLabelManager",
  "createViewportShapeMeasurementManager",
  "filterMeasurementMarkersForBounds",
  "filterFlatMarkersByQuery",
  "measureCircle",
  "restoreFlatMarkers",
  "shouldSuppressInitialShapeRendering",
  "toggleTooltips",
  "trimClosedLatLngs",
] as const;

let loaded: LoadedClassicScript<DisplayApi> | undefined;

afterEach(() => {
  loaded?.dom.window.close();
  loaded = undefined;
});

describe("map-commonのマーカー表示管理", () => {
  it("マーカー名表示の切替では図形名Tooltipを開かない", () => {
    const markerLayer = {
      getTooltip: () => ({}),
      openTooltip: vi.fn(),
    };
    const shapeLayer = {
      getTooltip: () => ({}),
      isShapeNameLayer: true,
      openTooltip: vi.fn(),
    };
    const map = {
      eachLayer: (callback: (layer: unknown) => void) => {
        callback(markerLayer);
        callback(shapeLayer);
      },
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      globals: { isTooltipVisible: false, map },
    });

    loaded.api.toggleTooltips();

    expect(markerLayer.openTooltip).toHaveBeenCalledOnce();
    expect(shapeLayer.openTooltip).not.toHaveBeenCalled();
  });

  it("レイヤーの表示状態と検索条件から表示マーカーを再構築する", () => {
    const visibilityA = {};
    const visibilityB = {};
    const markerA = { id: "marker-a" };
    const markerB = { id: "marker-b" };
    const visibleMarkerGroup = layerGroup();
    const map = {
      addLayer: vi.fn(),
      closePopup: vi.fn(),
      hasLayer: vi.fn((layer) => layer === visibilityA),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });

    const manager = loaded.api.createLayeredMarkerDisplayManager({
      layerVisibilityGroups: { a: visibilityA, b: visibilityB },
      map,
      markerRecords: {
        first: { id: "a", layer_id: "a", marker_name: "Tokyo" },
        second: { id: "b", layer_id: "b", marker_name: "Osaka" },
      },
      markers: { "marker-a": markerA, "marker-b": markerB },
      visibleMarkerGroup,
    });

    manager.rebuildVisibleMarkers();
    expect(visibleMarkerGroup.clearLayers).toHaveBeenCalledOnce();
    expect(visibleMarkerGroup.addLayer).toHaveBeenCalledExactlyOnceWith(markerA);
    expect(manager.findLayerIdByVisibilityGroup(visibilityB)).toBe("b");

    visibleMarkerGroup.addLayer.mockClear();
    manager.setSearchQuery("osaka");
    expect(visibleMarkerGroup.addLayer).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(map.closePopup).toHaveBeenCalled();
  });

  it("検索入力を消去して表示対象のマーカーを復元する", () => {
    const visibility = {};
    const marker = {};
    const visibleMarkerGroup = layerGroup();
    const map = {
      closePopup: vi.fn(),
      hasLayer: vi.fn(() => true),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      body: '<input id="custom-search" value="Tokyo">',
      globals: { map },
    });
    const manager = loaded.api.createLayeredMarkerDisplayManager({
      inputId: "custom-search",
      layerVisibilityGroups: { a: visibility },
      map,
      markerRecords: { first: { id: "a", layer_id: "a" } },
      markers: { "marker-a": marker },
      visibleMarkerGroup,
    });

    manager.clearSearch();

    expect(
      (loaded.dom.window.document.getElementById("custom-search") as HTMLInputElement).value,
    ).toBe("");
    expect(visibleMarkerGroup.addLayer).toHaveBeenCalledWith(marker);
  });

  it("対象IDの範囲内でフラットなマーカーグループを絞り込み・復元する", () => {
    const markerA = { id: "a" };
    const markerB = { id: "b" };
    const markerC = { id: "c" };
    const markerGroup = layerGroup();
    const map = { closePopup: vi.fn() };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const options = {
      baseMarkerIds: ["a", "b"],
      markerGroup,
      markerRecords: {
        a: { id: "a", marker_name: "Tokyo" },
        b: { id: "b", marker_name: "Osaka" },
        c: { id: "c", marker_name: "Tokyo suburb" },
      },
      markers: {
        "marker-a": markerA,
        "marker-b": markerB,
        "marker-c": markerC,
      },
      query: "tokyo",
    };

    loaded.api.filterFlatMarkersByQuery(options);
    expect(markerGroup.addLayer).toHaveBeenCalledExactlyOnceWith(markerA);

    markerGroup.addLayer.mockClear();
    loaded.api.restoreFlatMarkers(options);
    expect(markerGroup.addLayer).toHaveBeenCalledTimes(2);
    expect(markerGroup.addLayer).toHaveBeenCalledWith(markerA);
    expect(markerGroup.addLayer).toHaveBeenCalledWith(markerB);
    expect(markerGroup.addLayer).not.toHaveBeenCalledWith(markerC);
  });
});

describe("map-commonの図形表示と幾何計算", () => {
  it("初期図形数が400件を超えた場合だけ初期描画を抑止する", () => {
    loaded = loadMapCommon<DisplayApi>(exportedNames);

    expect(loaded.api.shouldSuppressInitialShapeRendering(Array.from({ length: 400 }))).toBe(false);
    expect(loaded.api.shouldSuppressInitialShapeRendering(Array.from({ length: 401 }))).toBe(true);
    expect(
      loaded.api.shouldSuppressInitialShapeRendering(
        Object.fromEntries(Array.from({ length: 401 }, (_, index) => [String(index), {}])),
      ),
    ).toBe(true);
  });

  it("計測ONまで生成せず、表示中かつ画面と交差する図形だけを生成する", () => {
    const handlers = new Map<string, () => void>();
    const insideLayer = { getBounds: () => ({ inside: true }) };
    const outsideLayer = { getBounds: () => ({ inside: false }) };
    const hiddenLayer = { getBounds: () => ({ inside: true }) };
    const attachMarkers = vi.fn();
    const removeMarkers = vi.fn();
    const map = {
      getBounds: () => ({
        intersects: (bounds: { inside: boolean }) => bounds.inside,
      }),
      hasLayer: (layer: unknown) => layer !== hiddenLayer,
      off: vi.fn(),
      on: vi.fn((eventNames: string, handler: () => void) => {
        eventNames.split(" ").forEach((eventName) => handlers.set(eventName, handler));
      }),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const manager = loaded.api.createViewportShapeMeasurementManager({
      attachMarkers,
      getLayers: () => [insideLayer, outsideLayer, hiddenLayer],
      map,
      removeMarkers,
    });

    manager.refresh();
    expect(attachMarkers).not.toHaveBeenCalled();

    manager.setEnabled(true);
    manager.refresh();
    expect(attachMarkers).toHaveBeenCalledExactlyOnceWith(insideLayer, expect.any(Object));
    expect(removeMarkers).toHaveBeenCalledWith(insideLayer);
    expect(removeMarkers).toHaveBeenCalledWith(outsideLayer);
    expect(removeMarkers).toHaveBeenCalledWith(hiddenLayer);

    attachMarkers.mockClear();
    handlers.get("zoomstart")?.();
    expect(attachMarkers).not.toHaveBeenCalled();
    handlers.get("zoomend")?.();

    manager.setEnabled(false);
    expect(removeMarkers).toHaveBeenCalled();
    manager.destroy();
  });

  it("配置座標が画面内にある計測ラベルだけを残す", () => {
    const insideMarker = { getLatLng: () => ({ inside: true }) };
    const outsideMarker = { getLatLng: () => ({ inside: false }) };
    loaded = loadMapCommon<DisplayApi>(exportedNames);

    expect(
      loaded.api.filterMeasurementMarkersForBounds([insideMarker, outsideMarker], {
        contains: (latLng: { inside: boolean }) => latLng.inside,
      }),
    ).toEqual([insideMarker]);
  });

  it("マウスホバー中だけ細い折れ線を太くして元のスタイルへ戻す", () => {
    const handlers = new Map<string, () => void>();
    const layer = {
      on: vi.fn((eventName: string, handler: () => void) => {
        handlers.set(eventName, handler);
      }),
      options: { weight: 1 },
      setStyle: vi.fn((style: { weight: number }) => {
        layer.options.weight = style.weight;
      }),
      shapeStyle: { weight: 1 },
      shapeType: "polyline",
    };
    const restoreStyle = vi.fn();
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      globals: {
        matchMedia: vi.fn(() => ({ matches: true })),
      },
    });

    loaded.api.bindPolylineHoverHighlight(layer, { restoreStyle });
    handlers.get("mouseover")?.();
    expect(layer.setStyle).toHaveBeenCalledWith({ weight: 8 });

    handlers.get("mouseout")?.();
    expect(restoreStyle).toHaveBeenCalledExactlyOnceWith(layer);
  });

  it("マウスホバー非対応環境では折れ線を強調しない", () => {
    const handlers = new Map<string, () => void>();
    const layer = {
      on: vi.fn((eventName: string, handler: () => void) => {
        handlers.set(eventName, handler);
      }),
      options: { weight: 1 },
      setStyle: vi.fn(),
      shapeStyle: { weight: 1 },
      shapeType: "polyline",
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      globals: {
        matchMedia: vi.fn(() => ({ matches: false })),
      },
    });

    loaded.api.bindPolylineHoverHighlight(layer);
    handlers.get("mouseover")?.();

    expect(layer.setStyle).not.toHaveBeenCalled();
  });

  it("折れ線以外にはホバーイベントを登録しない", () => {
    const layer = {
      on: vi.fn(),
      setStyle: vi.fn(),
      shapeType: "polygon",
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames);

    loaded.api.bindPolylineHoverHighlight(layer);

    expect(layer.on).not.toHaveBeenCalled();
  });

  it("ズーム8以上で代表座標が表示範囲内の図形名だけを生成する", () => {
    let zoom = 7;
    const insidePoint = { inside: true };
    const outsidePoint = { inside: false };
    const createShapeLayer = (point: { inside: boolean }) => {
      let tooltip: object | null = null;
      return {
        closeTooltip: vi.fn(),
        getTooltip: vi.fn(() => tooltip),
        labelPoint: point,
        openTooltip: vi.fn(),
        setTooltip: () => {
          tooltip = {};
        },
        unbindTooltip: vi.fn(() => {
          tooltip = null;
        }),
      };
    };
    const insideLayer = createShapeLayer(insidePoint);
    const outsideLayer = createShapeLayer(outsidePoint);
    const bindLabel = vi.fn((layer: ReturnType<typeof createShapeLayer>) => {
      layer.setTooltip();
    });
    const getLabelLatLng = vi.fn((layer: ReturnType<typeof createShapeLayer>) => layer.labelPoint);
    const map = {
      getBounds: () => ({ contains: (point: { inside: boolean }) => point.inside }),
      getZoom: () => zoom,
      hasLayer: vi.fn(() => true),
      off: vi.fn(),
      on: vi.fn(),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const manager = loaded.api.createViewportShapeLabelManager({
      bindLabel,
      getLabelLatLng,
      getLayers: () => [insideLayer, outsideLayer],
      map,
    });

    manager.refresh();
    expect(bindLabel).not.toHaveBeenCalled();
    expect(getLabelLatLng).not.toHaveBeenCalled();

    zoom = 8;
    manager.refresh();
    expect(bindLabel).toHaveBeenCalledExactlyOnceWith(insideLayer, insidePoint);
    expect(insideLayer.openTooltip).toHaveBeenCalledOnce();
    expect(outsideLayer.openTooltip).not.toHaveBeenCalled();

    insidePoint.inside = false;
    manager.refresh();
    expect(insideLayer.unbindTooltip).toHaveBeenCalledOnce();
  });

  it("表示候補が49件なら描画し、50件に達すると既存ラベルも全解除する", () => {
    const createShapeLayer = () => {
      let tooltip: object | null = null;
      return {
        getTooltip: vi.fn(() => tooltip),
        openTooltip: vi.fn(),
        setTooltip: () => {
          tooltip = {};
        },
        unbindTooltip: vi.fn(() => {
          tooltip = null;
        }),
      };
    };
    const layers = Array.from({ length: 49 }, createShapeLayer);
    const bindLabel = vi.fn((layer: ReturnType<typeof createShapeLayer>) => {
      layer.setTooltip();
    });
    const map = {
      getBounds: () => ({ contains: () => true }),
      getZoom: () => 8,
      hasLayer: () => true,
      off: vi.fn(),
      on: vi.fn(),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const manager = loaded.api.createViewportShapeLabelManager({
      bindLabel,
      getLabelLatLng: () => ({ lat: 35, lng: 139 }),
      getLayers: () => layers,
      map,
    });

    manager.refresh();
    expect(bindLabel).toHaveBeenCalledTimes(49);

    const fiftiethLayer = createShapeLayer();
    layers.push(fiftiethLayer);
    manager.refresh();
    expect(bindLabel).toHaveBeenCalledTimes(49);
    layers.slice(0, 49).forEach((layer) => {
      expect(layer.unbindTooltip).toHaveBeenCalledOnce();
    });
    expect(fiftiethLayer.getTooltip()).toBeNull();

    layers.pop();
    manager.refresh();
    expect(bindLabel).toHaveBeenCalledTimes(98);
  });

  it("50件へ到達した時点で候補収集を打ち切り、Tooltipを一件も生成しない", () => {
    const layers = Array.from({ length: 60 }, () => ({
      getTooltip: vi.fn(() => null),
      openTooltip: vi.fn(),
      unbindTooltip: vi.fn(),
    }));
    const bindLabel = vi.fn();
    const getLabelLatLng = vi.fn(() => ({ lat: 35, lng: 139 }));
    const map = {
      getBounds: () => ({ contains: () => true }),
      getZoom: () => 8,
      hasLayer: () => true,
      off: vi.fn(),
      on: vi.fn(),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const manager = loaded.api.createViewportShapeLabelManager({
      bindLabel,
      getLabelLatLng,
      getLayers: () => layers,
      map,
    });

    manager.refresh();

    expect(getLabelLatLng).toHaveBeenCalledTimes(50);
    expect(bindLabel).not.toHaveBeenCalled();
  });

  it("ズーム開始時に図形名を閉じ、終了後の更新を一度だけ予約する", () => {
    const handlers = new Map<string, () => void>();
    let scheduledCallback: (() => void) | null = null;
    const requestAnimationFrame = vi.fn((callback: () => void) => {
      scheduledCallback = callback;
      return 1;
    });
    let tooltip: object | null = null;
    const layer = {
      closeTooltip: vi.fn(),
      getTooltip: vi.fn(() => tooltip),
      openTooltip: vi.fn(),
      unbindTooltip: vi.fn(() => {
        tooltip = null;
      }),
    };
    const map = {
      getBounds: () => ({ contains: () => true }),
      getZoom: () => 16,
      hasLayer: () => true,
      off: vi.fn(),
      on: vi.fn((events: string, handler: () => void) => handlers.set(events, handler)),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      globals: { map, requestAnimationFrame },
    });
    const manager = loaded.api.createViewportShapeLabelManager({
      bindLabel: () => {
        tooltip = {};
      },
      getLabelLatLng: () => ({ lat: 35, lng: 139 }),
      getLayers: () => [layer],
      map,
    });
    manager.refresh();
    layer.openTooltip.mockClear();

    handlers.get("zoomstart")?.();
    expect(layer.closeTooltip).toHaveBeenCalledOnce();
    manager.scheduleRefresh();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    handlers.get("zoomend")?.();
    handlers.get("moveend resize overlayadd overlayremove")?.();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(layer.openTooltip).not.toHaveBeenCalled();

    scheduledCallback?.();
    expect(layer.openTooltip).toHaveBeenCalledOnce();
  });

  it("図形名を無効化すると即座に解除し、再有効化まで更新しても表示しない", () => {
    let scheduledCallback: (() => void) | null = null;
    const requestAnimationFrame = vi.fn((callback: () => void) => {
      scheduledCallback = callback;
      return 1;
    });
    let tooltip: object | null = null;
    const layer = {
      getTooltip: vi.fn(() => tooltip),
      openTooltip: vi.fn(),
      unbindTooltip: vi.fn(() => {
        tooltip = null;
      }),
    };
    const map = {
      getBounds: () => ({ contains: () => true }),
      getZoom: () => 16,
      hasLayer: () => true,
      off: vi.fn(),
      on: vi.fn(),
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, {
      globals: { map, requestAnimationFrame },
    });
    const bindLabel = vi.fn(() => {
      tooltip = {};
    });
    const manager = loaded.api.createViewportShapeLabelManager({
      bindLabel,
      getLabelLatLng: () => ({ lat: 35, lng: 139 }),
      getLayers: () => [layer],
      map,
    });
    manager.refresh();

    manager.setEnabled(false);
    expect(layer.unbindTooltip).toHaveBeenCalledOnce();
    manager.refresh();
    manager.scheduleRefresh();
    expect(bindLabel).toHaveBeenCalledOnce();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    manager.setEnabled(true);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    scheduledCallback?.();
    expect(bindLabel).toHaveBeenCalledTimes(2);
  });

  it("検索に一致する図形と付随する計測マーカーを一緒に表示する", () => {
    const groupA = layerGroup();
    const groupB = layerGroup();
    const measurementMarker = { id: "measurement" };
    const matchingShape = { measurementMarkers: [measurementMarker] };
    const hiddenShape = {};
    const map = { closePopup: vi.fn() };
    const onRebuild = vi.fn();
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });
    const manager = loaded.api.createLayeredShapeDisplayManager({
      isLayerVisible: (layerId: string) => layerId === "a",
      map,
      shapeGroups: { a: groupA, b: groupB },
      shapeLayers: {
        "shape-1": matchingShape,
        "shape-2": hiddenShape,
      },
      shapeRecords: [
        { id: 1, layer_id: "a", name: "Evacuation Route" },
        { id: 2, layer_id: "b", name: "Evacuation Route" },
      ],
      onRebuild,
    });

    manager.setSearchQuery("evacuation");

    expect(groupA.addLayer).toHaveBeenCalledWith(matchingShape);
    expect(groupA.addLayer).toHaveBeenCalledWith(measurementMarker);
    expect(groupB.addLayer).not.toHaveBeenCalled();
    expect(map.closePopup).toHaveBeenCalledOnce();
    expect(onRebuild).toHaveBeenCalledOnce();
  });

  it("元配列を変更せず重複した閉じ頂点を取り除く", () => {
    loaded = loadMapCommon<DisplayApi>(exportedNames);
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 2, lng: 0 },
      { lat: 0, lng: 0 },
    ];

    const trimmed = loaded.api.trimClosedLatLngs(points);

    expect(trimmed).toHaveLength(3);
    expect(points).toHaveLength(4);
    expect(loaded.api.trimClosedLatLngs(null)).toEqual([]);
  });

  it("投影座標上のポリゴン面積と円の面積を計算する", () => {
    const map = {
      options: {
        crs: {
          project: ({ lat, lng }: { lat: number; lng: number }) => ({
            x: lng,
            y: lat,
          }),
        },
      },
    };
    loaded = loadMapCommon<DisplayApi>(exportedNames, { globals: { map } });

    expect(
      loaded.api.calculateProjectedPolygonArea([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 4 },
        { lat: 3, lng: 0 },
      ]),
    ).toBe(6);
    expect(loaded.api.calculateProjectedPolygonArea([{ lat: 0, lng: 0 }])).toBe(0);

    const circle = loaded.api.measureCircle({ getRadius: () => 10 });
    expect(circle.radius).toBe(10);
    expect(circle.area).toBeCloseTo(Math.PI * 100);
  });
});
