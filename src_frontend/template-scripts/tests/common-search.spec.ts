import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMapSearchStatus } from "../src/map/common/search-status";

afterEach(() => vi.unstubAllGlobals());

import {
  createLayeredMarkerDisplayManager,
  createLayeredShapeDisplayManager,
  createMapSearchRuntime,
  filterMeasurementMarkersForBounds,
  getShapeRecords,
  matchesMarkerSearch,
  matchesShapeSearch,
  normalizeMarkerSearchText,
} from "../src/map/common/search";

describe("map common search", () => {
  it("normalizes and matches marker fields", () => {
    const marker = {
      detail: "East exit",
      id: "1",
      latitude: 35.6812,
      longitude: 139.7671,
      marker_name: "Tokyo Station",
    };

    expect(normalizeMarkerSearchText("  TOKYO ")).toBe("tokyo");
    expect(matchesMarkerSearch(marker, "east")).toBe(true);
    expect(matchesMarkerSearch(marker, "35.6812")).toBe(true);
    expect(matchesMarkerSearch(marker, "west")).toBe(false);
    expect(matchesMarkerSearch(marker, "   ")).toBe(true);
  });

  it("matches shape names and memo text", () => {
    const shape = {
      geojson: { properties: { memo: "避難経路" } },
      id: "shape-1",
      name: "Route A",
    };

    expect(matchesShapeSearch(shape, "route a")).toBe(true);
    expect(matchesShapeSearch(shape, "避難")).toBe(true);
    expect(matchesShapeSearch(shape, "通行止め")).toBe(false);
  });

  it("normalizes array and keyed shape records", () => {
    const shape = { id: "shape-1", name: "Route A" };
    expect(getShapeRecords([shape])).toEqual([shape]);
    expect(getShapeRecords({ first: shape })).toEqual([shape]);
    expect(getShapeRecords(null)).toEqual([]);
  });

  it("keeps only measurement markers inside the current bounds", () => {
    const inside = { getLatLng: () => ({ id: "inside" }) };
    const outside = { getLatLng: () => ({ id: "outside" }) };
    const withoutPosition = {};
    const contains = vi.fn((latLng: unknown) => (latLng as { id?: string }).id === "inside");

    expect(
      filterMeasurementMarkersForBounds([inside, outside, withoutPosition], { contains }),
    ).toEqual([inside, withoutPosition]);
    expect(filterMeasurementMarkersForBounds("invalid", { contains })).toEqual([]);
  });

  it("rebuilds visible markers from layer visibility and search text", () => {
    document.body.innerHTML = '<input id="marker-search-input" value="Tokyo">';
    const layerOneVisibility = {};
    const visibleLayers = new Set<object>([layerOneVisibility]);
    const addedMarkers: object[] = [];
    const markerOne = {};
    const markerTwo = {};
    const closePopup = vi.fn();
    const manager = createLayeredMarkerDisplayManager({
      map: {
        closePopup,
        hasLayer: (layer) => visibleLayers.has(layer),
      },
      markerRecords: {
        first: {
          id: "1",
          layer_id: "layer-1",
          marker_name: "Tokyo",
        },
        second: {
          id: "2",
          layer_id: "layer-2",
          marker_name: "Osaka",
        },
      },
      markers: { "marker-1": markerOne, "marker-2": markerTwo },
      visibleMarkerGroup: {
        addLayer: (marker) => void addedMarkers.push(marker),
        clearLayers: () => void addedMarkers.splice(0),
      },
      layerVisibilityGroups: {
        "layer-1": layerOneVisibility,
        "layer-2": {},
      },
    });

    manager.setSearchQuery("tokyo");
    expect(addedMarkers).toEqual([markerOne]);
    expect(manager.findLayerIdByVisibilityGroup(layerOneVisibility)).toBe("layer-1");
    expect(closePopup).toHaveBeenCalledOnce();

    manager.clearSearch();
    expect((document.getElementById("marker-search-input") as HTMLInputElement).value).toBe("");
  });

  it("rebuilds matching shapes together with measurement markers", () => {
    const shapeLayer = { measurementMarkers: [{ id: "measurement" }] };
    const addedLayers: object[] = [];
    const onRebuild = vi.fn();
    const manager = createLayeredShapeDisplayManager({
      map: { closePopup: vi.fn(), hasLayer: () => true },
      shapeRecords: [
        {
          geojson: { properties: { memo: "Safe route" } },
          id: "1",
          layer_id: "layer-1",
          name: "Route A",
        },
      ],
      shapeLayers: { "shape-1": shapeLayer },
      shapeGroups: {
        "layer-1": {
          addLayer: (layer) => void addedLayers.push(layer),
          clearLayers: () => void addedLayers.splice(0),
        },
      },
      isLayerVisible: () => true,
      onRebuild,
    });

    manager.setSearchQuery("safe");
    expect(addedLayers).toEqual([shapeLayer, shapeLayer.measurementMarkers[0]]);
    expect(onRebuild).toHaveBeenCalledOnce();

    manager.setSearchQuery("missing");
    expect(addedLayers).toEqual([]);
  });

  it("handles marker search input after IME composition", () => {
    document.body.innerHTML = "";
    const onSearch = vi.fn();
    const onClear = vi.fn();
    const runtime = createMapSearchRuntime({
      getLeaflet: createLeafletMock,
      getMap: () => ({
        hasLayer: () => true,
        setView: vi.fn(),
      }),
      getMeasurementSegmentMerged: () => false,
      getMeasurementVisible: () => false,
      isValidCoordinate: () => true,
      refreshAllShapeMeasurementMarkers: vi.fn(),
      setMeasurementSegmentMerged: vi.fn(),
    });
    const control = runtime.createMarkerSearchControl({
      onSearch,
      onClear,
    }) as { onAdd(): HTMLElement };
    const container = control.onAdd();
    document.body.append(container);
    const input = container.querySelector<HTMLInputElement>("#marker-search-input")!;

    input.dispatchEvent(new Event("compositionstart"));
    input.value = "Tokyo";
    input.dispatchEvent(new Event("input"));
    expect(onSearch).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("compositionend"));
    expect(onSearch).toHaveBeenCalledWith("Tokyo");

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(onClear).toHaveBeenCalledWith({ clearInput: false });
  });

  it("filters the mobile flat marker group and restores its base markers", () => {
    const markerOne = {};
    const markerTwo = {};
    const added: object[] = [];
    const markerGroup = {
      addLayer: (layer: object) => void added.push(layer),
      clearLayers: () => void added.splice(0),
    };
    const runtime = createMapSearchRuntime({
      getLeaflet: createLeafletMock,
      getMap: () => ({ closePopup: vi.fn(), hasLayer: () => true, setView: vi.fn() }),
      getMeasurementSegmentMerged: () => false,
      getMeasurementVisible: () => false,
      isValidCoordinate: () => true,
      refreshAllShapeMeasurementMarkers: vi.fn(),
      setMeasurementSegmentMerged: vi.fn(),
    });

    runtime.filterFlatMarkersByQuery({
      markerRecords: {
        one: { id: 1, marker_name: "Tokyo" },
        two: { id: 2, marker_name: "Osaka" },
      },
      markers: { "marker-1": markerOne, "marker-2": markerTwo },
      markerGroup,
      query: "tokyo",
      baseMarkerIds: [1, 2],
    });
    expect(added).toEqual([markerOne]);

    runtime.restoreFlatMarkers({
      markers: { "marker-1": markerOne, "marker-2": markerTwo },
      markerGroup,
      baseMarkerIds: [2],
    });
    expect(added).toEqual([markerTwo]);
  });

  it("emits mobile flat searches after IME composition", () => {
    document.body.innerHTML = "";
    const onSearch = vi.fn();
    const runtime = createMapSearchRuntime({
      getLeaflet: createLeafletMock,
      getMap: () => ({ hasLayer: () => true, setView: vi.fn() }),
      getMeasurementSegmentMerged: () => false,
      getMeasurementVisible: () => false,
      isValidCoordinate: () => true,
      refreshAllShapeMeasurementMarkers: vi.fn(),
      setMeasurementSegmentMerged: vi.fn(),
    });
    const control = runtime.createFlatMarkerSearchControl({ onSearch }) as {
      onAdd(): HTMLElement;
    };
    const input = control.onAdd().querySelector<HTMLInputElement>("#marker-search-input")!;
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "Tokyo";
    input.dispatchEvent(new Event("input"));
    expect(onSearch).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("compositionend"));
    expect(onSearch).toHaveBeenCalledWith("Tokyo");
  });

  it("updates and toggles the measurement control state", () => {
    document.body.innerHTML = '<button id="measurement-merge-toggle-btn"></button>';
    let isMerged = false;
    const refresh = vi.fn();
    const runtime = createMapSearchRuntime({
      getLeaflet: createLeafletMock,
      getMap: () => ({
        hasLayer: () => true,
        setView: vi.fn(),
      }),
      getMeasurementSegmentMerged: () => isMerged,
      getMeasurementVisible: () => true,
      isValidCoordinate: () => true,
      refreshAllShapeMeasurementMarkers: refresh,
      setMeasurementSegmentMerged: (value) => {
        isMerged = value;
      },
    });

    runtime.toggleMeasurementSegmentMerge();
    const button = document.getElementById("measurement-merge-toggle-btn")!;
    expect(isMerged).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(button.classList.contains("is-active")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the map when a valid coordinate is searched", () => {
    document.body.innerHTML = "";
    const setView = vi.fn();
    const leaflet = createLeafletMock();
    const runtime = createMapSearchRuntime({
      getLeaflet: () => leaflet,
      getMap: () => ({ hasLayer: () => true, setView }),
      getMeasurementSegmentMerged: () => false,
      getMeasurementVisible: () => false,
      isValidCoordinate: () => true,
      refreshAllShapeMeasurementMarkers: vi.fn(),
      setMeasurementSegmentMerged: vi.fn(),
    });
    const control = runtime.createCodeSearchControl() as {
      onAdd(): HTMLElement;
    };
    const container = control.onAdd();
    document.body.append(container);
    const input = container.querySelector<HTMLInputElement>("#code-input")!;
    input.value = "35.6812, 139.7671";

    container.querySelector<HTMLButtonElement>("#code-search-btn")!.click();

    expect(setView).toHaveBeenCalledWith(expect.anything(), 14);
    expect(leaflet.marker).toHaveBeenCalledOnce();
    expect(leaflet.marker.mock.results[0].value.openPopup).toHaveBeenCalledOnce();
  });

  function searchFixture() {
    document.body.innerHTML = '<div id="mode-description">閲覧モード</div>';
    const setView = vi.fn();
    const leaflet = createLeafletMock();
    const runtime = createMapSearchRuntime({
      getLeaflet: () => leaflet,
      getMap: () => ({ hasLayer: () => true, setView }),
      getMeasurementSegmentMerged: () => false,
      getMeasurementVisible: () => false,
      isValidCoordinate: (lat, lon) => Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180,
      refreshAllShapeMeasurementMarkers: vi.fn(),
      setMeasurementSegmentMerged: vi.fn(),
    });
    const container = (runtime.createCodeSearchControl() as { onAdd(): HTMLElement }).onAdd();
    document.body.append(container);
    const input = container.querySelector<HTMLInputElement>("input")!;
    const search = (value: string) => {
      input.value = value;
      container.querySelector("button")!.click();
    };
    const select = container.querySelector<HTMLSelectElement>("select")!;
    const choose = (index: number) => {
      select.value = String(index);
      select.dispatchEvent(new Event("change"));
    };
    return {
      setView,
      leaflet,
      select,
      choose,
      input,
      search,
      status: document.getElementById("mode-description")!,
    };
  }

  it("waits for address selection, then moves and creates a marker without opening its popup", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ address: "東京都千代田区", latitude: 35, longitude: 139 }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { search, setView, status, select, choose, leaflet } = searchFixture();
    search("東京都千代田区");
    await vi.waitFor(() => expect(select.hidden).toBe(false));
    expect(select.value).toBe("");
    expect(select.options[0].textContent).toBe("検索結果を選択してください");
    expect(select.options[1].textContent).toBe("東京都千代田区");
    expect(setView).not.toHaveBeenCalled();
    expect(leaflet.marker).not.toHaveBeenCalled();
    choose(0);
    expect(setView).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: "35", longitude: "139" }),
      14,
    );
    expect(leaflet.marker).toHaveBeenCalledWith(["35", "139"], { icon: expect.anything() });
    expect(leaflet.marker.mock.results[0].value.openPopup).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe("/geocode");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: "東京都千代田区" });
    expect(status.textContent).toBe("閲覧モード");
    expect(status.style.color).toBe("");
  });

  it("preserves candidate order, allows reselection, and clears candidates when editing or searching again", async () => {
    const results = [
      { address: "東京都府中市", latitude: 35, longitude: 139 },
      { address: "広島県府中市", latitude: 34, longitude: 133 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results }) }),
    );
    const { search, select, choose, setView, input, leaflet } = searchFixture();
    search("府中市");
    await vi.waitFor(() => expect(select.options.length).toBe(3));
    expect(
      Array.from(select.options)
        .slice(1)
        .map((option) => option.textContent),
    ).toEqual(results.map((result) => result.address));
    choose(1);
    expect(setView).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: "34", longitude: "133" }),
      14,
    );
    choose(0);
    expect(setView).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: "35", longitude: "139" }),
      14,
    );
    expect(leaflet.marker).toHaveBeenCalledTimes(2);
    const firstMarker = leaflet.marker.mock.results[0].value;
    const currentMarker = leaflet.marker.mock.results[1].value;
    expect(firstMarker.remove).toHaveBeenCalledOnce();
    expect(firstMarker.openPopup).not.toHaveBeenCalled();
    expect(currentMarker.openPopup).not.toHaveBeenCalled();
    input.value = "東京都";
    input.dispatchEvent(new Event("input"));
    expect(select.hidden).toBe(true);
    expect(select.options.length).toBe(0);
    search("東京都");
    await vi.waitFor(() => expect(select.hidden).toBe(false));
    search("35,139");
    expect(select.hidden).toBe(true);
    expect(leaflet.marker).toHaveBeenCalledTimes(3);
    expect(currentMarker.remove).not.toHaveBeenCalled();
    expect(leaflet.marker.mock.results[2].value.openPopup).toHaveBeenCalledOnce();
  });

  it("keeps the selected address marker when a later search has no results", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: [{ address: "東京都", latitude: 35, longitude: 139 }] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) }),
    );
    const { search, select, choose, leaflet, setView, status } = searchFixture();
    search("東京都");
    await vi.waitFor(() => expect(select.hidden).toBe(false));
    choose(0);
    search("該当なし");
    await vi.waitFor(() => expect(status.textContent).toBe("検索結果に一致する座標はありません。"));
    expect(leaflet.marker).toHaveBeenCalledOnce();
    expect(leaflet.marker.mock.results[0].value.remove).not.toHaveBeenCalled();
    expect(setView).toHaveBeenCalledOnce();
  });

  it("ignores a pending response after the input has been edited", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const { input, search, select, setView } = searchFixture();
    search("東京都");
    input.value = "広島県";
    input.dispatchEvent(new Event("input"));
    resolve({
      ok: true,
      json: async () => ({ results: [{ address: "東京都", latitude: 35, longitude: 139 }] }),
    });
    await new Promise((done) => setTimeout(done, 0));
    expect(select.hidden).toBe(true);
    expect(select.options.length).toBe(0);
    expect(setView).not.toHaveBeenCalled();
  });

  it("bounds the expanded list to the available viewport and closes after selection or Escape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ address: "東京都", latitude: 35, longitude: 139 }] }),
      }),
    );
    const { search, select, choose } = searchFixture();
    search("東京都");
    await vi.waitFor(() => expect(select.hidden).toBe(false));
    const dropdown = select.closest("details")!;
    const summary = dropdown.querySelector("summary")!;
    vi.spyOn(summary, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 80,
      bottom: window.innerHeight - 50,
    } as DOMRect);
    dropdown.open = true;
    dropdown.dispatchEvent(new Event("toggle"));
    expect(dropdown.classList.contains("opens-above")).toBe(true);
    expect(Number.parseFloat(select.style.maxHeight)).toBeLessThanOrEqual(180);
    choose(0);
    expect(dropdown.open).toBe(false);
    expect(summary.textContent).toBe("東京都");
    dropdown.open = true;
    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.open).toBe(false);
  });

  it("shows no match in red, separately from a service error, and resets on mode change", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    const { search, status, setView } = searchFixture();
    search("該当なし");
    await vi.waitFor(() => expect(status.textContent).toBe("検索結果に一致する座標はありません。"));
    expect(status.style.color).toBe("red");
    resetMapSearchStatus();
    expect(status.textContent).toBe("閲覧モード");
    expect(status.style.color).toBe("");
    search("通信失敗");
    await vi.waitFor(() => expect(status.textContent).toContain("住所検索に失敗"));
    expect(setView).not.toHaveBeenCalled();
  });

  it("ignores stale address results after a coordinate search", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const { search, setView } = searchFixture();
    search("東京都");
    search("35,139");
    resolve({
      ok: true,
      json: async () => ({ results: [{ address: "東京都", latitude: 36, longitude: 140 }] }),
    });
    await new Promise((done) => setTimeout(done, 0));
    expect(setView).toHaveBeenCalledOnce();
  });

  it("creates an accessible error area on read-only pages without a mode description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }),
    );
    const { search, status } = searchFixture();
    status.remove();
    search("該当なし");
    await vi.waitFor(() =>
      expect(document.getElementById("mode-description")?.textContent).toBe(
        "検索結果に一致する座標はありません。",
      ),
    );
    expect(document.getElementById("mode-description")?.style.color).toBe("red");
    expect(document.getElementById("mode-description")?.getAttribute("role")).toBe("status");
  });

  it("does not send invalid coordinates or empty input to the geocoder", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { search, setView } = searchFixture();
    search("999,139");
    search(" ");
    search("35,139");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setView).toHaveBeenCalledOnce();
  });

  it("searches on Enter only outside Japanese composition and includes the shared-map token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { input } = searchFixture();
    const token = document.createElement("meta");
    token.name = "geocoder-share-token";
    token.content = "test-viewer-token";
    document.body.append(token);
    input.value = "東京都";
    input.dispatchEvent(new Event("compositionstart"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(fetchMock).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("compositionend"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).share_token).toBe("test-viewer-token");
  });
});

function createLeafletMock() {
  return {
    Control: {
      extend: (definition: { onAdd(): HTMLElement }) =>
        class {
          onAdd() {
            return definition.onAdd();
          }
        },
    },
    DomEvent: {
      disableClickPropagation: vi.fn(),
      disableScrollPropagation: vi.fn(),
      on: (element: Element | null, eventName: string, listener: (event: Event) => void) =>
        element?.addEventListener(eventName, listener),
      stop: vi.fn(),
    },
    DomUtil: {
      create: (tagName: string, className: string) => {
        const element = document.createElement(tagName);
        element.className = className;
        return element;
      },
    },
    LatLng: class {
      constructor(
        public latitude: string,
        public longitude: string,
      ) {}
    },
    icon: vi.fn(() => ({})),
    marker: vi.fn(() => {
      const marker = {
        addTo: vi.fn().mockReturnThis(),
        bindPopup: vi.fn().mockReturnThis(),
        openPopup: vi.fn(),
        remove: vi.fn(),
      };
      return marker;
    }),
  };
}
