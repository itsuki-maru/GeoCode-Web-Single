import { getBasemapController } from "../common/basemap-controller";
import { createRoutePanel } from "../common/route-panel";
import {
  decodePolyline,
  formatSummary,
  ROUTE_LINE_OPTIONS,
  type RoutePrintState,
} from "../common/route-result";

export function createPrintRoute(
  map: any,
  leaflet: any,
  route: RoutePrintState,
  onChange: () => void,
) {
  const panel = createRoutePanel({
    mapElement: map.getContainer(),
    print: true,
    onPositionChange: onChange,
  });
  const travelMode = route.travelMode === "DRIVE" ? "車" : "徒歩";
  panel.status.textContent = `${travelMode}・${formatSummary(route.durationSeconds, route.distanceMeters)}`;
  for (const warning of route.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    panel.warningList.append(item);
  }

  let line: { remove(): void } | undefined;
  let dismissed = false;
  let initialFraming = true;
  const hide = () => {
    if (!line) return;
    line.remove();
    line = undefined;
    panel.hide();
    onChange();
  };
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "経路を消す";
  remove.addEventListener("click", () => {
    dismissed = true;
    hide();
  });
  panel.actions.append(remove);

  const update = () => {
    const controller = getBasemapController(map);
    const background = controller?.getState();
    if (!background?.googleRoutesAvailable || background.id !== String(route.backgroundId)) {
      hide();
      return;
    }
    if (line || dismissed) return;
    let points: ReturnType<typeof decodePolyline>;
    try {
      points = decodePolyline(route.encodedPolyline, map.getCenter().lng);
    } catch {
      dismissed = true;
      return;
    }
    const next = leaflet.polyline(points, {
      ...ROUTE_LINE_OPTIONS,
      className: "route-search-line route-search-print-line",
    });
    next.addTo(map);
    line = next;
    panel.show();
    onChange();

    if (!initialFraming) return;
    initialFraming = false;
    const zoomLimits = controller?.getLayer?.()?.getGoogleRoutesBackground?.();
    if (!zoomLimits) return;
    // 用紙の縦横比が元の地図と異なる場合、端点が切れているときだけ初回の表示範囲を広げる。
    const bounds = next.getBounds();
    const padding = leaflet.point(24, 24);
    const paddedView = leaflet.latLngBounds(
      map.containerPointToLatLng(padding),
      map.containerPointToLatLng(map.getSize().subtract(padding)),
    );
    if (paddedView.contains(bounds)) return;
    if (map.getBoundsZoom(bounds, false, padding.multiplyBy(2)) < zoomLimits.minZoom) {
      map.setView(bounds.getCenter(), zoomLimits.minZoom, { animate: false });
    } else {
      map.fitBounds(bounds, { padding, maxZoom: map.getZoom(), animate: false });
    }
  };
  map.on("basemapwillchange", hide);
  map.on("basemapstatechange", update);
  update();

  return {
    dispose() {
      map.off("basemapwillchange", hide);
      map.off("basemapstatechange", update);
      line?.remove();
      panel.dispose();
    },
  };
}
