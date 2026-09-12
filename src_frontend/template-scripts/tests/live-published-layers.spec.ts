import { afterEach, describe, expect, it, vi } from "vitest";
import { addPublishedLayerControl, type PublishedLayers } from "../src/live-map/published-layers";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const objects: any[] = [];
  const groups: any[] = [];
  const visible = new Set();
  const makeObject = () => {
    const obj = {
      bindTooltip: vi.fn(),
      bindPopup: vi.fn(),
      on: vi.fn(),
      addTo: vi.fn((group: any) => {
        group.items.push(obj);
        return obj;
      }),
    };
    objects.push(obj);
    return obj;
  };
  const container = document.createElement("div");
  container.innerHTML = '<div class="leaflet-control-layers-overlays"></div>';
  const control = {
    addTo: vi.fn(() => control),
    getContainer: () => container,
    addOverlay: vi.fn((_group, name) => {
      const label = document.createElement("label");
      label.innerHTML = name;
      container.firstElementChild!.append(label);
    }),
  };
  const clusterItems = new Set();
  const cluster = {
    addTo: vi.fn(() => cluster),
    clearLayers: vi.fn(() => clusterItems.clear()),
    addLayers: vi.fn((items: any[]) => items.forEach(item => clusterItems.add(item))),
  };
  const leaflet = {
    markerClusterGroup: vi.fn(() => cluster),
    control: { layers: vi.fn(() => control) },
    layerGroup: () => {
      const group = {
        items: [],
        addTo: () => {
          visible.add(group);
          return group;
        },
      };
      groups.push(group);
      return group;
    },
    marker: vi.fn(makeObject),
    circle: vi.fn(makeObject),
    latLng: (lat: number, lng: number) => [lat, lng],
    geoJSON: vi.fn(() => ({ getLayers: () => [makeObject()] })),
    DomUtil: {
      create: (tag: string, className: string, parent: HTMLElement) => {
        const element = document.createElement(tag);
        element.className = className;
        parent.append(element);
        return element;
      },
    },
    DomEvent: {
      on: (el: HTMLElement, type: string, fn: EventListener) => el.addEventListener(type, fn),
      stop: vi.fn(),
      disableClickPropagation: vi.fn(),
    },
  };
  const marked = {
    Renderer: class {
      link() {
        return "";
      }
    },
    use: vi.fn(),
    setOptions: vi.fn(),
    parse: vi.fn((text: string) => text),
  };
  const filterXSS = vi.fn(() => "<p>sanitized memo</p>");
  vi.stubGlobal("marked", marked);
  vi.stubGlobal("filterXSS", filterXSS);
  const map = { on: vi.fn(), hasLayer: (layer: unknown) => visible.has(layer) };
  return { leaflet, map, groups, visible, objects, control, container, marked, filterXSS, cluster, clusterItems };
}

describe("live published layers", () => {
  it("does not install a control when no groups are published", () => {
    const { leaflet, map } = setup();
    expect(addPublishedLayerControl(leaflet, map, undefined, false)).toBeNull();
    expect(leaflet.control.layers).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "renders selected groups read-only, with shapes, sanitized content and escaped labels (mobile=%s)",
    (mobile) => {
      const runtime = setup();
      const data: PublishedLayers = {
        layers: [
          { id: "a", layer_name: "<img onerror=alert(1)>" },
          { id: "b", layer_name: "second" },
        ],
        markers: [
          {
            id: "m",
            layer_id: "a",
            marker_name: "<script>name</script>",
            latitude: 35,
            longitude: 139,
            detail: "memo",
          },
          {
            id: "hidden",
            layer_id: "not-published",
            marker_name: "private",
            latitude: 35,
            longitude: 139,
            detail: "private",
          },
        ],
        shapes: [
          {
            id: "circle",
            layer_id: "b",
            shape_type: "circle",
            name: "circle",
            geojson: {
              type: "Feature",
              geometry: { type: "Point", coordinates: [139, 35] },
              properties: {
                radius: 120,
                style: { color: "#ff0000", weight: 5, fillOpacity: 0.4 },
                memo: "shape memo",
              },
            },
          },
          {
            id: "line",
            layer_id: "a",
            shape_type: "polyline",
            name: "line",
            geojson: {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [139, 35],
                  [140, 36],
                ],
              },
              properties: { style: { color: "#123456", weight: 4 } },
            },
          },
        ],
      };
      const result = addPublishedLayerControl(runtime.leaflet, runtime.map, data, mobile)!;
      expect(runtime.visible.size).toBe(2);
      expect(runtime.groups.map((g) => g.items.length)).toEqual([1, 1]);
      expect(runtime.clusterItems).toEqual(new Set([runtime.objects[0]]));
      expect(runtime.leaflet.marker).toHaveBeenCalledOnce();
      expect(runtime.leaflet.marker.mock.calls[0]).toEqual([[35, 139], {}]);
      expect(runtime.leaflet.circle).toHaveBeenCalledWith(
        [35, 139],
        expect.objectContaining({ radius: 120, color: "#ff0000", weight: 5, fillOpacity: 0.4 }),
      );
      expect(runtime.objects[0].bindPopup.mock.calls[0][0]).toContain(
        "&lt;script&gt;name&lt;/script&gt;",
      );
      expect(runtime.objects[0].bindPopup.mock.calls[0][0]).toContain("sanitized memo");
      expect(runtime.objects[0].bindPopup.mock.calls[0][0]).toContain('class="md-detail-contents"');
      expect(runtime.objects[0].bindPopup.mock.calls[0][0]).toContain("<h1>&lt;script&gt;name&lt;/script&gt;</h1>");
      expect(runtime.objects[0].bindPopup.mock.calls[0][1].className).toBe("live-published-popup");
      expect(runtime.filterXSS).toHaveBeenCalled();
      expect(runtime.container.querySelector("img")).toBeNull();
      expect(runtime.container.textContent).toContain("<img onerror=alert(1)>");
      expect(runtime.objects.every((obj) => !obj.editing && !obj.dragging)).toBe(true);
      expect(Boolean(result.collapsible)).toBe(mobile);
    },
  );
});


it("updates a single cluster across groups without including shapes or live accounts", () => {
  const r = setup();
  const data: PublishedLayers = {
    layers: [{id: "a", layer_name: "A"}, {id: "b", layer_name: "B"}],
    markers: ["a", "b"].map((layer_id, i) => ({id: String(i), layer_id, marker_name: layer_id, latitude: 35, longitude: 139, detail: ""})),
    shapes: [],
  };
  addPublishedLayerControl(r.leaflet, r.map, data, false);
  expect(r.leaflet.markerClusterGroup).toHaveBeenCalledOnce();
  expect(r.clusterItems.size).toBe(2);
  const sync = r.map.on.mock.calls.find(call => call[0] === "layeradd layerremove")![1];
  const liveAccount = {};
  const previousCalls = r.cluster.clearLayers.mock.calls.length;
  sync({layer: liveAccount});
  expect(r.cluster.clearLayers).toHaveBeenCalledTimes(previousCalls);
  for (let i = 0; i < 3; i++) {
    r.visible.delete(r.groups[0]); sync({layer: r.groups[0]});
    expect(r.clusterItems).toEqual(new Set([r.objects[1]]));
    r.visible.delete(r.groups[1]); sync({layer: r.groups[1]});
    expect(r.clusterItems.size).toBe(0);
    r.visible.add(r.groups[0]); sync({layer: r.groups[0]});
    r.visible.add(r.groups[1]); sync({layer: r.groups[1]});
    expect(r.clusterItems).toEqual(new Set(r.objects));
  }
});


it("does not open an image preview when a published popup image is clicked", () => {
  const r = setup();
  r.filterXSS.mockReturnValue('<img class="marker-preview-image" src="/static/images/test.png" data-preview-src="/images/html/test.png">');
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  addPublishedLayerControl(r.leaflet, r.map, {
    layers: [{ id: "a", layer_name: "A" }],
    markers: [{ id: "m", layer_id: "a", marker_name: "画像", latitude: 35, longitude: 139, detail: "画像" }],
    shapes: [],
  }, false);
  const popup = document.createElement("div");
  popup.innerHTML = r.objects[0].bindPopup.mock.calls[0][0];
  document.body.append(popup);
  try {
    popup.querySelector("img")!.click();
    expect(open).not.toHaveBeenCalled();
  } finally {
    popup.remove();
    open.mockRestore();
  }
});
