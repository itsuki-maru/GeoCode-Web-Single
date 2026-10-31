import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leaflet は、型宣言を同梱していないブラウザー向けの依存ライブラリである。
import L from "leaflet";
const dependencies = vi.hoisted(() => ({
  published: vi.fn(),
  overlays: vi.fn(),
  focus: vi.fn(),
  sync: vi.fn(),
  geoError: null as any,
  cameras: [] as any[],
}));
vi.mock("../src/live-map/published-layers", () => ({
  addPublishedLayerControl: dependencies.published,
}));
vi.mock("../src/live-map/tile-overlays", () => ({
  addLiveTileOverlayControl: dependencies.overlays,
}));
vi.mock("../src/live-map/ui-visibility", () => ({
  createLiveMapUiVisibilityControl: (leaflet: any) => {
    const c = leaflet.control();
    c.onAdd = () => document.createElement("div");
    return c;
  },
}));
vi.mock("../src/live-map/controls", async () => ({
  focusSharedLocation: dependencies.focus,
  createCollapsibleLayerControl: () => ({ sync: dependencies.sync }),
  createNameVisibilityControl: ({ leaflet }: any) => {
    const control = leaflet.control();
    control.onAdd = () => document.createElement("div");
    return { control, syncMarker: vi.fn() };
  },
  createCurrentLocationControl: ({ leaflet, onError }: any) => {
    dependencies.geoError = onError;
    const c = leaflet.control();
    c.onAdd = () => document.createElement("div");
    return c;
  },
}));
vi.mock("../src/live-map/camera", () => ({
  CameraViewer: class {
    element = document.createElement("div");
    open = vi.fn();
    close = vi.fn();
    constructor() {
      dependencies.cameras.push(this);
    }
  },
}));
let map: any;
let handlers: [string, EventListener][];
const person = (overrides = {}) => ({
  id: "person",
  display_name: "<車両>",
  marker_color: "#008800",
  status: "live",
  latitude: 35,
  longitude: 139,
  accuracy_m: 1,
  heading_deg: null,
  speed_mps: null,
  observed_at: null,
  received_at: "2026-01-01T00:00:00Z",
  ...overrides,
});
const snapshot = (positions = [person()], extra = {}) => ({
  map: { name: "共有地図" },
  server_time: "2026-01-01T00:00:00Z",
  positions,
  refresh_after_ms: 1000,
  ...extra,
});
const response = (body: any, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
});
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  dependencies.cameras.length = 0;
  handlers = [];
  const listen = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    name: string,
    handler: EventListener,
    options: any,
  ) => {
    handlers.push([name, handler]);
    listen(name, handler, options);
  }) as any);
  const create = L.map;
  vi.spyOn(L, "map").mockImplementation(((...args: any[]) => {
    map = create(...args);
    return map;
  }) as any);
  vi.stubGlobal("L", L);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  document.body.innerHTML =
    '<div id="map"></div><h1 id="map-title"></h1><span id="connection-status"></span><div id="error"></div><ul id="vehicle-list"></ul>';
  (window as any).__GEOCODE_LIVE_MAP_BOOTSTRAP__ = {
    publicId: "public",
    publishedLayers: [],
    tileServers: {},
    cameraEnabled: true,
  };
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  handlers.forEach(([name, handler]) => window.removeEventListener(name, handler));
  map?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const start = async (fetcher: any, options = {}) => {
  Object.assign((window as any).__GEOCODE_LIVE_MAP_BOOTSTRAP__, options);
  vi.stubGlobal("fetch", fetcher);
  await import("../src/entries/live-map");
  await flush();
};
const markerLayers = () =>
  Object.values((map as any)._layers).filter((layer: any) => layer instanceof L.Marker) as any[];

describe("live map polling and rendering", () => {
  it("renders escaped names, moves and renames markers, then removes missing locations and members", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot()))
      .mockResolvedValueOnce(
        response(
          snapshot([
            person({ display_name: "更新車両", latitude: 36, longitude: 140, status: "stale" }),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        response(
          snapshot([
            person({ latitude: null, longitude: null, status: "offline", received_at: null }),
          ]),
        ),
      )
      .mockResolvedValue(response(snapshot([])));
    await start(fetcher);
    expect(document.getElementById("map-title")!.textContent).toBe("共有地図");
    expect(document.querySelector(".vehicle-name")!.textContent).toBe("<車両>");
    expect(document.querySelector(".vehicle-name")!.children).toHaveLength(0);
    const marker = markerLayers()[0]!;
    expect(marker.getLatLng()).toEqual(L.latLng(35, 139));
    document.querySelector<HTMLButtonElement>(".vehicle-focus")!.click();
    expect(dependencies.focus).toHaveBeenCalledWith(expect.objectContaining({ map, marker }));
    marker.fire("popupopen");
    expect(dependencies.cameras[0].open).toHaveBeenCalled();
    dependencies.cameras[0].element.classList.add("has-video");
    (marker.getPopup()!.getContent() as HTMLElement).dispatchEvent(
      new Event("camera-layoutchange"),
    );
    marker.fire("popupclose");
    expect(dependencies.cameras[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(markerLayers()[0]).toBe(marker);
    expect(marker.getLatLng()).toEqual(L.latLng(36, 140));
    expect(document.querySelector(".vehicle-name")!.textContent).toBe("更新車両");
    expect(document.body.textContent).toContain("更新遅延");
    await vi.advanceTimersByTimeAsync(1000);
    expect(markerLayers()).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>(".vehicle-focus")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("位置情報なし");
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelectorAll(".vehicle")).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledWith("/live-api/maps/public/positions", { cache: "no-store" });
  });

  it("backs off failures with fixed jitter, recovers and stops polling on pagehide", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(response(snapshot([], { refresh_after_ms: 5000 })));
    await start(fetcher);
    expect(document.getElementById("error")!.textContent).toContain("期限切れ");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.getElementById("error")!.textContent).toBe("offline");
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(document.getElementById("error")!.style.display).toBe("none");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fits multiple members, switches tile bounds and handles mobile resize and geolocation errors", async () => {
    vi.mocked(matchMedia).mockReturnValue({ matches: true } as any);
    await start(
      vi
        .fn()
        .mockResolvedValue(
          response(snapshot([person(), person({ id: "two", latitude: 36, longitude: 140 })])),
        ),
      {
        tileServers: {
          "1": { url: "https://tile.example/{z}/{x}/{y}", label: "国内" },
          "2": {
            url: "https://world.example/{z}/{x}/{y}",
            label: "世界",
            include_foreign_tiles: true,
          },
        },
      },
    );
    expect(markerLayers()).toHaveLength(2);
    expect(map.options.maxBounds).toBeTruthy();
    document
      .querySelector<HTMLInputElement>("#live-map-tile-2")!
      .dispatchEvent(new Event("change"));
    expect(map.options.maxBounds).toBeNull();
    dependencies.geoError();
    expect(document.getElementById("error")!.textContent).toContain("現在位置");
    const resize = vi.spyOn(map, "invalidateSize");
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
    vi.advanceTimersToNextFrame();
    // Leaflet も resize を監視するため、このエントリー側でまとめたリクエストだけを数える。
    expect(
      resize.mock.calls.filter(
        ([options]) => (options as { pan?: boolean } | undefined)?.pan === false,
      ),
    ).toHaveLength(1);
    expect(dependencies.sync).toHaveBeenCalled();
  });
});
