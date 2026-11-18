import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leaflet browser build has no bundled declarations.
import L from "leaflet";
import { createGoogleBasemap, googleMapsAccess } from "../src/map/common/google-basemap";
import { createBasemapController } from "../src/map/common/basemap-controller";
import type { TileServerRecord } from "../src/map/common/basemap-definition";

const google: TileServerRecord = {
  id: 2,
  label: "Google地図",
  layer_name: "google",
  kind: "raster",
  provider: "google",
  google_map_type: "roadmap",
  url: "/google-maps/tiles/{z}/{x}/{y}",
  attribution: "",
  min_zoom: 0,
  max_zoom: 22,
  include_foreign_tiles: true,
};
let map: any,
  fetcher: ReturnType<typeof vi.fn<(url: string, options?: any) => Promise<any>>>,
  handle: ReturnType<typeof createGoogleBasemap> | undefined;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
beforeEach(() => {
  document.body.innerHTML = '<div id="map"></div>';
  const container = document.getElementById("map")!;
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  map = L.map(container).setView([35, 139], 10);
  let serial = 0;
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn(() => `blob:google-${serial++}`);
  URL.revokeObjectURL = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
  vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (
    this: HTMLImageElement,
    value: string,
  ) {
    descriptor.set!.call(this, value);
    if (value.startsWith("blob:")) queueMicrotask(() => this.dispatchEvent(new Event("load")));
  });
  fetcher = vi.fn(async (url: string) => {
    if (url === "/google-maps/context")
      return {
        ok: true,
        json: async () => ({
          grant: "application-grant",
          expiresAt: Date.now() / 1000 + 600,
          tileSize: 256,
        }),
      };
    if (url.startsWith("/google-maps/viewport"))
      return {
        ok: true,
        json: async () => ({
          copyright: "Map data ©Google <script>unsafe</script>",
          maxZoomRects: [{ maxZoom: 22, north: 90, south: -90, west: -180, east: 180 }],
        }),
      };
    return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  map.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelector('meta[name="google-maps-access"]')?.remove();
  document.body.replaceChildren();
});

describe("Google background", () => {
  it("viewportの解像度を確認してから利用可能な低ズーム画像を取得する", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string) =>
      url.startsWith("/google-maps/viewport") ? pending : original(url),
    );
    handle = createGoogleBasemap(L, map, google);
    handle.layer.addTo(map);
    await tick();
    expect(fetcher.mock.calls.some(([url]) => url.startsWith("/google-maps/tiles/"))).toBe(false);
    release({
      ok: true,
      json: async () => ({
        copyright: "Google data",
        maxZoomRects: [{ north: 90, south: -90, west: -180, east: 180, maxZoom: 4 }],
      }),
    });
    await handle.ready;
    const tiles = fetcher.mock.calls
      .map(([url]) => url)
      .filter((url) => url.startsWith("/google-maps/tiles/"));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((url) => url.startsWith("/google-maps/tiles/4/"))).toBe(true);
    expect(map.getZoom()).toBe(10);
  });

  it("短時間grantの期限前に更新し、移動後の最新の出典だけを表示する", async () => {
    handle = createGoogleBasemap(L, map, google);
    handle.layer.addTo(map);
    await handle.ready;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 541000);
    let stale!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      stale = resolve;
    });
    let viewportCalls = 0;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string) => {
      if (!url.startsWith("/google-maps/viewport")) return original(url);
      viewportCalls++;
      return viewportCalls === 1
        ? old
        : Promise.resolve({
            ok: true,
            json: async () => ({
              copyright: "Latest attribution",
              maxZoomRects: [{ north: 90, south: -90, west: -180, east: 180, maxZoom: 22 }],
            }),
          });
    });
    map.fire("moveend");
    await tick();
    map.fire("moveend");
    await tick();
    stale({ ok: true, json: async () => ({ copyright: "Stale attribution" }) });
    await tick();
    expect(fetcher.mock.calls.filter(([url]) => url === "/google-maps/context")).toHaveLength(2);
    expect(map.getContainer().textContent).toContain("Latest attribution");
    expect(map.getContainer().textContent).not.toContain("Stale attribution");
  });
  it("waits for viewport and images, shares a grant and safely displays attribution only when visible", async () => {
    const meta = document.createElement("meta");
    meta.name = "google-maps-access";
    meta.content = "share-access";
    document.head.append(meta);
    expect(googleMapsAccess()).toBe("share-access");
    handle = createGoogleBasemap(L, map, google);
    handle.setVisible(false);
    handle.layer.addTo(map);
    await handle.ready;
    expect(fetcher.mock.calls.filter(([url]) => url === "/google-maps/context")).toHaveLength(1);
    const context = (fetcher.mock.calls as any[]).find(([url]) => url === "/google-maps/context");
    expect(JSON.parse(context[1].body)).toEqual({ backgroundId: google.id, access: "share-access" });
    expect(map.getContainer().querySelector(".google-maps-attribution")).toBeNull();
    handle.setVisible(true);
    expect(map.getContainer().querySelector('img[alt="Google Maps"]')).not.toBeNull();
    expect(map.getContainer().querySelector("script")).toBeNull();
    expect(map.getContainer().textContent).toContain("<script>unsafe</script>");
    expect(handle.layer.getPrintStatus()).toEqual({ loading: false, failed: false });
    const call = (fetcher.mock.calls as any[]).find(([url]) =>
      url.startsWith("/google-maps/tiles/"),
    );
    expect(call[1].headers.Authorization).toBe("Bearer application-grant");
    handle.setVisible(false);
    expect(map.getContainer().querySelector(".google-maps-attribution")).toBeNull();
    handle.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("reports committed Google readiness and disables future route display before fallback", async () => {
    const generic = {
      ...google,
      id: 1,
      provider: "generic" as const,
      google_map_type: null,
      url: "/generic/{z}/{x}/{y}",
    };
    const events: any[] = [];
    map.on("basemapstatechange", (event: any) => events.push(event));
    const controller = createBasemapController({
      leaflet: L,
      map,
      tileServers: { "1": generic, "2": google },
      bounds: null,
    });
    expect(await controller.select("2")).toBe(true);
    expect(controller.getState()).toMatchObject({
      provider: "google",
      ready: true,
      googleRoutesAvailable: true,
    });
    fetcher.mockResolvedValue({ ok: false, status: 403 });
    map.fire("moveend");
    await tick();
    expect(controller.getSelectedId()).toBe("1");
    expect(controller.getState().googleRoutesAvailable).toBe(false);
    expect(map.getContainer().querySelector('img[alt="Google Maps"]')).toBeNull();
    expect(
      events.some((event) => event.provider === "google" && !event.googleRoutesAvailable),
    ).toBe(true);
    controller.dispose();
  });

  it("通常背景への切り替えでGoogleの出典と移動イベントを解除する", async () => {
    const generic = {
      ...google,
      id: 1,
      provider: "generic" as const,
      google_map_type: null,
      url: "/generic/{z}/{x}/{y}",
    };
    const controller = createBasemapController({
      leaflet: L,
      map,
      tileServers: { "1": generic, "2": google },
      bounds: null,
    });
    await controller.select("2");
    expect(map.getContainer().querySelector('img[alt="Google Maps"]')).not.toBeNull();
    await controller.select("1");
    expect(map.getContainer().querySelector('img[alt="Google Maps"]')).toBeNull();
    const count = fetcher.mock.calls.length;
    map.fire("moveend");
    await tick();
    expect(fetcher.mock.calls.length).toBe(count);
    controller.dispose();
  });

  it("aborts unfinished initialization on a rapid switch without committing Google", async () => {
    fetcher.mockImplementation(
      (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const generic = {
      ...google,
      id: 1,
      provider: "generic" as const,
      google_map_type: null,
      url: "/generic/{z}/{x}/{y}",
    };
    const controller = createBasemapController({
      leaflet: L,
      map,
      tileServers: { "1": generic, "2": google },
      bounds: null,
    });
    const loading = controller.select("2");
    await controller.select("1");
    expect(await loading).toBe(false);
    expect(controller.getState()).toMatchObject({
      provider: "generic",
      googleRoutesAvailable: false,
    });
    expect((fetcher.mock.calls as any[])[0][1].signal.aborted).toBe(true);
    controller.dispose();
  });
});
