import { formatTileAttribution } from "./tile-attribution";
import { createTileVisibilityStorage } from "./tile-visibility-storage";
import { isNowcastUrl } from "./nowcast-time";
import { createNowcastLayer, type NowcastStatusOptions } from "./nowcast-layer";

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
export function createTileOverlayManager(
  leaflet: any,
  map: any,
  control: any,
  accountId?: string,
  initiallyVisible = true,
  statusOptions?: NowcastStatusOptions,
) {
  const paneName = "tileOverlays";
  const pane = map.getPane(paneName) || map.createPane(paneName);
  pane.style.zIndex = "250";
  pane.style.pointerEvents = "none";
  const active = new Map<string, { layer: any; signature: string; dispose?: () => void }>();
  map.on("unload", () => {
    for (const entry of active.values()) entry.dispose?.();
    active.clear();
  });
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
    getLayers(): object[] {
      return [...active.values()].map((entry) => entry.layer);
    },
    getVisibility(): Record<string, boolean> {
      return Object.fromEntries([...active].map(([id, entry]) => [id, map.hasLayer(entry.layer)]));
    },
    setVisibility(visibility: Record<string, boolean>): void {
      for (const [id, entry] of active) {
        if (typeof visibility[id] !== "boolean") continue;
        if (visibility[id]) entry.layer.addTo(map);
        else map.removeLayer(entry.layer);
      }
    },
    sync(records: TileOverlayRecord[]): boolean {
      if (!Array.isArray(records)) return false;
      const wanted = new Set(records.map((r) => r.id));
      const savedVisibility = storage?.reconcile([...wanted]) || {};
      for (const [id, entry] of active) {
        if (!wanted.has(id)) {
          active.delete(id);
          entry.dispose?.();
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
          : (savedVisibility[record.id] ?? initiallyVisible);
        if (previous) {
          active.delete(record.id);
          previous.dispose?.();
          control.removeLayer(previous.layer);
          map.removeLayer(previous.layer);
          previous.layer.off();
        }
        let layer: any;
        let dispose: (() => void) | undefined;
        try {
          const options = {
            pane: paneName,
            attribution: formatTileAttribution(record.attribution),
            minZoom: record.min_zoom,
            maxZoom: record.max_zoom,
            opacity: record.opacity,
            zIndex: index + 1,
          };
          if (isNowcastUrl(record.url)) {
            ({ layer, dispose } = createNowcastLayer(
              leaflet,
              map,
              options,
              record.name,
              statusOptions,
            ));
          } else {
            layer = leaflet.tileLayer(record.url, options);
          }
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
          active.set(record.id, { layer, signature, dispose });
        } catch {
          dispose?.();
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
