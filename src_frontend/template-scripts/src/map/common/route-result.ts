export type RoutePrintState = {
  backgroundId: number;
  travelMode: "DRIVE" | "WALK";
  durationSeconds: number;
  distanceMeters: number;
  encodedPolyline: string;
  warnings: string[];
};

export const ROUTE_LINE_OPTIONS = {
  color: "#1665d8",
  weight: 6,
  opacity: 0.9,
  interactive: false,
  className: "route-search-line",
};

// Routes API の上流レスポンスと同じ上限を印刷メッセージにも適用する。
const MAX_ROUTE_TEXT_LENGTH = 1024 * 1024;

export function isRoutePrintState(value: unknown): value is RoutePrintState {
  if (!value || typeof value !== "object") return false;
  const state = value as RoutePrintState;
  if (
    !Number.isSafeInteger(state.backgroundId) ||
    state.backgroundId <= 0 ||
    (state.travelMode !== "DRIVE" && state.travelMode !== "WALK") ||
    !Number.isFinite(state.durationSeconds) ||
    state.durationSeconds < 0 ||
    !Number.isSafeInteger(state.distanceMeters) ||
    state.distanceMeters < 0 ||
    typeof state.encodedPolyline !== "string" ||
    state.encodedPolyline.length < 4 ||
    state.encodedPolyline.length > MAX_ROUTE_TEXT_LENGTH ||
    /[^?-~]/.test(state.encodedPolyline) ||
    !Array.isArray(state.warnings) ||
    state.warnings.length > MAX_ROUTE_TEXT_LENGTH / 3 ||
    Object.keys(state).some(
      (key) =>
        ![
          "backgroundId",
          "travelMode",
          "durationSeconds",
          "distanceMeters",
          "encodedPolyline",
          "warnings",
        ].includes(key),
    )
  )
    return false;

  let length = state.encodedPolyline.length;
  for (const warning of state.warnings) {
    if (typeof warning !== "string") return false;
    length += warning.length + 3;
    if (length > MAX_ROUTE_TEXT_LENGTH) return false;
  }
  return true;
}

export function validPoint(point: { lat: number; lng: number }): boolean {
  return (
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lng) <= 180
  );
}

// Google の Encoded Polyline は、直前の点との差分を 5 ビットずつ格納する。
export function decodePolyline(encoded: string, centerLongitude: number): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  let previousLongitude = centerLongitude;
  const readDelta = () => {
    let value = 0;
    for (let shift = 0; shift <= 25; shift += 5) {
      const chunk = encoded.charCodeAt(index++) - 63;
      if (!Number.isInteger(chunk) || chunk < 0 || chunk > 63) break;
      value |= (chunk & 31) << shift;
      if (chunk < 32) return (value & 1) === 1 ? -((value >> 1) + 1) : value >> 1;
    }
    throw Error("経路の座標が不正です。");
  };
  while (index < encoded.length) {
    latitude += readDelta();
    longitude += readDelta();
    const point = { lat: latitude / 1e5, lng: longitude / 1e5 };
    if (!validPoint(point)) throw Error("経路の座標が不正です。");
    // 経度180度をまたぐときも、隣り合う点と同じ地図の世界コピーに線を描く。
    const lng = point.lng + 360 * Math.round((previousLongitude - point.lng) / 360);
    points.push([point.lat, lng]);
    previousLongitude = lng;
  }
  if (points.length < 2) throw Error("経路の座標が不正です。");
  return points;
}

export function formatSummary(seconds: number, meters: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  const time =
    seconds === 0
      ? "0分"
      : hours
        ? `${hours}時間${remaining ? `${remaining}分` : ""}`
        : `${minutes}分`;
  const distance =
    meters < 1_000
      ? `${meters} m`
      : `${(meters / 1_000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} km`;
  return `約${time}・${distance}`;
}
