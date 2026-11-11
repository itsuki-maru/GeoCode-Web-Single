import { createBasemapLayer } from "./basemap-layer";
import type { TileServerRecord } from "./basemap-definition";

export interface BasemapController {
  select(id: string): Promise<boolean>;
  getSelectedId(): string;
  getLayer(): any;
  isPending(): boolean;
  whenReady(): Promise<void>;
  dispose(): void;
}

export interface BasemapControllerOptions {
  leaflet: any;
  map: any;
  tileServers: Record<string, TileServerRecord>;
  bounds: any;
  initialId?: string;
  saveSelectedTileServerId?(id: string): void;
  onCommit?(id: string, layer: any): void;
  onError?(error: unknown, id: string): void;
}

type LayerHandle = ReturnType<typeof createBasemapLayer>;
type ManagedLayer = {
  handle: LayerHandle;
  id: string;
  provisional?: boolean;
  failed?: boolean;
  onError?: (event: any) => void;
};
type Candidate = ManagedLayer & {
  abort: AbortController;
  generation: number;
};

export function installBasemapController(map: any, controller: BasemapController): void {
  map._geocodeBasemap = controller;
}

export function getBasemapController(map: any): BasemapController | undefined {
  return map?._geocodeBasemap;
}

/** 確定済み背景を保持したまま次の背景を読み込み、最後の選択だけを反映する。 */
export function createBasemapController({
  leaflet,
  map,
  tileServers,
  bounds,
  initialId = "1",
  saveSelectedTileServerId,
  onCommit,
  onError,
}: BasemapControllerOptions): BasemapController {
  const fallbackId =
    (tileServers["1"]?.kind !== "vector" && tileServers["1"]
      ? "1"
      : Object.keys(tileServers).find((id) => tileServers[id].kind !== "vector")) ?? "";
  if (!fallbackId) throw new Error("ラスタの背景地図が必要です。");

  let current: ManagedLayer;
  let candidate: Candidate | undefined;
  let generation = 0;
  let pending = false;
  let disposed = false;
  let lastSelection: Promise<boolean> = Promise.resolve(true);

  const setPending = (value: boolean) => {
    if (pending === value) return;
    pending = value;
    map.fire?.("basemaploadingchange", { pending });
  };
  const notifyCommit = () => onCommit?.(current.id, current.handle.layer);
  const withinZoomRange = (id: string) => {
    const record = tileServers[id];
    const zoom = map.getZoom?.();
    return (
      record.kind !== "vector" ||
      typeof zoom !== "number" ||
      (zoom >= (record.min_zoom ?? 5) && zoom <= (record.max_zoom ?? 18))
    );
  };
  const zoomRangeError = () => new Error("背景地図の表示ズーム範囲外です。");
  const release = (entry: ManagedLayer) => {
    if (entry.onError) entry.handle.layer.off?.("basemaperror", entry.onError);
    map.removeLayer?.(entry.handle.layer);
    entry.handle.dispose();
  };
  const cancelCandidate = () => {
    const previous = candidate;
    candidate = undefined;
    if (previous) {
      previous.abort.abort();
      release(previous);
    }
  };
  const watchActive = (entry: ManagedLayer) => {
    entry.onError = (event: any) => {
      if (disposed || current !== entry) return;
      entry.failed = true;
      onError?.(event?.error ?? event, entry.id);
      if (tileServers[entry.id].kind === "vector" && !pending) {
        // 一時的な障害による代替表示では、利用者が保存した背景の好みを変更しない。
        void requestSelection(fallbackId, false);
      }
    };
    entry.handle.layer.on?.("basemaperror", entry.onError);
  };
  const handleZoomEnd = () => {
    if (disposed || withinZoomRange(current.id)) return;
    onError?.(zoomRangeError(), current.id);
    if (!pending) void requestSelection(fallbackId, false);
  };
  const commit = (entry: ManagedLayer, persist: boolean, boundsRecord = tileServers[entry.id]) => {
    const previous = current;
    current = entry;
    current.handle.setVisible(true);
    map.setMaxBounds?.(boundsRecord.include_foreign_tiles ? null : bounds);
    if (previous && previous !== entry) release(previous);
    watchActive(entry);
    setPending(false);
    if (persist) saveSelectedTileServerId?.(entry.id);
    notifyCommit();
    map.fire?.("basemapchange", { id: entry.id, layer: entry.handle.layer });
  };

  const restoreProvisionalFallback = (): boolean => {
    if (!current.provisional) return false;
    const handle = createBasemapLayer(leaflet, map, tileServers[current.id]);
    const restored = { id: current.id, handle };
    handle.setVisible(true);
    handle.layer.addTo(map);
    commit(restored, false);
    return true;
  };

  async function runSelection(id: string, persist: boolean): Promise<boolean> {
    if (disposed || !tileServers[id]) return false;
    const selectedGeneration = ++generation;
    cancelCandidate();
    if (id === current.id && !current.failed && withinZoomRange(id)) {
      if (!restoreProvisionalFallback()) {
        setPending(false);
        notifyCommit();
      }
      if (persist) saveSelectedTileServerId?.(id);
      return true;
    }

    setPending(true);
    const abort = new AbortController();
    let entry: Candidate | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (!withinZoomRange(id)) throw zoomRangeError();
      const handle = createBasemapLayer(leaflet, map, tileServers[id], { signal: abort.signal });
      // addTo等が同期で失敗しても、後から起きた取得失敗を未処理にしない。
      void handle.ready?.catch(() => undefined);
      entry = { handle, id, abort, generation: selectedGeneration };
      candidate = entry;
      const failure = new Promise<never>((_resolve, reject) => {
        entry!.onError = (event: any) => reject(event?.error ?? event);
        abortListener = () => reject(new DOMException("背景の切替を中止しました。", "AbortError"));
        abort.signal.addEventListener("abort", abortListener, { once: true });
        handle.layer.on?.("basemaperror", entry!.onError);
      });
      // readyがない簡易レイヤーでも同期エラーのPromiseを未処理にしない。
      void failure.catch(() => undefined);
      handle.setVisible(false);
      handle.layer.addTo(map);
      if (handle.ready) await Promise.race([handle.ready, failure]);
      if (disposed || selectedGeneration !== generation || abort.signal.aborted) return false;
      if (!withinZoomRange(id)) throw zoomRangeError();
      if (entry.onError) handle.layer.off?.("basemaperror", entry.onError);
      entry.onError = undefined;
      candidate = undefined;
      commit(entry, persist);
      return true;
    } catch (error) {
      if (disposed || selectedGeneration !== generation || abort.signal.aborted) return false;
      if (entry && candidate === entry) {
        candidate = undefined;
        abort.abort();
        release(entry);
      }
      if (!restoreProvisionalFallback()) {
        if (
          id !== fallbackId &&
          tileServers[current.id].kind === "vector" &&
          (current.failed || !withinZoomRange(current.id))
        ) {
          // 最新候補も失敗した場合だけ、利用できなくなった旧背景をラスタへ戻す。
          void requestSelection(fallbackId, false);
        } else {
          setPending(false);
          notifyCommit();
        }
      }
      onError?.(error, id);
      return false;
    } finally {
      if (abortListener) abort.signal.removeEventListener("abort", abortListener);
    }
  }

  function requestSelection(id: string, persist: boolean): Promise<boolean> {
    const previousGeneration = generation;
    const selection = runSelection(id, persist);
    // 無効なIDやcallbackからの再入が、現在待機している操作を置き換えないようにする。
    if (generation === previousGeneration + 1) lastSelection = selection;
    return selection;
  }

  const controller: BasemapController = {
    select: (id) => requestSelection(id, true),
    getSelectedId: () => current.id,
    getLayer: () => current.handle.layer,
    isPending: () => pending,
    async whenReady() {
      while (pending && !disposed) {
        const waiting = lastSelection;
        await waiting;
        if (waiting === lastSelection) return;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      cancelCandidate();
      release(current);
      setPending(false);
      map.off?.("unload", controller.dispose);
      map.off?.("zoomend", handleZoomEnd);
      if (getBasemapController(map) === controller) delete map._geocodeBasemap;
    },
  };

  const requested = tileServers[initialId];
  const initialVector = requested?.kind === "vector";
  const initialRasterId = requested && requested.kind !== "vector" ? initialId : fallbackId;
  // 暫定ラスタの制約で、復元したベクタの低ズームや海外位置を変更しない。
  const initialRaster = initialVector
    ? { ...tileServers[initialRasterId], min_zoom: 0, max_zoom: 30 }
    : tileServers[initialRasterId];
  const handle = createBasemapLayer(leaflet, map, initialRaster);
  current = { handle, id: initialRasterId, provisional: initialVector };
  installBasemapController(map, controller);
  map.on?.("unload", controller.dispose);
  map.on?.("zoomend", handleZoomEnd);
  handle.setVisible(true);
  handle.layer.addTo(map);
  commit(current, false, initialVector ? requested : tileServers[initialRasterId]);
  // 旧ラスタの初期描画は同期のまま保ち、取得失敗による未処理rejectだけを防ぐ。
  void handle.ready?.catch((error) => {
    if (!disposed && current.handle === handle) onError?.(error, initialRasterId);
  });
  if (requested?.kind === "vector") void requestSelection(initialId, false);
  return controller;
}
