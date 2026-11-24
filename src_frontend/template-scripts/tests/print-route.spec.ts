import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leaflet browser build has no bundled declarations.
import L from "leaflet";
import {
  installBasemapController,
  type BasemapController,
  type BasemapState,
} from "../src/map/common/basemap-controller";
import type { RoutePrintState } from "../src/map/common/route-result";
import { createPrintRoute } from "../src/map/print/print-route";

const route: RoutePrintState = {
  backgroundId: 2,
  travelMode: "WALK",
  durationSeconds: 720,
  distanceMeters: 3_400,
  encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
  warnings: ["徒歩経路の注意事項"],
};
const ready: BasemapState = {
  id: "2",
  ready: true,
  pending: false,
  provider: "google",
  googleRoutesAvailable: true,
};

function createMap(zoom = 10, center: [number, number] = [38.5, -120.2]) {
  const container = document.getElementById("map")!;
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  return L.map(container).setView(center, zoom);
}

function installBackground(map: any, initial: BasemapState, minZoom = 0) {
  let background = initial;
  installBasemapController(map, {
    getState: () => background,
    getLayer: () => ({ getGoogleRoutesBackground: () => ({ id: 2, minZoom, maxZoom: 22 }) }),
  } as BasemapController);
  return (next: BasemapState) => {
    background = next;
    map.fire("basemapstatechange");
  };
}

function createRenderer() {
  const line = {
    addTo: vi.fn(),
    remove: vi.fn(),
    getBounds: () => L.latLngBounds([38.5, -120.2], [43.252, -126.453]),
  };
  const polyline = vi.fn(() => line);
  return { line, leaflet: { ...L, polyline } };
}

describe("印刷の経路表示", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div>';
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("同じGoogle背景でのみ表示し、切替後に復帰しても印刷地図内だけで消去できる", () => {
    const map = createMap();
    const container = map.getContainer();
    const changeBackground = installBackground(map, {
      ...ready,
      ready: false,
      googleRoutesAvailable: false,
    });
    const { line, leaflet } = createRenderer();
    const onChange = vi.fn();
    const preview = createPrintRoute(map, leaflet, route, onChange);
    try {
      expect(leaflet.polyline).not.toHaveBeenCalled();
      changeBackground({ ...ready, id: "3" });
      expect(leaflet.polyline).not.toHaveBeenCalled();
      changeBackground(ready);
      expect(leaflet.polyline).toHaveBeenCalledWith(expect.any(Array), {
        className: "route-search-line route-search-print-line",
        color: expect.any(String),
        weight: expect.any(Number),
        opacity: expect.any(Number),
        interactive: false,
      });
      expect(line.addTo).toHaveBeenCalledOnce();
      expect(container.querySelector(".route-search-status")?.textContent).toBe(
        "徒歩・約12分・3.4 km",
      );
      expect(container.querySelector(".route-search-warnings li")?.textContent).toBe(
        "徒歩経路の注意事項",
      );
      changeBackground({ ...ready, id: "1", provider: "generic", googleRoutesAvailable: false });
      expect(line.remove).toHaveBeenCalledOnce();
      changeBackground(ready);
      expect(line.addTo).toHaveBeenCalledTimes(2);
      const remove = container.querySelector<HTMLButtonElement>(".route-search-actions button")!;
      expect(remove.textContent).toBe("経路を消す");
      remove.click();
      expect(line.remove).toHaveBeenCalledTimes(2);
      changeBackground(ready);
      expect(line.addTo).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      preview.dispose();
      map.remove();
    }
  });

  it("復号できないポリラインでも印刷地図を開ける", () => {
    const map = createMap();
    installBackground(map, ready);
    const { leaflet } = createRenderer();
    const onChange = vi.fn();
    const preview = createPrintRoute(map, leaflet, { ...route, encodedPolyline: "~~~~" }, onChange);
    try {
      expect(leaflet.polyline).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector(".route-search-panel")).toBeNull();
    } finally {
      preview.dispose();
      map.remove();
    }
  });

  it("経路が用紙からはみ出す場合は初回だけ全体を収め、背景に戻っても再調整しない", () => {
    const map = createMap();
    const changeBackground = installBackground(map, ready, 2);
    const { line, leaflet } = createRenderer();
    const fitBounds = vi.spyOn(map, "fitBounds");
    const preview = createPrintRoute(map, leaflet, route, vi.fn());
    try {
      expect(fitBounds).toHaveBeenCalledExactlyOnceWith(
        line.getBounds(),
        expect.objectContaining({ padding: L.point(24, 24), maxZoom: 10, animate: false }),
      );
      const visibleArea = L.latLngBounds(
        map.containerPointToLatLng([24, 24]),
        map.containerPointToLatLng([376, 276]),
      );
      expect(visibleArea.contains(line.getBounds())).toBe(true);
      map.setView([38.5, -120.2], 10);
      changeBackground({ ...ready, id: "1", provider: "generic", googleRoutesAvailable: false });
      changeBackground(ready);
      expect(fitBounds).toHaveBeenCalledOnce();
      expect(map.getCenter()).toEqual(L.latLng(38.5, -120.2));
      expect(map.getZoom()).toBe(10);
    } finally {
      preview.dispose();
      map.remove();
    }
  });

  it("経路が余白内に収まる場合は元の中心・ズームを保つ", () => {
    const center: [number, number] = [40.876, -123.3265];
    const map = createMap(4, center);
    installBackground(map, ready, 2);
    const { leaflet } = createRenderer();
    const fitBounds = vi.spyOn(map, "fitBounds");
    const preview = createPrintRoute(map, leaflet, route, vi.fn());
    try {
      expect(fitBounds).not.toHaveBeenCalled();
      expect(map.getCenter()).toEqual(L.latLng(center));
      expect(map.getZoom()).toBe(4);
    } finally {
      preview.dispose();
      map.remove();
    }
  });

  it("経路全体を収めるズームがGoogle背景の範囲外なら最小ズームに留める", () => {
    const map = createMap();
    installBackground(map, ready, 8);
    const { line, leaflet } = createRenderer();
    const fitBounds = vi.spyOn(map, "fitBounds");
    const setView = vi.spyOn(map, "setView");
    const preview = createPrintRoute(map, leaflet, route, vi.fn());
    try {
      expect(fitBounds).not.toHaveBeenCalled();
      expect(setView).toHaveBeenCalledExactlyOnceWith(
        line.getBounds().getCenter(),
        8,
        expect.objectContaining({ animate: false }),
      );
      expect(map.getZoom()).toBe(8);
    } finally {
      preview.dispose();
      map.remove();
    }
  });
});
