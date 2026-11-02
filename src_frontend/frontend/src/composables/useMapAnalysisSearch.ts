import { ref, markRaw, onMounted, onUnmounted, watch, type Ref } from "vue";
import apiClient from "@/axiosClient";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import {
  createAdvancedMapSearchModal,
  searchMapAttributes,
  attributeSearchPath,
  validateAttributeResult,
  type AttributeTransport,
} from "../../../template-scripts/src/map/common/advanced-map-search";
import { evaluateMapAnalysis } from "../../../template-scripts/src/map/common/map-analysis";
import type { AnswerColorSpecification, AnswerColoring } from "@/utils/answer-coloring";

export function useMapAnalysisSearch(
  layer: Ref<string>,
  master: Ref<string>,
  apply: () => void | Promise<void>,
  message: (text: string) => void,
  colorMap: (value: AnswerColoring | null) => Promise<boolean>,
) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  const coloringActive = ref(false);
  let coloringPending = 0;
  let specification: AnswerColorSpecification | null = null,
    coloring: AnswerColoring | null = null;
  let modal: ReturnType<typeof createAdvancedMapSearchModal> | undefined;
  let disposed = false,
    revision = 0,
    applying = false,
    running = false,
    full = false;
  let controller: AbortController | undefined;
  const seen = new Map<string, number>();
  const pending = new Map<
    string,
    { target_type: "marker" | "shape"; id: string; version: number }
  >();
  const layerIds = () => (layer.value === master.value ? null : [layer.value]);
  const context = () =>
    `${revision}:${markers.recordCache.generation}:${layer.value}:${markers.mutationRevision}:${shapes.mutationRevision}`;
  const recheckContext = () =>
    `${revision}:${markers.recordCache.generation}:${markers.activeLayerId}:${markers.activeIsMaster}`;
  const transport: AttributeTransport = async (path, body, signal, method) => {
    try {
      return method === "DELETE"
        ? (await apiClient.delete(path, { signal })).data
        : body === undefined
          ? (await apiClient.get(path, { signal })).data
          : (await apiClient.post(path, body, { signal, timeout: 60000 })).data;
    } catch (e) {
      if (apiClient.isAxiosError(e)) {
        if (e.response?.status === 409)
          throw Error("共通フォームが変更されました。開き直して条件を確認してください。");
        if (e.response?.status === 404)
          throw Error("共通フォームまたはレイヤーが見つかりません。開き直してください。");
        throw Error(
          (e.response?.data as { error?: string })?.error || "検索結果を取得できませんでした。",
        );
      }
      throw e;
    }
  };
  const commitColors = async (next: AnswerColoring | null) => {
    if (!next && !coloring) return;
    const current = revision;
    ++coloringPending;
    try {
      if (!(await colorMap(next)))
        throw Error("地図への色分けの反映を確認できませんでした。再試行してください。");
      if (current !== revision || disposed)
        throw Error("地図の状態が変わりました。もう一度実行してください。");
      coloring = next;
      coloringActive.value = !!next;
    } finally {
      --coloringPending;
    }
  };
  const cancel = () => {
    ++revision;
    const previous = controller;
    controller = undefined;
    previous?.abort();
    running = false;
  };
  const resetAnalysis = () => {
    cancel();
    modal?.close();
    pending.clear();
    seen.clear();
    full = false;
    const hadColoring = !!coloring;
    specification = null;
    coloring = null;
    coloringActive.value = false;
    if (hadColoring || coloringPending)
      void colorMap(null).catch((e) => message((e as Error).message));
  };
  onMounted(() => {
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => markers.attributeSearch,
      getLayerIds: layerIds,
      getContext: context,
      analysis: {
        getSpecification: () => specification,
        getColoring: () => coloring,
        apply: async (next, state) => {
          cancel();
          await commitColors(state);
          specification = next;
        },
      },
      onApply: async (request, result, signal) => {
        cancel();
        if (result) await commitColors(result.coloring || null);
        else if (specification) {
          const job = new AbortController();
          controller = job;
          const data = await evaluateMapAnalysis(
            transport,
            null,
            specification,
            layerIds(),
            signal || job.signal,
          );
          if (job.signal.aborted || signal?.aborted || disposed) return;
          await commitColors(data.coloring);
        }
        if (signal?.aborted || disposed) return;
        applying = true;
        try {
          markers.setAttributeSearch(request, result);
          await apply();
        } finally {
          applying = false;
        }
      },
    });
  });
  async function flush() {
    if (
      disposed ||
      running ||
      (!full && !pending.size) ||
      (!markers.attributeSearch && !specification)
    )
      return;
    running = true;
    const all = full;
    full = false;
    const batch = all ? [] : [...pending.values()].slice(0, 512);
    if (all) pending.clear();
    else batch.forEach((t) => pending.delete(`${t.target_type}:${t.id}`));
    const before = recheckContext(),
      markerRevision = markers.mutationRevision,
      shapeRevision = shapes.mutationRevision,
      job = new AbortController();
    controller = job;
    const timeout = setTimeout(() => job.abort(), 60000);
    try {
      const request = markers.attributeSearch
        ? {
            ...markers.attributeSearch,
            layer_ids: layerIds(),
            targets: all ? undefined : batch.map(({ target_type, id }) => ({ target_type, id })),
          }
        : null;
      const data = request
        ? request.use_map_filter
          ? await searchMapAttributes(transport, request, specification, job.signal)
          : validateAttributeResult(
              await transport(attributeSearchPath, request, job.signal),
              request,
            )
        : await evaluateMapAnalysis(
            transport,
            null,
            specification,
            layerIds(),
            job.signal,
            all ? undefined : batch.map((t) => `${t.target_type}:${t.id}`),
          );
      if (disposed || job.signal.aborted) return;
      if (before !== recheckContext()) {
        if (all) full = true;
        else batch.forEach((t) => pending.set(`${t.target_type}:${t.id}`, t));
        return;
      }
      const next = data.coloring;
      if (next) {
        const targets = all ? {} : { ...coloring?.targets };
        const changed = new Set<string>();
        for (const [kind, store, since] of [
          ["marker", markers, markerRevision],
          ["shape", shapes, shapeRevision],
        ] as const)
          for (const [id, version] of store.mutationVersions)
            if (version > since) changed.add(`${kind}:${id}`);
        for (const t of batch)
          if (
            (t.target_type === "marker" ? markers : shapes).mutationVersions.get(t.id) === t.version
          )
            delete targets[`${t.target_type}:${t.id}`];
        for (const [key, value] of Object.entries(next.targets))
          if (!changed.has(key)) targets[key] = value;
        if (all)
          for (const key of changed) {
            if (coloring?.targets[key] !== undefined) targets[key] = coloring.targets[key]!;
            else delete targets[key];
          }
        await commitColors({ ...next, targets });
      }
      if (disposed || job.signal.aborted || before !== recheckContext()) {
        if (!disposed && !job.signal.aborted) {
          if (all) full = true;
          else batch.forEach((t) => pending.set(`${t.target_type}:${t.id}`, t));
        }
        return;
      }
      if (request && "marker_ids" in data) {
        const markerIds = new Set<string>(all ? data.marker_ids : markers.attributeMarkerIds || []),
          shapeIds = new Set<string>(all ? data.shape_ids : markers.attributeShapeIds || []);
        if (all) {
          for (const [store, since, previous, ids] of [
            [markers, markerRevision, markers.attributeMarkerIds, markerIds],
            [shapes, shapeRevision, markers.attributeShapeIds, shapeIds],
          ] as const)
            for (const [id, version] of store.mutationVersions)
              if (version > since) {
                if (previous?.has(id)) ids.add(id);
                else ids.delete(id);
              }
        }
        for (const t of batch) {
          if (
            (t.target_type === "marker" ? markers : shapes).mutationVersions.get(t.id) !== t.version
          )
            continue;
          const ids = t.target_type === "marker" ? markerIds : shapeIds;
          const matched = t.target_type === "marker" ? data.marker_ids : data.shape_ids;
          if (matched.includes(t.id)) ids.add(t.id);
          else ids.delete(t.id);
          (t.target_type === "marker" ? markers : shapes).dirtyIds.add(t.id);
        }
        markers.attributeMarkerIds = markRaw(markerIds);
        markers.attributeShapeIds = markRaw(shapeIds);
        markers.refreshSearchResults(all);
        await apply();
      }
    } catch (e) {
      if (!disposed && !job.signal.aborted)
        message(
          e instanceof Error ? e.message : "属性条件の再判定に失敗しました。再検索してください。",
        );
    } finally {
      clearTimeout(timeout);
      if (controller === job) {
        controller = undefined;
        running = false;
        if (!disposed && (full || pending.size)) void flush();
      }
    }
  }
  const stops = (["marker", "shape"] as const).map((kind) =>
    (kind === "marker" ? markers : shapes).tableChanges.subscribe((change) => {
      if (
        change.type !== "record" ||
        change.kind !== kind ||
        (!specification && !markers.attributeSearch)
      )
        return;
      const key = `${kind}:${change.id}`,
        version = (kind === "marker" ? markers : shapes).mutationVersions.get(change.id) || 0;
      if (version <= (seen.get(key) || 0)) return;
      seen.set(key, version);
      pending.set(key, { target_type: kind, id: change.id, version });
      queueMicrotask(() => void flush());
    }),
  );
  stops.push(
    watch(
      () => markers.attributeRevision,
      () => {
        if (!applying) {
          cancel();
          modal?.close();
          if (!markers.attributeSearch) resetAnalysis();
        }
      },
      { flush: "sync" },
    ),
  );
  stops.push(watch(layer, resetAnalysis));
  onUnmounted(() => {
    disposed = true;
    cancel();
    stops.forEach((stop) => stop());
    modal?.dispose();
  });
  return {
    openAdvancedSearch: () => void modal?.open(),
    closeAdvancedSearch: () => modal?.close(),
    resetAnalysis,
    coloringActive,
    getAnalysisState: () => structuredClone({ specification, coloring }),
    restoreAnalysisState: (state: {
      specification: AnswerColorSpecification | null;
      coloring: AnswerColoring | null;
    }) => {
      cancel();
      specification = state.specification;
      coloring = state.coloring;
      coloringActive.value = !!coloring;
      if (coloring) void colorMap(coloring).catch((e) => message((e as Error).message));
    },
    refreshAttributeSearch: () => {
      if (!disposed && (markers.attributeSearch || specification)) {
        cancel();
        full = true;
        void flush();
      }
    },
  };
}
