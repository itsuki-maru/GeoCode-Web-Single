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

/** Keep the marker group identity used by filters, editing and answer coloring. */
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
  // Leaflet rebuilds the overlays list when tiles are added or removed. Keep
  // this setting outside that list and outside its visibility bulk actions.
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
    // animationend can fire inside the plugin's cleanup queue. Rebuild after
    // the entire queue has returned, so it cannot remove the re-added markers.
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
    // Non-animated/empty groups may have fired animationend before this map
    // handler. Also allow those groups to settle without relying on an event.
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
