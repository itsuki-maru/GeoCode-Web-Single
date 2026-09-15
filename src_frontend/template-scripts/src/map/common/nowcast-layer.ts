import { NOWCAST_MAX_AGE, NOWCAST_ROOT, nowcastFeed, type NowcastState } from "./nowcast-time";

const EMPTY_TILE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

// JMA publishes hrpns at z=4,6,8,10. Clamp the entire tile grid (including
// coordinates and scale), not just the z segment of individual image URLs.
export function nowcastNativeZoom(zoom: number): number {
  return Math.max(4, Math.min(10, Math.floor(zoom / 2) * 2));
}

export interface NowcastStatusOptions {
  afterControl?: HTMLElement;
  onControlAdded?: (control: { getContainer: () => HTMLElement }) => void;
}

export function createNowcastLayer(
  leaflet: any,
  map: any,
  options: any,
  name: string,
  statusOptions?: NowcastStatusOptions,
) {
  const NowcastLayer = leaflet.TileLayer.extend({
    _clampZoom: nowcastNativeZoom,
  });
  const layer = new NowcastLayer(EMPTY_TILE, {
    ...options,
    minNativeZoom: 4,
    maxNativeZoom: 10,
    minZoom: Math.max(4, options.minZoom),
    errorTileUrl: EMPTY_TILE,
  });
  const panel = leaflet.control({
    position: statusOptions?.afterControl ? "topright" : "bottomleft",
  });
  const container = document.createElement("div");
  container.className = "nowcast-status";
  Object.assign(container.style, {
    background: "rgba(255,255,255,0.95)",
    color: "#222",
    padding: "6px 8px",
    borderRadius: "4px",
    maxWidth: "min(280px, calc(100vw - 80px))",
    fontSize: "12px",
    lineHeight: "1.5",
    overflowWrap: "anywhere",
  });
  const heading = document.createElement("strong");
  heading.textContent = name;
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  const legend = document.createElement("a");
  legend.href = "https://www.jma.go.jp/bosai/nowc/#elements:hrpns";
  legend.target = "_blank";
  legend.rel = "noopener noreferrer";
  legend.textContent = "気象庁：雨雲の動き・凡例";
  container.append(heading, status, legend);
  leaflet.DomEvent.disableClickPropagation(container);
  leaflet.DomEvent.disableScrollPropagation(container);
  panel.onAdd = () => container;

  let url = EMPTY_TILE;
  let state: NowcastState = { failed: false };
  let imageFailed = false;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let printPaused = false;
  layer.getPrintStatus = () => ({
    loading: !state.time && !state.failed,
    failed:
      state.failed ||
      imageFailed ||
      Boolean(state.time && Date.now() - state.time.milliseconds >= NOWCAST_MAX_AGE),
  });
  const pausePrint = () => {
    printPaused = true;
  };
  const resumePrint = () => {
    printPaused = false;
    render();
  };
  layer.retryPrint = () => {
    stop();
    imageFailed = false;
    start();
    layer.redraw();
  };
  map.on("printpause", pausePrint);
  map.on("printresume", resumePrint);
  function render() {
    if (printPaused) return;
    const time = state.time;
    const stale = time && Date.now() - time.milliseconds >= NOWCAST_MAX_AGE;
    const nextUrl =
      time && !stale
        ? `${NOWCAST_ROOT}/${time.basetime}/none/${time.validtime}/surf/hrpns/{z}/{x}/{y}.png`
        : EMPTY_TILE;
    if (url !== nextUrl) {
      url = nextUrl;
      imageFailed = false;
      layer.setUrl(url);
    }
    const label = time
      ? new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(time.milliseconds) + "（日本時間）"
      : "";
    status.textContent = !time
      ? state.failed
        ? "雨雲データを取得できません。再試行します。"
        : "雨雲データを取得中…"
      : stale
        ? `${label}：15分以上前のため非表示`
        : `${label}${state.failed ? "／時刻更新に失敗・再試行中" : ""}${imageFailed ? "／画像を取得できない範囲があります" : ""}`;
  }
  function start() {
    if (disposed || unsubscribe) return;
    panel.addTo(map);
    statusOptions?.afterControl?.after(container);
    statusOptions?.onControlAdded?.(panel);
    unsubscribe = nowcastFeed.subscribe((next) => {
      state = next;
      render();
    });
  }
  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    panel.remove();
    // Do not briefly request an old timestamp when this layer is re-enabled.
    url = EMPTY_TILE;
    layer.setUrl(EMPTY_TILE, true);
  }
  function imageError() {
    if (url === EMPTY_TILE) return;
    imageFailed = true;
    render();
  }
  layer.on("add", start);
  layer.on("remove", stop);
  layer.on("tileerror", imageError);
  return {
    layer,
    dispose() {
      disposed = true;
      map.off("printpause", pausePrint);
      map.off("printresume", resumePrint);
      stop();
      layer.off("add", start);
      layer.off("remove", stop);
      layer.off("tileerror", imageError);
    },
  };
}
