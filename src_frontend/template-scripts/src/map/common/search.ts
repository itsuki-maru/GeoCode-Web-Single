export interface SearchMarkerRecord {
  detail?: unknown;
  id?: string | number;
  latitude?: unknown;
  layer_id?: string | null;
  longitude?: unknown;
  marker_name?: unknown;
}

export interface SearchShapeRecord {
  geojson?: { properties?: { memo?: unknown } };
  id?: string | number;
  layer_id?: string | null;
  name?: unknown;
}

interface MeasurementMarker {
  getLatLng?(): unknown;
}

interface Bounds {
  contains(latLng: unknown): boolean;
}

interface SearchMap {
  closePopup?(): void;
  hasLayer(layer: object): boolean;
}

interface LayerGroup<TLayer> {
  addLayer(layer: TLayer): void;
  clearLayers(): void;
}

interface SearchDisplayManager {
  clearSearch(options?: { clearInput?: boolean }): void;
  setSearchQuery(query: unknown): void;
}

interface SearchShapeLayer<TMarker> {
  measurementMarkers?: TMarker[];
}

interface RuntimeMap extends SearchMap {
  setView(latLng: object, zoom: number): void;
}

interface LeafletNamespace {
  Control: {
    extend(definition: {
      options: { position: string };
      onAdd(): HTMLElement;
    }): new () => object;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    disableScrollPropagation(element: HTMLElement): void;
    on(
      element: Element | null,
      eventName: string,
      listener: (event: Event) => void,
    ): void;
    stop(event: Event): void;
  };
  DomUtil: {
    create(tagName: string, className: string): HTMLElement;
  };
  LatLng: new (latitude: string, longitude: string) => object;
  icon(options: Record<string, unknown>): object;
  marker(
    latLng: [string, string],
    options: { icon: object },
  ): {
    addTo(map: RuntimeMap): {
      bindPopup(content: string): { openPopup(): void };
    };
  };
}

export function normalizeMarkerSearchText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function createMapObjectSearchCoordinator({
  markerDisplay,
  shapeDisplay,
  syncShapeVisibility,
}: {
  markerDisplay: SearchDisplayManager;
  shapeDisplay: SearchDisplayManager;
  syncShapeVisibility: () => void;
}) {
  const setMapObjectSearchQuery = (query: unknown): void => {
    markerDisplay.setSearchQuery(query);
    shapeDisplay.setSearchQuery(query);
    syncShapeVisibility();
  };

  const clearMapObjectSearch = (
    options: { clearInput?: boolean } = {},
  ): void => {
    markerDisplay.clearSearch(options);
    shapeDisplay.clearSearch();
    syncShapeVisibility();
  };

  return { clearMapObjectSearch, setMapObjectSearchQuery };
}

export function matchesMarkerSearch(
  record: SearchMarkerRecord | null | undefined,
  query: unknown,
): boolean {
  const normalizedQuery = normalizeMarkerSearchText(query);
  if (!normalizedQuery) return true;

  return [
    record?.marker_name,
    record?.detail,
    record?.latitude,
    record?.longitude,
  ]
    .map(normalizeMarkerSearchText)
    .join(" ")
    .includes(normalizedQuery);
}

export function matchesShapeSearch(
  record: SearchShapeRecord | null | undefined,
  query: unknown,
): boolean {
  const normalizedQuery = normalizeMarkerSearchText(query);
  if (!normalizedQuery) return true;

  return [record?.name, record?.geojson?.properties?.memo]
    .map(normalizeMarkerSearchText)
    .join(" ")
    .includes(normalizedQuery);
}

export function getShapeRecords(
  shapeRecords:
    | SearchShapeRecord[]
    | Record<string, SearchShapeRecord>
    | null
    | undefined,
): SearchShapeRecord[] {
  if (Array.isArray(shapeRecords)) return shapeRecords;
  if (shapeRecords && typeof shapeRecords === "object") {
    return Object.values(shapeRecords);
  }
  return [];
}

export function filterMeasurementMarkersForBounds<
  TMarker extends MeasurementMarker,
>(
  markers: TMarker[] | unknown,
  bounds: Bounds | null | undefined,
): TMarker[] {
  if (!Array.isArray(markers)) return [];
  if (!bounds || typeof bounds.contains !== "function") return markers;

  return markers.filter((marker) => {
    const latLng = marker?.getLatLng?.();
    return !latLng || bounds.contains(latLng);
  });
}

export function createLayeredMarkerDisplayManager<TLayer extends object>({
  map,
  markerRecords,
  markers,
  visibleMarkerGroup,
  layerVisibilityGroups,
  inputId = "marker-search-input",
}: {
  map: SearchMap;
  markerRecords: Record<string, SearchMarkerRecord>;
  markers: Record<string, TLayer>;
  visibleMarkerGroup: LayerGroup<TLayer>;
  layerVisibilityGroups: Record<string, object>;
  inputId?: string;
}) {
  let searchQuery: unknown = "";

  const isLayerVisible = (layerId: string | null | undefined): boolean => {
    if (layerId == null) return false;
    const visibilityGroup = layerVisibilityGroups[layerId];
    return Boolean(visibilityGroup && map.hasLayer(visibilityGroup));
  };

  const findLayerIdByVisibilityGroup = (targetGroup: object): string | null => {
    for (const layerId in layerVisibilityGroups) {
      if (layerVisibilityGroups[layerId] === targetGroup) return layerId;
    }
    return null;
  };

  const rebuildVisibleMarkers = (): void => {
    visibleMarkerGroup.clearLayers();
    Object.values(markerRecords).forEach((record) => {
      if (
        !isLayerVisible(record.layer_id) ||
        !matchesMarkerSearch(record, searchQuery)
      ) {
        return;
      }

      const marker = markers["marker-" + record.id];
      if (marker) visibleMarkerGroup.addLayer(marker);
    });
    map.closePopup?.();
  };

  const setSearchQuery = (query: unknown): void => {
    searchQuery = normalizeMarkerSearchText(query) ? query : "";
    rebuildVisibleMarkers();
  };

  const clearSearch = (
    { clearInput = true }: { clearInput?: boolean } = {},
  ): void => {
    searchQuery = "";
    if (clearInput) {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      if (input) input.value = "";
    }
    rebuildVisibleMarkers();
  };

  return {
    clearSearch,
    findLayerIdByVisibilityGroup,
    isLayerVisible,
    rebuildVisibleMarkers,
    setSearchQuery,
  };
}

export function createLayeredShapeDisplayManager<
  TShape extends SearchShapeLayer<TMarker>,
  TMarker extends object,
>({
  map,
  shapeRecords,
  shapeLayers,
  shapeGroups,
  isLayerVisible,
  onRebuild = null,
}: {
  map: SearchMap;
  shapeRecords: SearchShapeRecord[] | Record<string, SearchShapeRecord>;
  shapeLayers: Record<string, TShape>;
  shapeGroups: Record<string, LayerGroup<TShape | TMarker>>;
  isLayerVisible(layerId: string | null | undefined): boolean;
  onRebuild?: (() => void) | null;
}) {
  let searchQuery: unknown = "";

  const rebuildVisibleShapes = (): void => {
    Object.values(shapeGroups).forEach((group) => group.clearLayers());
    getShapeRecords(shapeRecords).forEach((record) => {
      const layerId = record.layer_id;
      const shapeLayer = shapeLayers["shape-" + record.id];
      const targetGroup = layerId == null ? undefined : shapeGroups[layerId];
      if (
        !shapeLayer ||
        !targetGroup ||
        !isLayerVisible(layerId) ||
        !matchesShapeSearch(record, searchQuery)
      ) {
        return;
      }

      targetGroup.addLayer(shapeLayer);
      shapeLayer.measurementMarkers?.forEach((marker) => {
        targetGroup.addLayer(marker);
      });
    });
    map.closePopup?.();
    onRebuild?.();
  };

  const setSearchQuery = (query: unknown): void => {
    searchQuery = normalizeMarkerSearchText(query) ? query : "";
    rebuildVisibleShapes();
  };

  const clearSearch = (): void => {
    searchQuery = "";
    rebuildVisibleShapes();
  };

  return { clearSearch, rebuildVisibleShapes, setSearchQuery };
}

interface SearchRuntimeDependencies {
  getLeaflet?: () => LeafletNamespace;
  getMap(): RuntimeMap;
  getMeasurementSegmentMerged(): boolean;
  getMeasurementVisible(): boolean;
  isValidCoordinate(latitude: string, longitude: string): boolean;
  refreshAllShapeMeasurementMarkers(): void;
  setMeasurementSegmentMerged(value: boolean): void;
}

export function createMapSearchRuntime({
  getLeaflet = () => {
    const leaflet = (window as Window & { L?: LeafletNamespace }).L;
    if (!leaflet) throw new Error("Leaflet is not loaded");
    return leaflet;
  },
  getMap,
  getMeasurementSegmentMerged,
  getMeasurementVisible,
  isValidCoordinate,
  refreshAllShapeMeasurementMarkers,
  setMeasurementSegmentMerged,
}: SearchRuntimeDependencies) {
  const restoreLayeredMarkers = <TLayer extends object>({
    markerRecords,
    markers,
    clusterGroups,
  }: {
    markerRecords?: Record<string, SearchMarkerRecord>;
    markers?: Record<string, TLayer>;
    clusterGroups?: Record<string, LayerGroup<TLayer>>;
  }): void => {
    if (!markerRecords || !markers || !clusterGroups) return;
    Object.values(clusterGroups).forEach((group) => group.clearLayers());
    Object.values(markerRecords).forEach((record) => {
      const marker = markers["marker-" + record.id];
      const targetGroup =
        record.layer_id == null ? undefined : clusterGroups[record.layer_id];
      if (marker && targetGroup) targetGroup.addLayer(marker);
    });
  };

  const clearLayeredMarkerSearch = <TLayer extends object>({
    markerRecords,
    markers,
    clusterGroups,
    inputId = "marker-search-input",
  }: {
    markerRecords?: Record<string, SearchMarkerRecord>;
    markers?: Record<string, TLayer>;
    clusterGroups?: Record<string, LayerGroup<TLayer>>;
    inputId?: string;
  }): void => {
    restoreLayeredMarkers({ markerRecords, markers, clusterGroups });
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (input) input.value = "";
    getMap().closePopup?.();
  };

  const filterLayeredMarkersByQuery = <TLayer extends object>({
    markerRecords,
    markers,
    clusterGroups,
    query,
  }: {
    markerRecords?: Record<string, SearchMarkerRecord>;
    markers?: Record<string, TLayer>;
    clusterGroups?: Record<string, LayerGroup<TLayer>>;
    query: unknown;
  }): void => {
    if (!markerRecords || !markers || !clusterGroups) return;
    if (!normalizeMarkerSearchText(query)) {
      clearLayeredMarkerSearch({ markerRecords, markers, clusterGroups });
      return;
    }

    Object.values(clusterGroups).forEach((group) => group.clearLayers());
    Object.values(markerRecords).forEach((record) => {
      const marker = markers["marker-" + record.id];
      const targetGroup =
        record.layer_id == null ? undefined : clusterGroups[record.layer_id];
      if (marker && targetGroup && matchesMarkerSearch(record, query)) {
        targetGroup.addLayer(marker);
      }
    });
    getMap().closePopup?.();
  };

  const onSearchCode = (): void => {
    const input = document.getElementById("code-input") as HTMLInputElement | null;
    const parts = input?.value.replace(/[()\s]/g, "").split(",") ?? [];
    if (parts.length !== 2) {
      console.log("Value error.");
      return;
    }

    const [latitude = "", longitude = ""] = parts;
    if (!latitude || !longitude || !isValidCoordinate(latitude, longitude)) {
      console.log("Not value.");
      return;
    }

    const leaflet = getLeaflet();
    const map = getMap();
    const latLng = new leaflet.LatLng(latitude, longitude);
    map.setView(latLng, 14);
    const icon = leaflet.icon({
      iconUrl: "/assets/marker.png",
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowUrl: null,
    });
    leaflet
      .marker([latitude, longitude], { icon })
      .addTo(map)
      .bindPopup("緯度：" + latitude + "<br>経度：" + longitude)
      .openPopup();
  };

  const createCodeSearchControl = (
    options: { position?: string } = {},
  ): object => {
    const leaflet = getLeaflet();
    const Control = leaflet.Control.extend({
      options: { position: options.position ?? "topleft" },
      onAdd() {
        const container = leaflet.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control",
        );
        container.innerHTML =
          '<div class="search-zone">' +
          '<input type="text" class="search-input" id="code-input" placeholder="緯度,経度" title="緯度経度を,区切りで入力してください。"><br>' +
          '<button id="code-search-btn" class="custom-search">座標検索</button>' +
          "</div>";
        const button = container.querySelector(".custom-search");
        leaflet.DomEvent.on(button, "click", (event) => {
          leaflet.DomEvent.stop(event);
          onSearchCode();
        });
        leaflet.DomEvent.disableClickPropagation(container);
        return container;
      },
    });
    return new Control();
  };

  const createMarkerSearchControl = <TLayer extends object>(
    options: {
      clusterGroups?: Record<string, LayerGroup<TLayer>>;
      inputId?: string;
      markerRecords?: Record<string, SearchMarkerRecord>;
      markers?: Record<string, TLayer>;
      onClear?: (options: { clearInput: boolean }) => void;
      onSearch?: (query: string) => void;
      position?: string;
    } = {},
  ): object => {
    const leaflet = getLeaflet();
    const Control = leaflet.Control.extend({
      options: { position: options.position ?? "topleft" },
      onAdd() {
        const container = leaflet.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control",
        );
        const inputId = options.inputId ?? "marker-search-input";
        container.innerHTML =
          '<div class="search-zone"><input type="text" class="search-input marker-search-input" id="' +
          inputId +
          '" placeholder="マーカー・図形検索" title="マーカー名・詳細・座標、図形名・メモを検索します。"></div>';
        const input = container.querySelector<HTMLInputElement>("#" + inputId);
        let isComposing = false;

        const search = (event?: Event): void => {
          if (event) leaflet.DomEvent.stop(event);
          if (options.onSearch) {
            options.onSearch(input?.value ?? "");
            return;
          }
          filterLayeredMarkersByQuery({
            markerRecords: options.markerRecords,
            markers: options.markers,
            clusterGroups: options.clusterGroups,
            query: input?.value ?? "",
          });
        };

        const searchFromInput = (): void => {
          if (isComposing) return;
          if (!normalizeMarkerSearchText(input?.value ?? "")) {
            if (options.onClear) {
              options.onClear({ clearInput: false });
              return;
            }
            clearLayeredMarkerSearch({
              markerRecords: options.markerRecords,
              markers: options.markers,
              clusterGroups: options.clusterGroups,
              inputId,
            });
            return;
          }
          search();
        };

        leaflet.DomEvent.on(input, "keydown", (event) => {
          if ((event as KeyboardEvent).key === "Enter") search(event);
        });
        leaflet.DomEvent.on(input, "compositionstart", () => {
          isComposing = true;
        });
        leaflet.DomEvent.on(input, "compositionend", () => {
          isComposing = false;
          searchFromInput();
        });
        leaflet.DomEvent.on(input, "input", searchFromInput);
        leaflet.DomEvent.disableClickPropagation(container);
        leaflet.DomEvent.disableScrollPropagation(container);
        return container;
      },
    });
    return new Control();
  };

  const restoreFlatMarkers = <TLayer extends object>({
    markers,
    markerGroup,
    baseMarkerIds = null,
  }: {
    markers?: Record<string, TLayer>;
    markerGroup?: LayerGroup<TLayer>;
    baseMarkerIds?: Array<string | number> | null;
  }): void => {
    if (!markers || !markerGroup) return;
    markerGroup.clearLayers();
    const allowedKeys = Array.isArray(baseMarkerIds)
      ? new Set(baseMarkerIds.map((id) => `marker-${id}`))
      : null;
    Object.entries(markers).forEach(([key, marker]) => {
      if (!allowedKeys || allowedKeys.has(key)) markerGroup.addLayer(marker);
    });
  };

  const filterFlatMarkersByQuery = <TLayer extends object>({
    markerRecords,
    markers,
    markerGroup,
    query,
    baseMarkerIds = null,
  }: {
    markerRecords?: Record<string, SearchMarkerRecord>;
    markers?: Record<string, TLayer>;
    markerGroup?: LayerGroup<TLayer>;
    query: unknown;
    baseMarkerIds?: Array<string | number> | null;
  }): void => {
    if (!markerRecords || !markers || !markerGroup) return;
    if (!normalizeMarkerSearchText(query)) {
      restoreFlatMarkers({ markers, markerGroup, baseMarkerIds });
      return;
    }

    markerGroup.clearLayers();
    const allowedKeys = Array.isArray(baseMarkerIds)
      ? new Set(baseMarkerIds.map((id) => `marker-${id}`))
      : null;
    Object.values(markerRecords).forEach((record) => {
      const markerKey = `marker-${record.id}`;
      const marker = markers[markerKey];
      if (
        marker &&
        (!allowedKeys || allowedKeys.has(markerKey)) &&
        matchesMarkerSearch(record, query)
      ) {
        markerGroup.addLayer(marker);
      }
    });
    getMap().closePopup?.();
  };

  const createFlatMarkerSearchControl = <TLayer extends object>(
    options: {
      baseMarkerIds?: Array<string | number> | null;
      getBaseMarkerIds?: () => Array<string | number> | null;
      inputId?: string;
      markerGroup?: LayerGroup<TLayer>;
      markerRecords?: Record<string, SearchMarkerRecord>;
      markers?: Record<string, TLayer>;
      onSearch?: (query: string) => void;
      position?: string;
    } = {},
  ): object => {
    const leaflet = getLeaflet();
    const Control = leaflet.Control.extend({
      options: { position: options.position ?? "topleft" },
      onAdd() {
        const container = leaflet.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control",
        );
        const inputId = options.inputId ?? "marker-search-input";
        container.innerHTML =
          '<div class="search-zone"><input type="text" class="search-input marker-search-input" id="' +
          inputId +
          '" placeholder="マーカー・図形検索" title="マーカー名・詳細・座標、図形名・メモを検索します。"></div>';
        const input = container.querySelector<HTMLInputElement>("#" + inputId);
        let isComposing = false;

        const emitSearch = (event?: Event): void => {
          if (event) leaflet.DomEvent.stop(event);
          if (options.onSearch) {
            options.onSearch(input?.value ?? "");
            return;
          }
          filterFlatMarkersByQuery({
            markerRecords: options.markerRecords,
            markers: options.markers,
            markerGroup: options.markerGroup,
            query: input?.value ?? "",
            baseMarkerIds:
              typeof options.getBaseMarkerIds === "function"
                ? options.getBaseMarkerIds()
                : options.baseMarkerIds,
          });
        };

        leaflet.DomEvent.on(input, "keydown", (event) => {
          if ((event as KeyboardEvent).key === "Enter") emitSearch(event);
        });
        leaflet.DomEvent.on(input, "compositionstart", () => {
          isComposing = true;
        });
        leaflet.DomEvent.on(input, "compositionend", () => {
          isComposing = false;
          emitSearch();
        });
        leaflet.DomEvent.on(input, "input", () => {
          if (!isComposing) emitSearch();
        });
        leaflet.DomEvent.disableClickPropagation(container);
        leaflet.DomEvent.disableScrollPropagation(container);
        return container;
      },
    });
    return new Control();
  };

  const updateMeasurementControlState = (): void => {
    const mergeButton = document.getElementById("measurement-merge-toggle-btn");
    if (!mergeButton) return;
    mergeButton.classList.toggle("is-hidden", !getMeasurementVisible());
    mergeButton.classList.toggle("is-active", getMeasurementSegmentMerged());
    mergeButton.setAttribute(
      "aria-pressed",
      getMeasurementSegmentMerged() ? "true" : "false",
    );
  };

  const toggleMeasurementSegmentMerge = (): void => {
    setMeasurementSegmentMerged(!getMeasurementSegmentMerged());
    refreshAllShapeMeasurementMarkers();
    updateMeasurementControlState();
  };

  return {
    createCodeSearchControl,
    createFlatMarkerSearchControl,
    createMarkerSearchControl,
    filterFlatMarkersByQuery,
    restoreFlatMarkers,
    toggleMeasurementSegmentMerge,
    updateMeasurementControlState,
  };
}
