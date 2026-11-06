import { ref, markRaw, onMounted, onUnmounted, watch, type Ref } from "vue";
import apiClient from "@/axiosClient";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
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
  discardColors: () => Promise<boolean> = () => colorMap(null),
) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    auth = useAuthStore();
  const coloringActive = ref(false);
  let analysisLayer = layer.value;
  let coloringPending = 0;
  let specification: AnswerColorSpecification | null = null,
    coloring: AnswerColoring | null = null;
  let modal: ReturnType<typeof createAdvancedMapSearchModal> | undefined;
  let disposed = false,
    revision = 0,
    running = false,
    full = false;
  let ownAttributeChanges = 0;
  type Operation = { revision: number; identity: string; layer?: string; signal?: AbortSignal };
  let foreground: Operation | undefined;
  let controller: AbortController | undefined;
  const seen = new Map<string, number>();
  const pending = new Map<
    string,
    { target_type: "marker" | "shape"; id: string; version: number }
  >();
  const layerIds = () => (layer.value === master.value ? null : [layer.value]);
  const identity = () =>
    JSON.stringify([
      auth.accountId,
      markers.recordCache.generation,
      shapes.recordCache.generation,
      markers.activeLayerId,
      markers.activeIsMaster,
      shapes.activeLayerId,
      shapes.activeIsMaster,
    ]);
  const context = () =>
    `${revision}:${identity()}:${layer.value}:${markers.mutationRevision}:${shapes.mutationRevision}`;
  const recheckContext = () => `${revision}:${identity()}`;
  const isCurrent = (job: Operation, allowAborted = false) =>
    !disposed &&
    job.revision === revision &&
    job.identity === identity() &&
    (job.layer === undefined || job.layer === layer.value) &&
    (allowAborted || !job.signal?.aborted);
  const assertCurrent = (job: Operation, allowAborted = false) => {
    if (!isCurrent(job, allowAborted))
      throw Error("地図の状態が変わりました。もう一度実行してください。");
  };
  // 自分自身の同期的な条件更新だけを監視対象から除外する。反映待ち中の外部クリアは除外しない。
  const changeAttributes = (change: () => void) => {
    ++ownAttributeChanges;
    try {
      change();
    } finally {
      --ownAttributeChanges;
    }
  };
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
  const commitColors = async (
    next: AnswerColoring | null,
    job: Operation = { revision, identity: identity() },
    force = false,
    allowAborted = false,
  ) => {
    assertCurrent(job, allowAborted);
    if (!force && !next && !coloring && !coloringPending) return;
    ++coloringPending;
    try {
      const success = await colorMap(next);
      assertCurrent(job, allowAborted);
      if (!success) throw Error("地図への色分けの反映を確認できませんでした。再試行してください。");
      coloring = next;
      coloringActive.value = !!next;
    } finally {
      --coloringPending;
    }
  };
  const cancel = () => {
    if (running) full = true;
    ++revision;
    const previous = controller;
    controller = undefined;
    previous?.abort();
    running = false;
    foreground = undefined;
  };
  const beginOperation = (signal?: AbortSignal, checkLayer = true): Operation => {
    cancel();
    const job = {
      revision,
      identity: identity(),
      layer: checkLayer ? layer.value : undefined,
      signal,
    };
    foreground = job;
    return job;
  };
  const finishOperation = (job: Operation, recheck = true) => {
    if (foreground !== job) return;
    foreground = undefined;
    if (!markers.attributeSearch && !specification) {
      pending.clear();
      full = false;
    } else if (recheck && (full || pending.size)) queueMicrotask(() => void flush());
  };
  const resetAnalysis = () => {
    analysisLayer = layer.value;
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
      void discardColors().catch((e) => message((e as Error).message));
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
          const job = beginOperation();
          const previous = coloring;
          try {
            await commitColors(state, job);
            assertCurrent(job);
            specification = next;
            analysisLayer = markers.activeLayerId || layer.value;
          } catch (error) {
            if (isCurrent(job, true)) {
              try {
                await commitColors(previous, job, true, true);
              } catch {
                /* 元の反映エラーを表示する。 */
              }
            }
            throw error;
          } finally {
            finishOperation(job);
          }
        },
      },
      onApply: async (request, result, signal) => {
        const job = beginOperation(signal);
        const previous = {
          request: markers.attributeSearch,
          markerIds: markers.attributeMarkerIds,
          shapeIds: markers.attributeShapeIds,
          coloring,
        };
        let changedAttributes = false,
          attemptedColors = false;
        try {
          assertCurrent(job);
          let nextColors = result?.coloring || null;
          if (!result && specification) {
            const read = new AbortController();
            controller = read;
            const data = await evaluateMapAnalysis(
              transport,
              null,
              specification,
              layerIds(),
              signal || read.signal,
            );
            assertCurrent(job);
            nextColors = data.coloring;
          }
          attemptedColors = !!(nextColors || coloring || coloringPending);
          await commitColors(nextColors, job);
          assertCurrent(job);
          changeAttributes(() => markers.setAttributeSearch(request, result));
          changedAttributes = true;
          await apply();
          assertCurrent(job);
        } catch (error) {
          if (isCurrent(job, true)) {
            if (changedAttributes)
              changeAttributes(() => {
                markers.attributeSearch = previous.request;
                markers.attributeMarkerIds = previous.markerIds;
                markers.attributeShapeIds = previous.shapeIds;
                ++markers.attributeRevision;
                markers.refreshSearchResults(true);
              });
            try {
              if (attemptedColors) await commitColors(previous.coloring, job, true, true);
            } catch {
              // 色の復旧が失敗しても、同じ範囲なら絞り込みの復旧は試みる。
            }
            if (changedAttributes && isCurrent(job, true)) {
              try {
                await apply();
              } catch {
                /* 元の反映エラーを表示して再試行を促す。 */
              }
            }
          }
          throw error;
        } finally {
          finishOperation(job);
        }
      },
    });
  });
  async function flush() {
    if (
      disposed ||
      foreground ||
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
    // レイヤ切替の失敗時は、選択欄を戻すより先に表示データが復元される。
    // 再判定は、選択欄ではなく現在の表示範囲を対象にする。
    const scopeLayerIds = markers.activeIsMaster ? null : [markers.activeLayerId];
    controller = job;
    const timeout = setTimeout(() => job.abort(), 60000);
    try {
      const request = markers.attributeSearch
        ? {
            ...markers.attributeSearch,
            layer_ids: scopeLayerIds,
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
            scopeLayerIds,
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
      if (!disposed && !job.signal.aborted && before === recheckContext())
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
        (!specification && !markers.attributeSearch && !foreground)
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
        if (!ownAttributeChanges) {
          cancel();
          modal?.close();
          if (!markers.attributeSearch) resetAnalysis();
          else if (full || pending.size) queueMicrotask(() => void flush());
        }
      },
      { flush: "sync" },
    ),
  );
  stops.push(watch(() => auth.accountId, resetAnalysis, { flush: "sync" }));
  stops.push(
    watch(layer, (next) => {
      // 切替失敗で復元した表示範囲へ選択欄が戻っても、復元済みの色を解除しない。
      if (next !== analysisLayer) resetAnalysis();
    }),
  );
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
    restoreAnalysisState: async (state: {
      specification: AnswerColorSpecification | null;
      coloring: AnswerColoring | null;
    }) => {
      const job = beginOperation(undefined, false);
      const hadColoring = !!coloring || coloringPending > 0;
      analysisLayer = markers.activeLayerId || layer.value;
      specification = state.specification;
      coloring = null;
      coloringActive.value = false;
      try {
        await commitColors(state.coloring, job, hadColoring || !!state.coloring);
        return true;
      } catch (error) {
        if (isCurrent(job)) message((error as Error).message);
        return false;
      } finally {
        finishOperation(job, false);
      }
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
