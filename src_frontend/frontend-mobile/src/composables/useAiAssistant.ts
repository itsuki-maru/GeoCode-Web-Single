import { onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from "vue";
import apiClient from "@/axiosClient";
import { useAuthStore } from "@/stores/auth";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { createAiChat } from "../../../template-scripts/src/ai/chat";
import { createAiLauncher } from "../../../template-scripts/src/ai/launcher";
import { observeAiSuggestionDataChanges } from "../../../template-scripts/src/ai/suggestion-events";
import { assetsUrl } from "@/settingMobile";
import type { ManualConditionReplacement } from "../../../template-scripts/src/ai/map-state";
import { aiFailureMessage } from "../../../template-scripts/src/ai/types";
import type {
  AiDefinition,
  AiExecutionResult,
  AiMapView,
  AiTransport,
  AiUndo,
} from "../../../template-scripts/src/ai/types";
import type { AnswerColoring } from "../../../template-scripts/src/map/answer-coloring";
import type { SavedMapPreset } from "../../../template-scripts/src/map/common/answer-map-presets";

interface RecalledAnalysisState {
  targets: string[] | null;
  coloring: AnswerColoring | null;
}

interface MapBridge {
  filter(): Promise<boolean>;
  color(value: AnswerColoring | null): Promise<boolean>;
  resetColor(): Promise<boolean>;
  focus(latitude: number, longitude: number, zoom?: number): Promise<boolean>;
  view(): Promise<AiMapView | null>;
  identity(): string;
  managesReload?: boolean;
  evaluatePreset?(definition: AiDefinition): AiExecutionResult;
  presetContextKey?(): string;
  preparePresetPage?(presets: SavedMapPreset[], signal: AbortSignal): Promise<void>;
  prepareManualReplacement?(
    kind: "filter" | "color" | "all",
    signal: AbortSignal,
    localPreset?: boolean,
  ): Promise<ManualConditionReplacement | undefined>;
}

/** 地図反映と取り消しを直列化し、各種別の適用済み条件を置換する。 */
export function useAiAssistant(
  layer: Ref<string>,
  master: Ref<string>,
  bridge: MapBridge,
  onRecallPreset?: (preset: SavedMapPreset) => void | Promise<void>,
  onAccountChanged?: () => void,
) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    auth = useAuthStore();
  const layers = useLayersStore();
  const aiEnabled = ref(false);
  let chat: ReturnType<typeof createAiChat> | undefined;
  let launcher: ReturnType<typeof createAiLauncher> | undefined;
  let manualColoring: AnswerColoring | null = null;
  const aiColoring = shallowRef<AnswerColoring | null>(null);
  let committedAnalysis: RecalledAnalysisState = { targets: null, coloring: null };
  const confirmAnalysis = () => {
    committedAnalysis = {
      targets: markers.aiFilterTargets ? [...markers.aiFilterTargets] : null,
      coloring: aiColoring.value,
    };
  };
  let disposed = false;
  let clearRevision = 0;
  let suggestionRevision = 0;
  let stopSuggestionUpdates: (() => void) | undefined;
  let mapQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mapQueue.then(operation);
    mapQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const identity = () =>
    JSON.stringify([
      auth.accountId,
      layer.value,
      markers.recordCache.generation,
      shapes.recordCache.generation,
      bridge.identity(),
    ]);
  const check = (key: string, signal?: AbortSignal) => {
    if (disposed || signal?.aborted || key !== identity())
      throw Error("地図の対象が変わりました。現在の地図で再実行してください。");
  };
  const transport: AiTransport = async (path, body, signal) => {
    try {
      return body === undefined
        ? (
            await apiClient.get(path, {
              signal,
              timeout: 180000,
              ...(path === "/ai/capabilities"
                ? {}
                : { headers: { "X-AI-Account-ID": auth.accountId } }),
            })
          ).data
        : (
            await apiClient.post(path, body, {
              signal,
              timeout: 180000,
              headers: { "X-AI-Account-ID": auth.accountId },
            })
          ).data;
    } catch (error) {
      if (apiClient.isAxiosError(error)) {
        throw Error(aiFailureMessage(error.response?.data, "AIへの要求に失敗しました。"));
      }
      throw error;
    }
  };
  const paint = async () => {
    if (!(await bridge.color(aiColoring.value ?? manualColoring)))
      throw Error("地図への色分けの反映を確認できませんでした。");
  };
  const perform = async (
    result: AiExecutionResult | { type: "clear"; kind: "filter" | "color" },
    signal: AbortSignal,
    preset?: { key?: string },
  ): Promise<AiUndo | void> => {
    const key = identity();
    const generation = clearRevision;
    const assert = (currentSignal?: AbortSignal) => {
      check(key, currentSignal);
      if (currentSignal && preset && preset.key !== bridge.presetContextKey?.())
        throw Error("地図のデータが変更されました。現在のデータで再実行してください。");
      if (generation !== clearRevision)
        throw Error("地図の状態が変わりました。再実行してください。");
    };
    assert(signal);
    if (result.type === "focus") {
      const previous = await bridge.view();
      assert(signal);
      if (!previous) throw Error("現在の地図の状態を取得できませんでした。");
      try {
        if (!(await bridge.focus(result.latitude!, result.longitude!, result.zoom)))
          throw Error("地図の移動を確認できませんでした。");
        assert(signal);
      } catch (error) {
        if (!disposed && generation === clearRevision && key === identity())
          await bridge
            .focus(previous.latitude, previous.longitude, previous.zoom)
            .catch(() => false);
        throw error;
      }
      return () =>
        enqueue(async () => {
          assert();
          if (!(await bridge.focus(previous.latitude, previous.longitude, previous.zoom)))
            throw Error("地図の移動を元に戻せませんでした。");
          assert();
        });
    }
    const kind =
      result.type === "clear" ? result.kind : result.type === "reset" ? "all" : result.type;
    const replacement = await bridge.prepareManualReplacement?.(kind, signal, !!preset);
    const previous = {
      targets: markers.aiFilterTargets ? [...markers.aiFilterTargets] : null,
      coloring: aiColoring.value ? structuredClone(aiColoring.value) : null,
      manualColoring,
    };
    const restore = async () => {
      assert();
      replacement?.restore();
      if (kind !== "filter" || replacement) manualColoring = previous.manualColoring;
      markers.setAiFilter(previous.targets);
      aiColoring.value = previous.coloring;
      await paint();
      if (!(await bridge.filter())) throw Error("地図への検索の反映を確認できませんでした。");
      assert();
      confirmAnalysis();
    };
    try {
      assert(signal);
      replacement?.apply();
      if (kind !== "filter" || replacement) manualColoring = replacement?.coloring ?? null;
      if (result.type === "filter") markers.setAiFilter(result.targets!);
      else if (result.type === "color") aiColoring.value = result.coloring!;
      else if (result.type === "clear") {
        if (result.kind === "filter") markers.setAiFilter(null);
        else aiColoring.value = null;
      } else {
        markers.setAiFilter(null);
        aiColoring.value = null;
      }
      await paint();
      assert(signal);
      if (!(await bridge.filter())) throw Error("地図への検索の反映を確認できませんでした。");
      assert(signal);
      confirmAnalysis();
      return () => enqueue(restore);
    } catch (error) {
      if (!disposed && generation === clearRevision && key === identity())
        await restore().catch(() => undefined);
      throw error;
    } finally {
      replacement?.finish();
    }
  };
  const clearState = () => {
    ++clearRevision;
    const hadAiColoring = !!aiColoring.value;
    aiColoring.value = null;
    manualColoring = null;
    markers.setAiFilter(null);
    confirmAnalysis();
    if (hadAiColoring) void bridge.resetColor().catch(() => undefined);
  };
  const applyPreset = (
    result: AiExecutionResult | { type: "clear"; kind: "filter" | "color" },
    signal: AbortSignal,
  ) => {
    const scope = { key: bridge.presetContextKey?.() };
    return enqueue(() => perform(result, signal, scope));
  };
  const clear = () => {
    clearState();
    chat?.clear();
  };
  const invalidateSuggestions = () => {
    ++suggestionRevision;
    chat?.invalidateSuggestions();
  };
  onMounted(() => {
    launcher = createAiLauncher({
      mode: "mobile",
      iconUrl: (assetsUrl || "/assets/") + "ai_assistant.png",
      onActivate: (button) => chat?.open(button),
    });
    chat = createAiChat({
      mode: "mobile",
      transport,
      getContext: () => ({ layer_ids: layer.value === master.value ? null : [layer.value] }),
      getContextKey: identity,
      getSuggestionContextKey: () =>
        JSON.stringify([
          identity(),
          markers.mutationRevision,
          shapes.mutationRevision,
          suggestionRevision,
        ]),
      apply: (result, signal) => enqueue(() => perform(result, signal)),
      evaluatePreset: bridge.evaluatePreset,
      applyPreset,
      clear: (kind, signal) => applyPreset({ type: "clear", kind }, signal),
      onEnabledChange: (value) => {
        aiEnabled.value = value;
        launcher?.setEnabled(value);
      },
      onAccountChanged: () => {
        clearState();
        onAccountChanged?.();
      },
      onRecallPreset,
      preparePresetPage: bridge.preparePresetPage,
      onLayerCreated: async (_layer, signal) => {
        const key = identity();
        const accountId = auth.accountId;
        check(key, signal);
        if (
          !(await layers.initList({
            signal,
            accountId,
            isCurrent: () => !disposed && !signal.aborted && key === identity(),
          }))
        )
          throw Error("レイヤー一覧を更新できませんでした。");
        check(key, signal);
      },
    });
    stopSuggestionUpdates = observeAiSuggestionDataChanges(
      () => auth.accountId,
      invalidateSuggestions,
    );
  });
  watch(layer, () => (bridge.managesReload ? chat?.close() : clear()), { flush: "sync" });
  watch(() => auth.accountId, clear, { flush: "sync" });
  let markerGeneration = markers.recordCache.generation;
  let shapeGeneration = shapes.recordCache.generation;
  // recordCache is markRaw; loadRevision is the reactive notification for cache resets.
  watch(
    () => [markers.loadRevision, shapes.loadRevision],
    () => {
      const markerNext = markers.recordCache.generation;
      const shapeNext = shapes.recordCache.generation;
      if (markerNext === markerGeneration && shapeNext === shapeGeneration) return;
      markerGeneration = markerNext;
      shapeGeneration = shapeNext;
      clear();
    },
    { flush: "sync" },
  );
  watch(() => bridge.identity(), clear, { flush: "sync" });
  watch(() => [markers.mutationRevision, shapes.mutationRevision], invalidateSuggestions, {
    flush: "sync",
  });
  onUnmounted(() => {
    disposed = true;
    stopSuggestionUpdates?.();
    launcher?.dispose();
    chat?.dispose();
  });
  return {
    aiEnabled,
    openAiChat: () => chat?.open(),
    applyDefinition: async (definition: AiDefinition, signal?: AbortSignal) => {
      if (!chat) throw Error("AIアシスタントの準備ができていません。");
      await chat.applyDefinition(definition, signal);
    },
    clearDefinition: async (kind: "filter" | "color", signal?: AbortSignal) => {
      if (!chat) throw Error("AIアシスタントの準備ができていません。");
      await chat.clearDefinition(kind, signal);
    },
    clearAi: clear,
    cancelAiRequest: () => chat?.close(),
    getRecalledAnalysisState: () => committedAnalysis,
    async restoreRecalledAnalysisState(state: RecalledAnalysisState, signal: AbortSignal) {
      if (signal.aborted) return;
      if (markers.aiFilterTargets || state.targets) markers.setAiFilter(state.targets);
      const hadColoring = !!aiColoring.value;
      aiColoring.value = state.coloring;
      confirmAnalysis();
      if (hadColoring || state.coloring) await paint().catch(() => undefined);
    },
    getRecalledColoring: () => aiColoring.value,
    replaceAppliedCondition(
      kind: "filter" | "color",
      definition: AiDefinition | null,
      apply: () => Promise<void>,
      signal?: AbortSignal,
    ) {
      const key = identity(),
        generation = clearRevision;
      return enqueue(async () => {
        const targets = markers.aiFilterTargets;
        const coloring = aiColoring.value;
        check(key, signal);
        if (generation !== clearRevision)
          throw Error("地図の状態が変わりました。再実行してください。");
        if (kind === "filter" && targets) markers.setAiFilter(null);
        if (kind === "color") aiColoring.value = null;
        try {
          await apply();
          check(key);
          chat?.setAppliedDefinition(kind, definition);
          confirmAnalysis();
        } catch (error) {
          if (!disposed && generation === clearRevision && key === identity()) {
            if (kind === "filter" && targets) {
              markers.setAiFilter([...targets]);
              await bridge.filter().catch(() => false);
            } else if (kind === "color" && coloring) {
              aiColoring.value = coloring;
              await paint().catch(() => undefined);
            }
          }
          throw error;
        }
      });
    },
    async applyManualColoring(value: AnswerColoring | null) {
      const previous = manualColoring;
      manualColoring = value;
      try {
        await paint();
        return true;
      } catch {
        manualColoring = previous;
        return false;
      }
    },
  };
}
