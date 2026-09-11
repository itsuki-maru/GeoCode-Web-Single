import { describe, expect, it, vi } from "vitest";
import { addLiveTileOverlayControl } from "../src/live-map/tile-overlays";
import type { TileOverlayRecord } from "../src/map/common/tile-overlays";

function setup() {
  const containers: HTMLElement[] = [];
  const visible = new Set();
  const map = {
    getPane: () => null,
    createPane: () => ({ style: {} }),
    hasLayer: (layer: unknown) => visible.has(layer),
    removeLayer: (layer: unknown) => visible.delete(layer),
    on: vi.fn(),
  };
  const leaflet = {
    control: {
      layers: vi.fn(() => {
        const container = document.createElement("div");
        container.innerHTML = '<div class="leaflet-control-layers-overlays"></div>';
        containers.push(container);
        const control = {
          addTo: () => control,
          getContainer: () => container,
          addOverlay: (_layer: unknown, name: string) => {
            const label = document.createElement("label");
            label.innerHTML = name;
            container.querySelector(".leaflet-control-layers-overlays")!.append(label);
          },
        };
        return control;
      }),
    },
    tileLayer: () => {
      const layer = {
        on: vi.fn(),
        addTo: () => {
          visible.add(layer);
          return layer;
        },
      };
      return layer;
    },
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
  const records: TileOverlayRecord[] = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    name: `タイル${i}`,
    url: "https://example.com/{z}/{x}/{y}.png",
    attribution: "",
    min_zoom: 2,
    max_zoom: 17,
    opacity: 0.7,
    sort_order: i,
  }));
  return { leaflet, map, containers, records, visible };
}

describe("live tile overlay control", () => {
  it.each([false, true])("initial visibility follows the URL setting (%s)", (checked) => {
    for (const mobile of [false, true]) {
      const s = setup();
      addLiveTileOverlayControl(s.leaflet, s.map, s.records, mobile, checked);
      expect(s.visible.size).toBe(checked ? 4 : 0);
      expect(s.containers[0].querySelectorAll("label")).toHaveLength(4);
    }
  });
  it("defaults to unchecked while retaining the control entries", () => {
    const s = setup();
    addLiveTileOverlayControl(s.leaflet, s.map, s.records, false);
    expect(s.visible.size).toBe(0);
    expect(s.containers[0].querySelectorAll("label")).toHaveLength(4);
  });
  it("does not create an empty control", () => {
    const s = setup();
    expect(addLiveTileOverlayControl(s.leaflet, s.map, [], true)).toBeNull();
    expect(s.leaflet.control.layers).not.toHaveBeenCalled();
  });
  it("uses a separate labelled control and folds only its own items on mobile", () => {
    const s = setup();
    const members = s.leaflet.control.layers().addTo();
    members.addOverlay({}, "共有アカウント");
    const result = addLiveTileOverlayControl(s.leaflet, s.map, s.records, true)!;
    expect(result.control).not.toBe(members);
    expect(s.containers[0].textContent).toBe("共有アカウント");
    expect(s.containers[1].getAttribute("aria-label")).toBe("重ね合わせタイル");
    expect(s.containers[1].querySelectorAll("label")).toHaveLength(4);
    (s.containers[1].querySelector("button") as HTMLButtonElement).click();
    expect(s.containers[1].classList.contains("is-collapsed")).toBe(true);
    expect(s.containers[0].classList.contains("is-collapsed")).toBe(false);
  });
  it("keeps desktop tile items expanded without a fold button", () => {
    const s = setup();
    const result = addLiveTileOverlayControl(s.leaflet, s.map, s.records, false)!;
    expect(result.collapsible).toBeNull();
    expect(s.containers[0].querySelector("button")).toBeNull();
  });
});
