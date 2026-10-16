import type { MarkerRecord, ShapeRecord } from "../types";

export interface LayerObjects {
  markers: Record<string, MarkerRecord>;
  shapes: ShapeRecord[];
}

export type LayerLoadState = "idle" | "loading" | "loaded" | "error";

interface Options {
  layerIds: string[];
  getSelectedLayerIds(): string[];
  apply(layerId: string, data: LayerObjects): void;
  onChange(): void;
  fetchData?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
}

// 地図画面ごとにキャッシュを持ち、取得済みデータはチェック解除後も保持し、再読み込み時に破棄する。
export function createLazyLayerObjects({
  layerIds,
  getSelectedLayerIds,
  apply,
  onChange,
  fetchData = (...args) => fetch(...args),
  concurrency = 4,
  timeoutMs = 30000,
}: Options) {
  const entries = new Map<string, { state: LayerLoadState; promise?: Promise<void> }>();
  const queue: Array<() => void> = [];
  const controllers = new Set<AbortController>();
  let active = 0;
  let disposed = false;
  const notify = () => {
    if (!disposed) onChange();
  };
  const state = (id: string): LayerLoadState => entries.get(id)?.state ?? "idle";
  const pump = () => {
    while (!disposed && active < Math.max(1, concurrency) && queue.length) queue.shift()!();
  };
  const load = (id: string): Promise<void> => {
    if (disposed || !layerIds.includes(id)) return Promise.resolve();
    const existing = entries.get(id);
    if (existing?.state === "loaded") return Promise.resolve();
    if (existing?.promise) return existing.promise;
    const entry: { state: LayerLoadState; promise?: Promise<void> } = { state: "loading" };
    entries.set(id, entry);
    entry.promise = new Promise<void>((resolve) => {
      queue.push(() => {
        if (disposed) {
          resolve();
          return;
        }
        active += 1;
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const read = async (url: string) => {
          const response = await fetchData(url, {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Layer request failed: ${response.status}`);
          return response.json();
        };
        void (async () => {
          try {
            // マスターグループも含め、実際のグループ ID で必ず絞り込む。
            const [markers, shapes] = await Promise.all([
              read(`/marker/read/all?${new URLSearchParams({ layer: id, is_master: "false" })}`),
              read(`/shapes?${new URLSearchParams({ layer_id: id, is_master: "false" })}`),
            ]);
            if (disposed || controller.signal.aborted) throw new Error("Layer request aborted");
            if (
              !markers ||
              typeof markers !== "object" ||
              Array.isArray(markers) ||
              !Array.isArray(shapes)
            ) {
              throw new Error("Invalid layer data");
            }
            if (
              Object.values(markers).some(
                (record: any) => !record || typeof record.id !== "string" || record.layer_id !== id,
              ) ||
              shapes.some(
                (record: any) => !record || typeof record.id !== "string" || record.layer_id !== id,
              )
            ) {
              throw new Error("Unexpected layer in response");
            }
            apply(id, { markers, shapes });
            entry.state = "loaded";
          } catch {
            entry.state = "error";
          } finally {
            controller.abort();
            clearTimeout(timer);
            controllers.delete(controller);
            active -= 1;
            delete entry.promise;
            notify();
            resolve();
            pump();
          }
        })();
      });
    });
    notify();
    pump();
    return entry.promise!;
  };
  const getStatus = () => {
    const selected = getSelectedLayerIds();
    return {
      loading: selected.some((id) => state(id) === "loading"),
      failed: selected.some((id) => state(id) === "error"),
    };
  };
  return {
    load,
    state,
    getStatus,
    retrySelected: () =>
      Promise.all(
        getSelectedLayerIds()
          .filter((id) => state(id) === "error")
          .map(load),
      ),
    dispose: () => {
      disposed = true;
      controllers.forEach((controller) => controller.abort());
      // 待機中の処理も、新たなリクエストを送らずに完了させる。
      queue.splice(0).forEach((start) => {
        start();
      });
      entries.clear();
    },
  };
}
