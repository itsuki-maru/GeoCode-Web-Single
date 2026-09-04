export const LAST_MAP_VIEW_STORAGE_KEY = "geocode-web:last-map-view";

export interface StoredMapView {
  latitude: number;
  longitude: number;
  zoom: number;
}

interface MapViewReader {
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  on(eventName: "moveend", listener: () => void): void;
}

type MapViewStorage = Pick<Storage, "getItem" | "setItem">;

const isValidMapView = (value: unknown): value is StoredMapView => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.latitude === "number" &&
    Number.isFinite(candidate.latitude) &&
    candidate.latitude >= -90 &&
    candidate.latitude <= 90 &&
    typeof candidate.longitude === "number" &&
    Number.isFinite(candidate.longitude) &&
    candidate.longitude >= -180 &&
    candidate.longitude <= 180 &&
    typeof candidate.zoom === "number" &&
    Number.isFinite(candidate.zoom) &&
    candidate.zoom >= 0 &&
    candidate.zoom <= 30
  );
};

export const loadLastMapView = (
  storage?: MapViewStorage,
): StoredMapView | null => {
  try {
    const serialized = (storage ?? window.localStorage).getItem(
      LAST_MAP_VIEW_STORAGE_KEY,
    );
    if (!serialized) return null;
    const value: unknown = JSON.parse(serialized);
    return isValidMapView(value) ? value : null;
  } catch (error) {
    console.warn("最後に表示した地図位置を読み込めませんでした。", error);
    return null;
  }
};

export const saveLastMapView = (
  view: StoredMapView,
  storage?: MapViewStorage,
): void => {
  if (!isValidMapView(view)) return;
  try {
    (storage ?? window.localStorage).setItem(
      LAST_MAP_VIEW_STORAGE_KEY,
      JSON.stringify(view),
    );
  } catch (error) {
    console.warn("最後に表示した地図位置を保存できませんでした。", error);
  }
};

export const observeMapView = (
  map: MapViewReader,
  storage?: MapViewStorage,
): void => {
  map.on("moveend", () => {
    const center = map.getCenter();
    saveLastMapView(
      { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() },
      storage,
    );
  });
};
