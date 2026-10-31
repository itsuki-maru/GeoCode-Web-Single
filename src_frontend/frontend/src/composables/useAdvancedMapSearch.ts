import { markRaw, onMounted, onUnmounted, watch, type Ref } from "vue";
import apiClient from "@/axiosClient";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import {
  attributeSearchPath,
  createAdvancedMapSearchModal,
  validateAttributeResult,
  type AttributeTransport,
  type AttributeSearchRequest,
} from "../../../template-scripts/src/map/common/advanced-map-search";

export function useAdvancedMapSearch(
  layer: Ref<string>,
  master: Ref<string>,
  apply: () => void,
  message: (text: string) => void,
) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  let modal: ReturnType<typeof createAdvancedMapSearchModal> | undefined;
  let disposed = false,
    refreshAll = false,
    applyingFromModal = false;
  let activeRequest: { controller: AbortController } | undefined;
  const pending = new Map<
    string,
    { target_type: "marker" | "shape"; id: string; version: number }
  >();
  const seen = new Map<string, number>();
  const context = () =>
    `${markers.recordCache.generation}:${layer.value}:${markers.attributeRevision}:${markers.mutationRevision}:${shapes.mutationRevision}`;
  // レイヤ切り替えが失敗した場合は、ツールバーの選択より先に表示範囲を復元する。
  // 再確認は、その表示範囲を対象に行う。
  const scope = () => `${markers.activeLayerId}:${markers.activeIsMaster}`;
  const cancelRecheck = () => {
    const previous = activeRequest;
    activeRequest = undefined;
    previous?.controller.abort();
  };
  const transport: AttributeTransport = async (path, body, signal) => {
    try {
      return body === undefined
        ? (await apiClient.get(path, { signal })).data
        : (await apiClient.post(path, body, { signal, timeout: 60000 })).data;
    } catch (e) {
      if (apiClient.isAxiosError(e)) {
        if (e.response?.status === 409)
          throw Error("共通フォームが変更されました。開き直して条件を確認してください。");
        if (e.response?.status === 404)
          throw Error("共通フォームまたはレイヤーが見つかりません。開き直してください。");
        const data = e.response?.data as { error?: string } | undefined;
        throw Error(
          data?.error?.replace(/^validation error:\s*/, "") || "検索結果を取得できませんでした。",
        );
      }
      throw e;
    }
  };
  onMounted(() => {
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => markers.attributeSearch,
      getLayerIds: () => (layer.value === master.value ? null : [layer.value]),
      getContext: context,
      onApply: (request, result) => {
        applyingFromModal = true;
        try {
          markers.setAttributeSearch(request, result);
          apply();
        } finally {
          applyingFromModal = false;
        }
      },
    });
  });
  async function flush() {
    if (disposed || activeRequest || (!refreshAll && !pending.size) || !markers.attributeSearch)
      return;
    const full = refreshAll;
    refreshAll = false;
    const batch = full ? [] : [...pending.values()].slice(0, 512);
    if (full) pending.clear();
    else batch.forEach((t) => pending.delete(`${t.target_type}:${t.id}`));
    const revision = markers.attributeRevision,
      generation = markers.recordCache.generation,
      selectedScope = scope(),
      markerRevision = markers.mutationRevision,
      shapeRevision = shapes.mutationRevision;
    const request: AttributeSearchRequest = {
      ...markers.attributeSearch,
      targets: full ? undefined : batch.map(({ target_type, id }) => ({ target_type, id })),
    };
    const job = { controller: new AbortController() };
    activeRequest = job;
    try {
      const result = validateAttributeResult(
        await transport(attributeSearchPath, request, job.controller.signal),
        request,
      );
      if (
        disposed ||
        activeRequest !== job ||
        revision !== markers.attributeRevision ||
        generation !== markers.recordCache.generation ||
        scope() !== selectedScope
      )
        return;
      const markerIds = new Set(full ? result.marker_ids : markers.attributeMarkerIds || []),
        shapeIds = new Set(full ? result.shape_ids : markers.attributeShapeIds || []);
      const matchedMarkers = new Set(result.marker_ids),
        matchedShapes = new Set(result.shape_ids);
      if (full) {
        // この全件読み取り中の保存は、次の処理で再確認する。それまでは古いスナップショットを
        // 公開せず、従来の所属状態を維持する。
        const preserve = (
          versions: Map<string, number>,
          since: number,
          previous: Set<string> | null,
          ids: Set<string>,
        ) => {
          for (const [id, version] of versions)
            if (version > since) {
              if (previous?.has(id)) ids.add(id);
              else ids.delete(id);
            }
        };
        preserve(markers.mutationVersions, markerRevision, markers.attributeMarkerIds, markerIds);
        preserve(shapes.mutationVersions, shapeRevision, markers.attributeShapeIds, shapeIds);
      }
      for (const t of batch) {
        const store = t.target_type === "marker" ? markers : shapes;
        if (store.mutationVersions.get(t.id) !== t.version) continue;
        const ids = t.target_type === "marker" ? markerIds : shapeIds;
        const matches = t.target_type === "marker" ? matchedMarkers : matchedShapes;
        if (matches.has(t.id)) ids.add(t.id);
        else ids.delete(t.id);
        store.dirtyIds.add(t.id);
      }
      markers.attributeMarkerIds = markRaw(markerIds);
      markers.attributeShapeIds = markRaw(shapeIds);
      markers.refreshSearchResults(full);
      apply();
    } catch (e) {
      if (!disposed && activeRequest === job && revision === markers.attributeRevision)
        message(
          e instanceof Error ? e.message : "属性条件の再判定に失敗しました。再検索してください。",
        );
    } finally {
      // 中断した通信は、代わりの通信が始まった後で完了する場合がある。
      if (activeRequest === job) {
        activeRequest = undefined;
        if (!disposed && (refreshAll || pending.size)) void flush();
      }
    }
  }
  const subscribe = (kind: "marker" | "shape") => {
    const store = kind === "marker" ? markers : shapes;
    return store.tableChanges.subscribe((change) => {
      if (change.type !== "record" || change.kind !== kind) return;
      const key = `${kind}:${change.id}`,
        version = store.mutationVersions.get(change.id) || 0;
      if (version <= (seen.get(key) || 0)) return;
      seen.set(key, version);
      if (markers.attributeSearch) {
        pending.set(key, { target_type: kind, id: change.id, version });
        queueMicrotask(() => void flush());
      }
    });
  };
  const stops = [subscribe("marker"), subscribe("shape")];
  const stop = watch(
    () => markers.attributeRevision,
    () => {
      pending.clear();
      refreshAll = false;
      cancelRecheck();
      if (!applyingFromModal) modal?.close();
    },
    { flush: "sync" },
  );
  onUnmounted(() => {
    disposed = true;
    cancelRecheck();
    modal?.dispose();
    stops.forEach((stop) => stop());
    stop();
  });
  return {
    openAdvancedSearch: () => void modal?.open(),
    closeAdvancedSearch: () => modal?.close(),
    refreshAttributeSearch: () => {
      if (disposed || !markers.attributeSearch) return;
      cancelRecheck();
      refreshAll = true;
      void flush();
    },
  };
}
