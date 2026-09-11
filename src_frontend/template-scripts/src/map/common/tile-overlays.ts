import { formatTileAttribution } from "./tile-attribution";
import { createTileVisibilityStorage } from "./tile-visibility-storage";

export interface TileOverlayRecord {
  id: string;
  name: string;
  url: string;
  attribution: string;
  min_zoom: number;
  max_zoom: number;
  opacity: number;
  sort_order: number;
}

// Leaflet is loaded by the page; keep this boundary independent of its global types.
export function createTileOverlayManager(leaflet: any, map: any, control: any, accountId?: string) {
  const paneName = "tileOverlays";
  const pane = map.getPane(paneName) || map.createPane(paneName);
  pane.style.zIndex = "250";
  pane.style.pointerEvents = "none";
  const active = new Map<string, { layer: any; signature: string }>();
  const storage = accountId ? createTileVisibilityStorage(accountId) : null;
  if (storage) {
    const saveVisibility = (event: { layer: unknown }, visible: boolean): void => {
      for (const [id, entry] of active) {
        if (entry.layer === event.layer) {
          storage.save(id, visible);
          return;
        }
      }
    };
    map.on("overlayadd", (event: { layer: unknown }) => saveVisibility(event, true));
    map.on("overlayremove", (event: { layer: unknown }) => saveVisibility(event, false));
  }
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );

  return {
    sync(records: TileOverlayRecord[]): boolean {
      if (!Array.isArray(records)) return false;
      const wanted = new Set(records.map((r) => r.id));
      const savedVisibility = storage?.reconcile([...wanted]) || {};
      for (const [id, entry] of active) {
        if (!wanted.has(id)) {
          active.delete(id);
          control.removeLayer(entry.layer);
          map.removeLayer(entry.layer);
          entry.layer.off();
        }
      }
      let success = true;
      const sorted = [...records].sort(
        (a, b) =>
          a.sort_order - b.sort_order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
      sorted.forEach((record, index) => {
        const signature = JSON.stringify(record);
        const previous = active.get(record.id);
        if (previous?.signature === signature) {
          previous.layer.setZIndex(index + 1);
          return;
        }
        const visible = previous
          ? map.hasLayer(previous.layer)
          : (savedVisibility[record.id] ?? true);
        if (previous) {
          active.delete(record.id);
          control.removeLayer(previous.layer);
          map.removeLayer(previous.layer);
          previous.layer.off();
        }
        let layer: any;
        try {
          layer = leaflet.tileLayer(record.url, {
            pane: paneName,
            attribution: formatTileAttribution(record.attribution),
            minZoom: record.min_zoom,
            maxZoom: record.max_zoom,
            opacity: record.opacity,
            zIndex: index + 1,
          });
          let lastError: number | undefined;
          layer.on("tileerror", (event: any) => {
            const now = Date.now();
            if (lastError !== undefined && now - lastError < 10000) return;
            lastError = now;
            // Do not log URLs: some providers put access tokens in query strings.
            // Image errors do not expose HTTP status; keep missing tiles in debug logs.
            console.debug(
              "重ね合わせタイルの読み込みに失敗しました。対象地域にデータがない場合もあります。",
              {
                id: record.id,
                name: record.name,
                coords: event.coords,
              },
            );
          });
          control.addOverlay(layer, escape(record.name));
          if (visible) layer.addTo(map);
          active.set(record.id, { layer, signature });
        } catch {
          if (layer) {
            control.removeLayer(layer);
            map.removeLayer(layer);
            layer.off();
          }
          console.error("重ね合わせタイルを表示できませんでした。", {
            id: record.id,
            name: record.name,
          });
          success = false;
        }
      });
      return success;
    },
  };
}
