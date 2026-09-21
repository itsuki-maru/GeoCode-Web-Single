import { resetMapSearchStatus, showMapSearchStatus } from "./search-status";
export { resetMapSearchStatus } from "./search-status";

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
  attributionControl?: {
    addAttribution(text: string): unknown;
    removeAttribution(text: string): unknown;
  };
  setView(latLng: object, zoom: number): void;
}

interface LeafletNamespace {
  Control: {
    extend(definition: {
      options: { position: string };
      onAdd(): HTMLElement;
      onRemove?(): void;
    }): new () => object;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    disableScrollPropagation(element: HTMLElement): void;
    on(element: Element | null, eventName: string, listener: (event: Event) => void): void;
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
      remove(): void;
      bindPopup(content: string): { openPopup(): void };
    };
  };
}

export function normalizeMarkerSearchText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
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

  const clearMapObjectSearch = (options: { clearInput?: boolean } = {}): void => {
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

  return [record?.marker_name, record?.detail, record?.latitude, record?.longitude]
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
  shapeRecords: SearchShapeRecord[] | Record<string, SearchShapeRecord> | null | undefined,
): SearchShapeRecord[] {
  if (Array.isArray(shapeRecords)) return shapeRecords;
  if (shapeRecords && typeof shapeRecords === "object") {
    return Object.values(shapeRecords);
  }
  return [];
}

export function filterMeasurementMarkersForBounds<TMarker extends MeasurementMarker>(
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
      if (!isLayerVisible(record.layer_id) || !matchesMarkerSearch(record, searchQuery)) {
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

  const clearSearch = ({ clearInput = true }: { clearInput?: boolean } = {}): void => {
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
      const targetGroup = record.layer_id == null ? undefined : clusterGroups[record.layer_id];
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
      const targetGroup = record.layer_id == null ? undefined : clusterGroups[record.layer_id];
      if (marker && targetGroup && matchesMarkerSearch(record, query)) {
        targetGroup.addLayer(marker);
      }
    });
    getMap().closePopup?.();
  };

  let addressSearchMarker: { remove(): void } | undefined;
  const moveToSearchResult = (
    latitude: string,
    longitude: string,
    source: "coordinate" | "address" = "coordinate",
  ): void => {
    resetMapSearchStatus();
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
    const marker = leaflet.marker([latitude, longitude], { icon }).addTo(map);
    const popup = marker.bindPopup("緯度：" + latitude + "<br>経度：" + longitude);
    if (source === "address") {
      addressSearchMarker?.remove();
      addressSearchMarker = marker;
    } else {
      popup.openPopup();
    }
  };

  let searchSequence = 0;
  let pendingSearch: AbortController | undefined;
  let addressResults: Array<{ address: string; latitude: number; longitude: number }> = [];
  let resultList: HTMLDivElement | undefined;
  let resultDropdown: HTMLDetailsElement | undefined;
  let resultSummary: HTMLElement | undefined;
  const clearAddressResults = (): void => {
    addressResults = [];
    if (resultDropdown) {
      resultDropdown.open = false;
      resultDropdown.hidden = true;
    }
    if (resultList) {
      resultList.replaceChildren();
      resultList.hidden = true;
    }
  };
  const invalidateSearch = (): void => {
    ++searchSequence;
    pendingSearch?.abort();
    pendingSearch = undefined;
    clearAddressResults();
    resetMapSearchStatus();
  };
  const onSearchCode = async (): Promise<void> => {
    invalidateSearch();
    const sequence = searchSequence;
    const input = document.getElementById("code-input") as HTMLInputElement | null;
    const value = input?.value.trim() ?? "";
    if (!value) return;
    const normalized = value.normalize("NFKC").replace(/[()\s]/g, "");
    if (/^[+\-\d.eE,]+$/.test(normalized)) {
      const parts = normalized.split(",");
      const [latitude = "", longitude = ""] = parts;
      if (
        parts.length !== 2 ||
        !latitude ||
        !longitude ||
        !Number.isFinite(Number(latitude)) ||
        !Number.isFinite(Number(longitude)) ||
        !isValidCoordinate(latitude, longitude)
      ) {
        showMapSearchStatus("緯度・経度を正しく入力してください。", true);
        return;
      }
      moveToSearchResult(latitude, longitude);
      return;
    }
    if ([...value].length > 100) {
      showMapSearchStatus("住所は100文字以内で入力してください。", true);
      return;
    }
    const controller = new AbortController();
    pendingSearch = controller;
    showMapSearchStatus("住所を検索しています…");
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const shareToken = document.querySelector<HTMLMetaElement>(
        'meta[name="geocoder-share-token"]',
      )?.content;
      const response = await fetch("/geocode", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: value, share_token: shareToken || undefined }),
      });
      if (!response.ok) throw new Error("Address search failed");
      const data = await response.json();
      if (sequence !== searchSequence) return;
      if (!Array.isArray(data.results)) throw new Error("Invalid search results");
      addressResults = data.results.filter(
        (result: unknown): result is (typeof addressResults)[number] => {
          if (!result || typeof result !== "object") return false;
          const { address, latitude, longitude } = result as (typeof addressResults)[number];
          return (
            typeof address === "string" &&
            typeof latitude === "number" &&
            typeof longitude === "number" &&
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            Math.abs(latitude) <= 90 &&
            Math.abs(longitude) <= 180
          );
        },
      );
      if (addressResults.length === 0) {
        showMapSearchStatus("検索結果に一致する座標はありません。", true);
        return;
      }
      if (resultList) {
        resultList.replaceChildren();
        addressResults.forEach((result, index) => {
          const option = document.createElement("button");
          option.type = "button";
          option.dataset.resultIndex = String(index);
          option.setAttribute("aria-pressed", "false");
          option.textContent = result.address || `${result.latitude}, ${result.longitude}`;
          option.title = option.textContent;
          resultList!.append(option);
        });
        resultList.hidden = false;
        if (resultDropdown) resultDropdown.hidden = false;
        if (resultSummary) resultSummary.textContent = "検索結果を選択してください";
      }
      resetMapSearchStatus();
    } catch {
      if (sequence === searchSequence)
        showMapSearchStatus("住所検索に失敗しました。時間をおいて再度お試しください。", true);
    } finally {
      window.clearTimeout(timeout);
      if (sequence === searchSequence) pendingSearch = undefined;
    }
  };

  const createCodeSearchControl = (options: { position?: string } = {}): object => {
    const leaflet = getLeaflet();
    const csisAttribution =
      '<a href="https://geocode.csis.u-tokyo.ac.jp/" target="_blank" rel="noopener noreferrer">CSISシンプルジオコーディング実験を利用</a>';
    let attributedControl: RuntimeMap["attributionControl"];
    const Control = leaflet.Control.extend({
      options: { position: options.position ?? "topleft" },
      onAdd() {
        if (
          document.querySelector<HTMLMetaElement>('meta[name="geocoder-csis"]')?.content === "true"
        ) {
          attributedControl = getMap().attributionControl;
          attributedControl?.addAttribution(csisAttribution);
        }
        const container = leaflet.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control address-search-control",
        );
        container.innerHTML =
          '<div class="search-zone">' +
          '<input type="text" class="search-input" id="code-input" placeholder="住所・緯度経度" aria-label="住所・緯度経度" title="住所、または緯度,経度を入力してください。">' +
          '<button type="button" id="code-search-btn" class="custom-search">検索</button>' +
          '<details class="address-results-dropdown" hidden><summary aria-label="住所検索結果を開閉">検索結果を選択してください</summary>' +
          '<div id="address-search-results" role="group" aria-label="住所検索結果" hidden></div></details>' +
          "</div>";
        const button = container.querySelector(".custom-search");
        leaflet.DomEvent.on(button, "click", (event) => {
          leaflet.DomEvent.stop(event);
          onSearchCode();
        });
        const input = container.querySelector<HTMLInputElement>("#code-input");
        resultList = container.querySelector<HTMLDivElement>("#address-search-results")!;
        resultDropdown = container.querySelector<HTMLDetailsElement>(".address-results-dropdown")!;
        resultSummary = resultDropdown.querySelector("summary")!;
        const closeResults = (): void => {
          if (resultDropdown) resultDropdown.open = false;
        };
        const fitResults = (): void => {
          if (!resultDropdown?.open || !resultList || !resultSummary) return;
          const rect = resultSummary.getBoundingClientRect();
          const viewport = window.visualViewport;
          const top = viewport?.offsetTop ?? 0;
          const bottom = top + (viewport?.height ?? window.innerHeight);
          const below = Math.max(0, bottom - rect.bottom - 12);
          const above = Math.max(0, rect.top - top - 12);
          const opensAbove = below < 180 && above > below;
          resultDropdown.classList.toggle("opens-above", opensAbove);
          resultList.style.maxHeight = `${Math.min(180, opensAbove ? above : below)}px`;
        };
        resultDropdown.addEventListener("toggle", fitResults);
        resultDropdown.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeResults();
            resultSummary?.focus();
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            const buttons = Array.from(
              resultList?.querySelectorAll<HTMLButtonElement>("button") ?? [],
            );
            if (!buttons.length) return;
            event.preventDefault();
            resultDropdown!.open = true;
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : event.key === "ArrowDown"
                    ? Math.min(current + 1, buttons.length - 1)
                    : current < 0
                      ? buttons.length - 1
                      : Math.max(current - 1, 0);
            buttons[next]?.focus();
          }
        });
        resultDropdown.addEventListener("focusout", (event) => {
          if (!resultDropdown?.contains(event.relatedTarget as Node | null)) closeResults();
        });
        const dismissOutside = (event: PointerEvent): void => {
          if (!resultDropdown?.contains(event.target as Node)) closeResults();
        };
        document.addEventListener("pointerdown", dismissOutside);
        window.addEventListener("resize", fitResults);
        window.visualViewport?.addEventListener("resize", fitResults);
        window.visualViewport?.addEventListener("scroll", fitResults);
        // Leaflet invokes onRemove when disposing this control.
        (container as HTMLElement & { cleanupSearch?: () => void }).cleanupSearch = () => {
          document.removeEventListener("pointerdown", dismissOutside);
          window.removeEventListener("resize", fitResults);
          window.visualViewport?.removeEventListener("resize", fitResults);
          window.visualViewport?.removeEventListener("scroll", fitResults);
        };
        leaflet.DomEvent.on(resultList, "click", (event) => {
          if (!resultList || resultList.hidden || !resultDropdown?.open) return;
          const button = (event.target as Element).closest<HTMLButtonElement>(
            "button[data-result-index]",
          );
          if (!button || !resultList.contains(button)) return;
          const result = addressResults[Number(button.dataset.resultIndex)];
          if (result) {
            resultList.querySelectorAll("button").forEach((candidate) => {
              candidate.setAttribute("aria-pressed", String(candidate === button));
            });
            moveToSearchResult(String(result.latitude), String(result.longitude), "address");
            if (resultSummary)
              resultSummary.textContent =
                result.address || `${result.latitude}, ${result.longitude}`;
            closeResults();
            resultSummary?.focus();
          }
        });
        leaflet.DomEvent.on(input, "input", invalidateSearch);
        let composing = false;
        leaflet.DomEvent.on(input, "compositionstart", () => {
          composing = true;
        });
        leaflet.DomEvent.on(input, "compositionend", () => {
          composing = false;
        });
        leaflet.DomEvent.on(input, "keydown", (event) => {
          const key = event as KeyboardEvent;
          if (key.key === "Enter" && !composing && !key.isComposing && key.keyCode !== 229) {
            leaflet.DomEvent.stop(event);
            void onSearchCode();
          }
        });
        leaflet.DomEvent.disableClickPropagation(container);
        leaflet.DomEvent.disableScrollPropagation(container);
        return container;
      },
      onRemove(this: { _container?: HTMLElement & { cleanupSearch?: () => void } }) {
        attributedControl?.removeAttribution(csisAttribution);
        attributedControl = undefined;
        this._container?.cleanupSearch?.();
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
        const container = leaflet.DomUtil.create("div", "leaflet-bar leaflet-control");
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
        const container = leaflet.DomUtil.create("div", "leaflet-bar leaflet-control");
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
    mergeButton.setAttribute("aria-pressed", getMeasurementSegmentMerged() ? "true" : "false");
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
