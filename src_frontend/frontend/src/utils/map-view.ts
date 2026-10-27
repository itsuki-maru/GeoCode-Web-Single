export interface MapView {
  latitude: number;
  longitude: number;
  zoom: number;
}

let sequence = 0;

const isMapView = (value: unknown): value is MapView => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.latitude === "number" &&
    Number.isFinite(view.latitude) &&
    Math.abs(view.latitude) <= 90 &&
    typeof view.longitude === "number" &&
    Number.isFinite(view.longitude) &&
    Math.abs(view.longitude) <= 180 &&
    typeof view.zoom === "number" &&
    Number.isFinite(view.zoom) &&
    view.zoom >= 0 &&
    view.zoom <= 30
  );
};

// 保存位置ではなく、この画面に埋め込まれた地図の現在位置を取得する。
export const requestCurrentMapView = (signal?: AbortSignal): Promise<MapView | null> => {
  const iframe = document.getElementById("map-iframe");
  if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow || signal?.aborted)
    return Promise.resolve(null);
  const source = iframe.contentWindow;
  let origin: string;
  try {
    origin = new URL(iframe.src, window.location.href).origin;
  } catch {
    return Promise.resolve(null);
  }
  const requestId = `map-view-${Date.now()}-${++sequence}`;
  return new Promise((resolve) => {
    const finish = (view: MapView | null) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", abort);
      resolve(view);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== source ||
        event.origin !== origin ||
        event.data?.type !== "mapViewResult" ||
        event.data.requestId !== requestId
      )
        return;
      finish(isMapView(event.data.view) ? event.data.view : null);
    };
    const abort = () => finish(null);
    const timer = window.setTimeout(() => finish(null), 500);
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      source.postMessage({ type: "mapViewRequest", requestId }, origin);
    } catch {
      finish(null);
    }
  });
};
