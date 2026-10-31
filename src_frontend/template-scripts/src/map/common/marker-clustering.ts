export const MARKER_CLUSTERING_MIN_ZOOM = 15;

interface ClusteringMap {
  getZoom(): number;
  on(events: string, handler: () => void): unknown;
  off(events: string, handler: () => void): unknown;
}

interface MarkerGroup {
  options?: { disableClusteringAtZoom?: number | null };
  getLayers(): object[];
  clearLayers(): unknown;
  addLayers?(layers: object[]): unknown;
  on?(events: string, handler: () => void): unknown;
  off?(events: string, handler: () => void): unknown;
}

interface MarkerClusteringOptions {
  leaflet: { DomEvent: { disableClickPropagation(element: HTMLElement): void } };
  map: ClusteringMap;
  markerGroup: MarkerGroup;
  control: { getContainer(): HTMLElement | null };
  allowed?: boolean;
  initialEnabled?: boolean;
}

/** フィルター、編集、回答の色分けに使うマーカーグループの同一性を維持する。 */
export function installMarkerClustering({
  leaflet,
  map,
  markerGroup,
  control,
  allowed = true,
  initialEnabled = true,
}: MarkerClusteringOptions) {
  const row = document.createElement("div");
  row.className = "marker-clustering-control";
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "leaflet-control-layers-selector";
  const text = document.createElement("span");
  text.textContent = " クラスタ";
  label.append(input, text);
  row.append(label);
  // Leaflet はタイルの追加・削除時にオーバーレイ一覧を作り直す。この設定は一覧の外に置き、
  // 一覧の表示状態をまとめて変更する操作の対象からも外す。
  control.getContainer()?.querySelector(".leaflet-control-layers-list")?.append(row);
  leaflet.DomEvent.disableClickPropagation(row);

  let enabled = allowed && (map.getZoom() < MARKER_CLUSTERING_MIN_ZOOM || initialEnabled);
  let disposed = false;
  let zooming = false;
  let settling = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const rebuild = () => {
    if (disposed || !allowed || zooming || settling) return;
    const disableAt = enabled ? null : MARKER_CLUSTERING_MIN_ZOOM;
    if (markerGroup.options?.disableClusteringAtZoom === disableAt) return;
    const markers = markerGroup.getLayers();
    markerGroup.options!.disableClusteringAtZoom = disableAt;
    markerGroup.clearLayers();
    markerGroup.addLayers!(markers);
  };
  const syncInput = () => {
    input.checked = enabled;
    input.disabled = !allowed || map.getZoom() < MARKER_CLUSTERING_MIN_ZOOM;
    label.title = !allowed
      ? "地図の設定によりクラスタは無効です"
      : input.disabled
        ? "ズーム15以上で解除できます"
        : "チェックを外すとクラスタを解除します";
  };
  const setEnabled = (value: boolean) => {
    if (disposed) return;
    enabled = allowed && (map.getZoom() < MARKER_CLUSTERING_MIN_ZOOM || value);
    syncInput();
    rebuild();
  };
  const finishSettling = () => {
    clearTimeout(settleTimer);
    // animationend は、プラグインの後処理キュー内で発火する場合がある。再追加したマーカーが削除されないよう、
    // キュー全体の処理が戻ってから再構築する。
    settleTimer = setTimeout(() => {
      if (zooming || disposed) return;
      settling = false;
      rebuild();
    }, 0);
  };
  const beginZoom = () => {
    zooming = true;
    settling = true;
    clearTimeout(settleTimer);
  };
  const endZoom = () => {
    zooming = false;
    settling = true;
    setEnabled(enabled);
    clearTimeout(settleTimer);
    // アニメーションしないグループや空のグループでは、この地図側のハンドラーより前に animationend が
    // 発火している場合がある。イベントに依存せず、これらのグループも安定状態に到達できるようにする。
    settleTimer = setTimeout(() => {
      settling = false;
      rebuild();
    }, 350);
  };
  const change = () => setEnabled(input.checked);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(settleTimer);
    input.removeEventListener("change", change);
    map.off("zoomstart", beginZoom);
    map.off("zoomend", endZoom);
    map.off("unload", dispose);
    markerGroup.off?.("animationend", finishSettling);
    row.remove();
  };

  input.addEventListener("change", change);
  map.on("zoomstart", beginZoom);
  map.on("zoomend", endZoom);
  map.on("unload", dispose);
  markerGroup.on?.("animationend", finishSettling);
  syncInput();
  rebuild();

  return { getEnabled: () => enabled, isAllowed: () => allowed, setEnabled, dispose };
}
