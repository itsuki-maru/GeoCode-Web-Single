import { getBasemapController, type BasemapState } from "./basemap-controller";
import { createGoogleMapLink, googleMapLocationUrl } from "./google-map-link";
import {
  clearRecentUserLocation,
  getRecentUserLocation,
  rememberUserLocation,
  USER_LOCATION_MAX_AGE_MS,
} from "./marker";
import { createRoutePanel } from "./route-panel";
import {
  createOsrmAttribution,
  decodePolyline,
  formatSummary,
  isRoutePrintState,
  ROUTE_LINE_OPTIONS,
  validPoint,
  type RoutePrintState,
} from "./route-result";

type Coordinates = { lat: number; lng: number };
type TravelMode = RoutePrintState["travelMode"];
type RouteProvider = NonNullable<RoutePrintState["provider"]>;
type RouteBackground = {
  id: number;
  provider: RouteProvider;
  modes: readonly TravelMode[];
  minZoom: number;
  maxZoom: number;
};
type RouteLayer = { addTo(map: any): RouteLayer; remove(): void; getBounds(): any };
type LocationErrorHandler = (message: string) => void;
type SearchRequest = {
  background: RouteBackground;
  destination: Coordinates;
  mode: TravelMode;
  abort: AbortController;
  onLocationError?: LocationErrorHandler;
};

export const ROUTE_LOCATION_REQUIRED_MESSAGE = "使用するには現在位置の取得を有効にしてください";
const LOCATION_UNAVAILABLE_MESSAGE =
  "現在位置を取得できませんでした。時間をおいて再試行してください。";
const LOCATION_TIMEOUT_MESSAGE =
  "現在位置の取得に時間がかかっています。時間をおいて再試行してください。";
const ROUTE_SERVICES = {
  google: {
    endpoint: "/google-maps/routes/compute",
    locationNotice:
      "経路検索のため、現在位置と目的地の座標を Google Maps に送信します。現在位置の利用と送信を許可しますか？",
  },
  osrm: {
    endpoint: "/osrm/routes/compute",
    locationNotice:
      "経路検索のため、現在位置と目的地の座標を管理者が設定した経路検索サーバー（OSRM）に送信します。現在位置の利用と送信を許可しますか？",
  },
} as const;
const GOOGLE_MODES: readonly TravelMode[] = ["DRIVE", "WALK"];
const WALK_WARNING = "徒歩経路はベータ版です。歩道や歩行者用通路が経路に含まれない場合があります。";
const SEARCH_ERROR = "経路を取得できませんでした。時間をおいて再試行してください。";
const PERMISSION_DENIED = 1;
const POSITION_TIMEOUT = 3;

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    const geolocation = navigator.geolocation;
    if (!geolocation) {
      reject({ code: PERMISSION_DENIED });
      return;
    }
    geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: 10_000,
    });
  });
}

async function locationPermission(): Promise<PermissionState | undefined> {
  try {
    return (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch {
    // 権限状態の照会に対応しないブラウザーでは、測位結果で判断する。
    return undefined;
  }
}

function requestError(status: number): string {
  if (status === 401) return "ログインし直してから経路を検索してください。";
  if (status === 403) return "この地図では経路検索を利用できません。";
  if (status === 429) return "経路検索の利用上限に達しました。時間をおいて再試行してください。";
  return SEARCH_ERROR;
}

export function createRouteSearch({
  map,
  leaflet,
  basemap,
  osrmModes = [],
}: {
  map: any;
  leaflet: any;
  basemap: () => BasemapState;
  osrmModes?: readonly TravelMode[];
}) {
  let pending: SearchRequest | undefined;
  let layer: RouteLayer | undefined;
  let displayedRoute: RoutePrintState | undefined;
  let destination: Coordinates | undefined;
  let mode: TravelMode = "DRIVE";
  const consent = new Set<RouteProvider>();
  let disposed = false;
  const panel = createRoutePanel({ mapElement: map.getContainer() });
  const { actions, status, warningList } = panel;
  const googleMapLink = createGoogleMapLink(panel.element.ownerDocument);
  googleMapLink.className = "route-search-google-link";
  const osrmAttribution = createOsrmAttribution(panel.element.ownerDocument);

  const getBackground = (): RouteBackground | undefined => {
    if (disposed) return;
    const state = basemap();
    if (state.provider === "google") {
      if (!state.googleRoutesAvailable) return;
      const background = getBasemapController(map)?.getLayer()?.getGoogleRoutesBackground?.();
      if (background) return { ...background, provider: "google", modes: GOOGLE_MODES };
      return;
    }
    if (!state.ready || osrmModes.length === 0) return;
    const id = Number(state.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    return {
      id,
      provider: "osrm",
      modes: osrmModes,
      minZoom: state.minZoom ?? map.getMinZoom(),
      maxZoom: state.maxZoom ?? map.getMaxZoom(),
    };
  };
  const cancel = () => {
    pending?.abort.abort();
    pending = undefined;
  };
  const removeLine = () => {
    layer?.remove();
    layer = undefined;
    displayedRoute = undefined;
    googleMapLink.remove();
    osrmAttribution.remove();
  };
  const clear = () => {
    cancel();
    removeLine();
    destination = undefined;
    panel.hide();
  };
  const checkAvailability = () => {
    if (!getBackground()) clear();
  };
  const isCurrent = (request: SearchRequest): boolean => {
    if (pending !== request) return false;
    const background = getBackground();
    return (
      background?.id === request.background.id &&
      background.provider === request.background.provider
    );
  };

  function button(label: string, onClick: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", onClick);
    actions.append(element);
    return element;
  }
  const switchMode = (next: TravelMode) => {
    if (destination && (mode !== next || (!layer && !pending))) void start(destination, next);
  };
  const drive = button("車", () => switchMode("DRIVE"));
  const walk = button("徒歩", () => switchMode("WALK"));
  button("経路を消す", clear);

  async function start(
    point: Coordinates,
    requestedMode?: TravelMode,
    onLocationError?: LocationErrorHandler,
  ) {
    const background = getBackground();
    if (!background || !validPoint(point)) return;
    const { provider, modes } = background;
    const next = requestedMode ?? (modes.includes("DRIVE") ? "DRIVE" : "WALK");
    if (!modes.includes(next)) return;
    if (
      pending?.mode === next &&
      pending.background.id === background.id &&
      pending.background.provider === provider &&
      pending.destination.lat === point.lat &&
      pending.destination.lng === point.lng
    )
      return;
    if (!navigator.geolocation && onLocationError) {
      clearRecentUserLocation(map);
      clear();
      onLocationError(ROUTE_LOCATION_REQUIRED_MESSAGE);
      return;
    }
    const service = ROUTE_SERVICES[provider];
    if (!consent.has(provider)) {
      if (!window.confirm(service.locationNotice)) return;
      consent.add(provider);
    }

    cancel();
    removeLine();
    destination = point;
    mode = next;
    drive.hidden = !modes.includes("DRIVE");
    walk.hidden = !modes.includes("WALK");
    drive.setAttribute("aria-pressed", String(mode === "DRIVE"));
    walk.setAttribute("aria-pressed", String(mode === "WALK"));
    warningList.replaceChildren();
    status.textContent = "経路を検索しています…";
    panel.show();

    const request: SearchRequest = {
      background,
      destination: point,
      mode: next,
      abort: new AbortController(),
      onLocationError,
    };
    pending = request;
    try {
      let origin = navigator.geolocation ? getRecentUserLocation(map) : undefined;
      let locationErrorCode: unknown;
      try {
        if (origin && navigator.permissions) {
          const permission = await locationPermission();
          if (!isCurrent(request)) return;
          if (permission === "denied") throw { code: PERMISSION_DENIED };
          if (permission === "prompt") clearRecentUserLocation(map);
          origin = getRecentUserLocation(map);
        }
        if (!origin) {
          status.textContent = "現在位置を取得しています…";
          const measured = await currentPosition();
          if (!isCurrent(request)) return;
          rememberUserLocation(map, measured);
          origin = getRecentUserLocation(map);
        }
      } catch (error) {
        if (!isCurrent(request)) return;
        locationErrorCode =
          error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (locationErrorCode === PERMISSION_DENIED) clearRecentUserLocation(map);
        // 単発測位を待つ間に地図の位置監視から届いた位置も使える。
        origin = getRecentUserLocation(map);
      }
      if (!isCurrent(request)) return;
      if (!origin) {
        const message =
          locationErrorCode === PERMISSION_DENIED
            ? ROUTE_LOCATION_REQUIRED_MESSAGE
            : locationErrorCode === POSITION_TIMEOUT
              ? LOCATION_TIMEOUT_MESSAGE
              : LOCATION_UNAVAILABLE_MESSAGE;
        if (onLocationError) {
          clear();
          onLocationError(message);
        } else {
          status.textContent = message;
        }
        return;
      }

      status.textContent = "経路を検索しています…";
      const init: RequestInit = {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        signal: request.abort.signal,
        body: JSON.stringify({
          backgroundId: background.id,
          origin,
          destination: point,
          travelMode: next,
        }),
      };
      let response = await fetch(service.endpoint, init);
      if (!isCurrent(request)) return;
      if (response.status === 401) {
        const renewed = await fetch("/account/refresh", { ...init, body: "{}" });
        if (!isCurrent(request)) return;
        if (renewed.ok) response = await fetch(service.endpoint, init);
      }
      if (!isCurrent(request)) return;
      if (!response.ok) {
        status.textContent = requestError(response.status);
        return;
      }
      const { route } = await response.json();
      if (!isCurrent(request)) return;
      if (route === null) {
        status.textContent = "この移動手段で利用できる経路が見つかりませんでした。";
        return;
      }
      if (!route || !Array.isArray(route.warnings)) throw Error(SEARCH_ERROR);
      const warnings = new Set<string>(
        provider === "google" && next === "WALK" ? [WALK_WARNING] : [],
      );
      for (const warning of route.warnings)
        if (typeof warning === "string" && warning.trim()) warnings.add(warning);
      const result: RoutePrintState = {
        backgroundId: background.id,
        ...(provider === "osrm" ? { provider } : {}),
        travelMode: next,
        durationSeconds: route.durationSeconds,
        distanceMeters: route.distanceMeters,
        encodedPolyline: route.encodedPolyline,
        warnings: [...warnings],
      };
      if (!isRoutePrintState(result)) throw Error(SEARCH_ERROR);
      const points = decodePolyline(result.encodedPolyline, map.getCenter().lng);
      for (const warning of result.warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        warningList.append(item);
      }
      const routeLine: RouteLayer = leaflet.polyline(points, ROUTE_LINE_OPTIONS);
      layer = routeLine;
      routeLine.addTo(map);
      if (!isCurrent(request)) return;
      displayedRoute = result;
      status.textContent = formatSummary(result.durationSeconds, result.distanceMeters);
      if (provider === "google") {
        googleMapLink.href = googleMapLocationUrl(point);
        warningList.after(googleMapLink);
      } else {
        warningList.after(osrmAttribution);
      }
      // ポップアップの終了処理より先に経路を確定する。
      const fromPopup = Boolean(request.onLocationError);
      request.onLocationError = undefined;
      if (fromPopup) {
        map.closePopup();
        (next === "DRIVE" ? drive : walk).focus({ preventScroll: true });
      }
      const bounds = routeLine.getBounds();
      const paddingTopLeft = leaflet.point(24, 32);
      const paddingBottomRight = leaflet.point(
        24,
        panel.element.offsetHeight + Math.max(72, panel.getBottomInset()),
      );
      // 背景のズーム制限外に出ると代替地図へ切り替わるため、その場合は許容範囲に留める。
      if (
        map.getBoundsZoom(bounds, false, paddingTopLeft.add(paddingBottomRight)) <
        background.minZoom
      ) {
        map.setView(bounds.getCenter(), background.minZoom, { animate: false });
      } else {
        map.fitBounds(bounds, {
          paddingTopLeft,
          paddingBottomRight,
          maxZoom: background.maxZoom,
          animate: false,
        });
      }
    } catch {
      if (isCurrent(request)) {
        removeLine();
        warningList.replaceChildren();
        status.textContent = SEARCH_ERROR;
      }
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  const dispose = () => {
    disposed = true;
    clear();
    panel.dispose();
    map.off("basemapwillchange", clear);
    map.off("basemapstatechange googleroutesavailabilitychange", checkAvailability);
    map.off("unload", dispose);
  };
  map.on("basemapwillchange", clear);
  map.on("basemapstatechange googleroutesavailabilitychange", checkAvailability);
  map.on("unload", dispose);
  return {
    isAvailable: () => Boolean(getBackground()),
    getPrintRoute(): RoutePrintState | undefined {
      const background = getBackground();
      if (
        displayedRoute &&
        background?.id === displayedRoute.backgroundId &&
        background.provider === (displayedRoute.provider ?? "google")
      )
        return { ...displayedRoute, warnings: [...displayedRoute.warnings] };
    },
    search(point: Coordinates, onLocationError: LocationErrorHandler) {
      void start(point, undefined, onLocationError);
    },
    cancelPending() {
      if (pending?.onLocationError) clear();
    },
  };
}
