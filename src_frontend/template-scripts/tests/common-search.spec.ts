import { describe, expect, it, vi } from "vitest";

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
    const contains = vi.fn(
      (latLng: unknown) =>
        (latLng as { id?: string }).id === "inside",
    );

    expect(
      filterMeasurementMarkersForBounds(
        [inside, outside, withoutPosition],
        { contains },
      ),
    ).toEqual([inside, withoutPosition]);
    expect(filterMeasurementMarkersForBounds("invalid", { contains })).toEqual(
      [],
    );
  });

  it("rebuilds visible markers from layer visibility and search text", () => {
    document.body.innerHTML =
      '<input id="marker-search-input" value="Tokyo">';
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
    expect(manager.findLayerIdByVisibilityGroup(layerOneVisibility)).toBe(
      "layer-1",
    );
    expect(closePopup).toHaveBeenCalledOnce();

    manager.clearSearch();
    expect(
      (document.getElementById("marker-search-input") as HTMLInputElement).value,
    ).toBe("");
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
    expect(addedLayers).toEqual([
      shapeLayer,
      shapeLayer.measurementMarkers[0],
    ]);
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
    const input = container.querySelector<HTMLInputElement>(
      "#marker-search-input",
    )!;

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
    const input = control.onAdd().querySelector<HTMLInputElement>(
      "#marker-search-input",
    )!;
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "Tokyo";
    input.dispatchEvent(new Event("input"));
    expect(onSearch).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("compositionend"));
    expect(onSearch).toHaveBeenCalledWith("Tokyo");
  });

  it("updates and toggles the measurement control state", () => {
    document.body.innerHTML =
      '<button id="measurement-merge-toggle-btn"></button>';
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
      on: (
        element: Element | null,
        eventName: string,
        listener: (event: Event) => void,
      ) => element?.addEventListener(eventName, listener),
      stop: vi.fn(),
    },
    DomUtil: {
      create: (tagName: string, className: string) => {
        const element = document.createElement(tagName);
        element.className = className;
        return element;
      },
    },
    LatLng: class {},
    icon: vi.fn(() => ({})),
    marker: vi.fn(() => ({
      addTo: () => ({
        bindPopup: () => ({ openPopup: vi.fn() }),
      }),
    })),
  };
}
