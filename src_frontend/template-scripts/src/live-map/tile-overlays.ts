import { createTileOverlayManager, type TileOverlayRecord } from "../map/common/tile-overlays";
import { createCollapsibleLayerControl } from "./controls";

// Leaflet is provided by the live-map template.
export function addLiveTileOverlayControl(
  leaflet: any,
  map: any,
  records: TileOverlayRecord[],
  isMobile: boolean,
) {
  if (!records.length) return null;
  const control = leaflet.control
    .layers(null, null, {
      collapsed: false,
      position: "topright",
    })
    .addTo(map);
  const container: HTMLElement = control.getContainer();
  container.classList.add("live-tile-overlay-control");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "重ね合わせタイル");
  createTileOverlayManager(leaflet, map, control).sync(records);
  const collapsible = isMobile ? createCollapsibleLayerControl({ container, leaflet, map }) : null;
  return { control, collapsible };
}
