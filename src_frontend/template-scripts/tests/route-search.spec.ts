import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leaflet browser build has no bundled declarations.
import L from "leaflet";
import {
  installBasemapController,
  type BasemapController,
} from "../src/map/common/basemap-controller";
import {
  clearRecentUserLocation,
  getRecentUserLocation,
  rememberUserLocation,
  USER_LOCATION_MAX_AGE_MS,
} from "../src/map/common/marker";
import { createRouteSearch, ROUTE_LOCATION_REQUIRED_MESSAGE } from "../src/map/common/route-search";

const destination = { lat: 35.69, lng: 139.72 };
const origin = { lat: 35.68, lng: 139.7 };
const destinationUrl = "https://www.google.com/maps/search/?api=1&query=35.69%2C139.72";
const locationUnavailable = "現在位置を取得できませんでした。時間をおいて再試行してください。";
const locationTimeout = "現在位置の取得に時間がかかっています。時間をおいて再試行してください。";
const route = {
  durationSeconds: 720,
  distanceMeters: 3_400,
  encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
  warnings: ["<strong>上流の注意事項</strong>"],
};

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function control(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".route-search-actions button"),
  ].find((item) => item.textContent === label);
  if (!button) throw Error(`経路操作が見つかりません: ${label}`);
  return button;
}

function googleMapsLink() {
  return document.querySelector<HTMLAnchorElement>("a.route-search-google-link");
}

describe("経路検索", () => {
  let map: any;
  let request: ReturnType<typeof createRouteSearch>;
  let ready: boolean, enabled: boolean, useGoogle: boolean;
  let osrmModes: Array<"DRIVE" | "WALK">;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let locate: ReturnType<typeof vi.fn<Geolocation["getCurrentPosition"]>>;
  const originalSvg = L.Browser.svg;
  const position = (timestamp = Date.now()) =>
    ({ coords: { latitude: origin.lat, longitude: origin.lng }, timestamp }) as GeolocationPosition;

  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div>';
    const container = document.getElementById("map")!;
    Object.defineProperties(container, {
      clientWidth: { value: 500 },
      clientHeight: { value: 420 },
    });
    L.Browser.svg = true;
    map = L.map(container).setView([38.5, -120.2], 10);
    ready = true;
    enabled = true;
    useGoogle = true;
    osrmModes = [];
    installBasemapController(map, {
      getLayer: () => ({
        getGoogleRoutesBackground: () => (enabled ? { id: 2, minZoom: 8, maxZoom: 18 } : undefined),
      }),
    } as BasemapController);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    locate = vi.fn((success: PositionCallback) => success(position()));
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: locate } });
    fetcher = vi.fn(async () => Response.json({ route }));
    vi.stubGlobal("fetch", fetcher);
    request = createRouteSearch({
      map,
      leaflet: L,
      osrmModes,
      basemap: () => ({
        id: useGoogle ? "2" : "1",
        ready,
        pending: !ready,
        provider: useGoogle ? "google" : "generic",
        minZoom: 9,
        maxZoom: 16,
        googleRoutesAvailable: ready && useGoogle,
      }),
    });
  });

  afterEach(() => {
    map?.remove();
    L.Browser.svg = originalSvg;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("Google背景と利用設定が有効なときだけ、同意後に検索する", async () => {
    ready = false;
    request.search(destination, vi.fn());
    expect(request.isAvailable()).toBe(false);
    ready = true;
    enabled = false;
    request.search(destination, vi.fn());
    expect(window.confirm).not.toHaveBeenCalled();
    enabled = true;
    vi.mocked(window.confirm).mockReturnValue(false);
    request.search(destination, vi.fn());
    await settle();
    expect(request.isAvailable()).toBe(true);
    expect(locate).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("OSRMは経路設定のある準備済みの非Google背景でのみ使える", () => {
    useGoogle = false;
    expect(request.isAvailable()).toBe(false);
    request.search(destination, vi.fn());
    osrmModes.push("DRIVE");
    ready = false;
    expect(request.isAvailable()).toBe(false);
    request.search(destination, vi.fn());
    ready = true;
    expect(request.isAvailable()).toBe(true);
    useGoogle = true;
    enabled = false;
    expect(request.isAvailable()).toBe(false);
    request.search(destination, vi.fn());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("車だけのOSRM構成で経路とOSM出典を表示する", async () => {
    useGoogle = false;
    osrmModes.push("DRIVE");
    request.search(destination, vi.fn());
    await settle();

    expect(fetcher.mock.calls[0]?.[0]).toBe("/osrm/routes/compute");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      backgroundId: 1,
      origin,
      destination,
      travelMode: "DRIVE",
    });
    expect(control("車").hidden).toBe(false);
    expect(control("徒歩").hidden).toBe(true);
    expect(control("車").getAttribute("aria-pressed")).toBe("true");
    expect(map.getZoom()).toBe(9);
    expect(googleMapsLink()).toBeNull();
    const attribution = document.querySelector<HTMLAnchorElement>(".route-search-attribution a");
    expect(attribution?.textContent).toBe("OpenStreetMap contributors");
    expect(attribution?.href).toBe("https://www.openstreetmap.org/copyright");
    expect(request.getPrintRoute()).toEqual({
      backgroundId: 1,
      provider: "osrm",
      travelMode: "DRIVE",
      ...route,
    });

    map.fire("basemapwillchange");
    expect(document.querySelector(".route-search-line, .route-search-attribution")).toBeNull();
    expect(request.getPrintRoute()).toBeUndefined();
  });

  it("OSRMとGoogleの同意を分け、徒歩だけの構成では徒歩を最初に選ぶ", async () => {
    osrmModes.push("WALK");
    request.search(destination, vi.fn());
    await settle();
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("Google Maps に送信"));

    map.fire("basemapwillchange");
    useGoogle = false;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    request.search(destination, vi.fn());
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("（OSRM）に送信"));
    expect(fetcher).toHaveBeenCalledOnce();

    request.search(destination, vi.fn());
    await settle();
    expect(control("車").hidden).toBe(true);
    expect(control("徒歩").getAttribute("aria-pressed")).toBe("true");
    expect(request.getPrintRoute()).toMatchObject({ travelMode: "WALK", warnings: route.warnings });

    map.fire("basemapwillchange");
    useGoogle = true;
    request.search(destination, vi.fn());
    await settle();
    expect(window.confirm).toHaveBeenCalledTimes(3);
    expect(control("車").hidden).toBe(false);
    expect(control("徒歩").hidden).toBe(false);
    expect(googleMapsLink()?.href).toBe(destinationUrl);
    expect(document.querySelector(".route-search-attribution")).toBeNull();
  });

  it("権限拒否・測位不能・タイムアウトを区別し、経路APIへ送信しない", async () => {
    const failure = vi.fn();
    for (const code of [1, 2, 3]) {
      locate.mockImplementationOnce((_, reject) => reject?.({ code } as GeolocationPositionError));
      request.search(destination, failure);
      await settle();
    }
    expect(failure.mock.calls).toEqual([
      [ROUTE_LOCATION_REQUIRED_MESSAGE],
      [locationUnavailable],
      [locationTimeout],
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector(".route-search-panel")).toBeNull();
  });

  it("取得済みの現在位置があれば、再測位せず経路APIへ送る", async () => {
    rememberUserLocation(map, position());
    const failure = vi.fn();
    request.search(destination, failure);
    expect(locate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).origin).toEqual(origin);
    await settle();
    expect(failure).not.toHaveBeenCalled();
  });

  it("保存位置が古いときは低精度を許容して再測位し、取得結果を再利用する", async () => {
    rememberUserLocation(map, position());
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + USER_LOCATION_MAX_AGE_MS + 1);
    request.search(destination, vi.fn());
    expect(locate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: false,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: 10_000,
    });
    await settle();
    control("徒歩").click();
    await settle();
    expect(locate).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([2, 3])(
    "単発測位が失敗しても、その間に地図が取得した位置を使う (code %i)",
    async (code) => {
      let rejectPosition!: PositionErrorCallback;
      locate.mockImplementationOnce((_, reject) => {
        rejectPosition = reject!;
      });
      const failure = vi.fn();
      request.search(destination, failure);
      rememberUserLocation(map, position());
      rejectPosition({ code } as GeolocationPositionError);
      await settle();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).origin).toEqual(origin);
      expect(failure).not.toHaveBeenCalled();
    },
  );

  it("権限が取り消されていたら直近の位置を破棄し、経路APIへ送信しない", async () => {
    rememberUserLocation(map, position());
    const query = vi.fn(async () => ({ state: "denied" }));
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: locate },
      permissions: { query },
    });
    const failure = vi.fn();
    request.search(destination, failure);
    await settle();
    expect(query).toHaveBeenCalledWith({ name: "geolocation" });
    expect(failure).toHaveBeenCalledWith(ROUTE_LOCATION_REQUIRED_MESSAGE);
    expect(getRecentUserLocation(map)).toBeUndefined();
    expect(locate).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("権限を再確認する必要があれば測位の結果を待つ", async () => {
    rememberUserLocation(map, position());
    const query = vi.fn(async () => ({ state: "prompt" }));
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: locate },
      permissions: { query },
    });
    let finishPosition!: PositionCallback;
    locate.mockImplementationOnce((success) => {
      finishPosition = success;
    });
    request.search(destination, vi.fn());
    await settle();
    expect(locate).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    finishPosition(position());
    await settle();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("車の経路を描き、徒歩に切り替えると同じ目的地を検索する", async () => {
    expect(googleMapsLink()).toBeNull();
    request.search(destination, vi.fn());
    request.search(destination, vi.fn());
    expect(request.getPrintRoute()).toBeUndefined();
    expect(googleMapsLink()).toBeNull();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("/google-maps/routes/compute");
    expect(options).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      backgroundId: 2,
      origin,
      destination,
      travelMode: "DRIVE",
    });
    expect(document.querySelector(".route-search-status")?.textContent).toBe("約12分・3.4 km");
    expect(document.querySelectorAll(".route-search-line")).toHaveLength(1);
    expect(document.querySelector(".route-search-warnings strong")).toBeNull();
    const link = googleMapsLink();
    expect(link?.textContent).toBe("Google Map で開く");
    expect(link?.href).toBe(destinationUrl);
    expect(link?.target).toBe("_blank");
    expect(link?.relList.contains("noopener")).toBe(true);
    expect(link?.relList.contains("noreferrer")).toBe(true);
    link!.addEventListener("click", (event) => event.preventDefault(), { once: true });
    link!.click();
    await settle();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(map.getZoom()).toBe(8);
    const printRoute = request.getPrintRoute();
    expect(printRoute).toEqual({ backgroundId: 2, travelMode: "DRIVE", ...route });
    printRoute!.warnings.length = 0;
    expect(request.getPrintRoute()?.warnings).toEqual(route.warnings);

    request.cancelPending();
    expect(document.querySelectorAll(".route-search-line")).toHaveLength(1);
    control("徒歩").click();
    expect(googleMapsLink()).toBeNull();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      backgroundId: 2,
      origin,
      destination,
      travelMode: "WALK",
    });
    expect(control("徒歩").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".route-search-warnings")?.textContent).toContain(
      "徒歩経路はベータ版",
    );
    expect(document.querySelectorAll(".route-search-line")).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(request.getPrintRoute()).toMatchObject({ travelMode: "WALK", backgroundId: 2 });
    expect(googleMapsLink()?.href).toBe(destinationUrl);
    control("経路を消す").click();
    expect(document.querySelector(".route-search-line, .route-search-panel")).toBeNull();
    expect(request.getPrintRoute()).toBeUndefined();
    expect(googleMapsLink()).toBeNull();
  });

  it("経路検索が失敗した場合や背景地図を切り替えた場合はリンクが消える", async () => {
    request.search(destination, vi.fn());
    await settle();
    expect(googleMapsLink()?.href).toBe(destinationUrl);

    fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    control("徒歩").click();
    await settle();
    expect(googleMapsLink()).toBeNull();

    control("車").click();
    await settle();
    expect(googleMapsLink()?.href).toBe(destinationUrl);
    map.fire("basemapwillchange", { provider: "generic" });
    expect(googleMapsLink()).toBeNull();
  });

  it("検索中のポップアップ閉鎖や背景切替で古い結果を破棄する", async () => {
    let finishPosition!: PositionCallback;
    locate.mockImplementationOnce((success) => {
      finishPosition = success;
    });
    request.search(destination, vi.fn());
    request.cancelPending();
    finishPosition(position());
    await settle();
    expect(fetcher).not.toHaveBeenCalled();

    let finishFetch!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    );
    request.search(destination, vi.fn());
    await settle();
    map.fire("basemapwillchange", { provider: "generic" });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    ready = false;
    map.fire("basemapstatechange");
    finishFetch(Response.json({ route }));
    await settle();
    expect(document.querySelector(".route-search-line, .route-search-panel")).toBeNull();
  });

  it("経路なしや徒歩切替時の位置取得失敗を結果欄に表示する", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ route: null }));
    request.search(destination, vi.fn());
    await settle();
    expect(document.querySelector(".route-search-status")?.textContent).toContain(
      "経路が見つかりませんでした",
    );
    expect(googleMapsLink()).toBeNull();
    clearRecentUserLocation(map);
    locate.mockImplementationOnce((_, reject) => reject?.({ code: 3 } as GeolocationPositionError));
    control("徒歩").click();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".route-search-status")?.textContent).toBe(locationTimeout);
    expect(document.querySelector(".route-search-line")).toBeNull();
    expect(googleMapsLink()).toBeNull();
  });

  it("位置取得非対応時は確認ダイアログより先に指定のエラーを表示する", () => {
    vi.stubGlobal("navigator", {});
    const failure = vi.fn();
    request.search(destination, failure);
    expect(failure).toHaveBeenCalledOnce();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["google-maps", "osrm"])(
    "%s はセッション更新後に同じ経路APIで再試行する",
    async (service) => {
      useGoogle = service === "google-maps";
      osrmModes.push("DRIVE");
      const endpoint = `/${service}/routes/compute`;
      fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
      fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
      request.search(destination, vi.fn());
      await settle();
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        endpoint,
        "/account/refresh",
        endpoint,
      ]);
      expect(fetcher.mock.calls[1]?.[1]?.body).toBe("{}");
      expect(document.querySelector(".route-search-line")).not.toBeNull();
    },
  );
});
