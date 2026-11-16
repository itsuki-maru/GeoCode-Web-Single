import { onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import apiClient from "@/axiosClient";
import { useAuthStore } from "@/stores/auth";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { createAiChat } from "../../../template-scripts/src/ai/chat";
import { createAiLauncher } from "../../../template-scripts/src/ai/launcher";
import { observeAiSuggestionDataChanges } from "../../../template-scripts/src/ai/suggestion-events";
import { assetsUrl } from "@/setting";
import { mergeAiColoring } from "../../../template-scripts/src/ai/map-state";
import { aiFailureMessage } from "../../../template-scripts/src/ai/types";
import type {
  AiExecutionResult,
  AiMapView,
  AiTransport,
  AiUndo,
} from "../../../template-scripts/src/ai/types";
import type { AnswerColoring } from "../../../template-scripts/src/map/answer-coloring";

interface MapBridge {
  filter(): Promise<boolean>;
  color(value: AnswerColoring | null): Promise<boolean>;
  resetColor(): Promise<boolean>;
  focus(latitude: number, longitude: number, zoom?: number): Promise<boolean>;
  view(): Promise<AiMapView | null>;
  identity(): string;
}

/** AIの一時表示を手動の検索・色分けと分離する。保存レコードは変更しない。 */
export function useAiAssistant(layer: Ref<string>, master: Ref<string>, bridge: MapBridge) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    auth = useAuthStore();
  const layers = useLayersStore();
  const aiEnabled = ref(false);
  let chat: ReturnType<typeof createAiChat> | undefined;
  let launcher: ReturnType<typeof createAiLauncher> | undefined;
  let manualColoring: AnswerColoring | null = null;
  let aiColoring: AnswerColoring | null = null;
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
    if (!(await bridge.color(mergeAiColoring(manualColoring, aiColoring))))
      throw Error("地図への色分けの反映を確認できませんでした。");
  };
  const perform = async (
    result: AiExecutionResult,
    signal: AbortSignal,
  ): Promise<AiUndo | void> => {
    const key = identity();
    const generation = clearRevision;
    const assert = (currentSignal?: AbortSignal) => {
      check(key, currentSignal);
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
    const previous = {
      targets: markers.aiFilterTargets ? [...markers.aiFilterTargets] : null,
      coloring: aiColoring ? structuredClone(aiColoring) : null,
    };
    const restore = async () => {
      assert();
      markers.setAiFilter(previous.targets);
      aiColoring = previous.coloring;
      await paint();
      if (!(await bridge.filter())) throw Error("地図への検索の反映を確認できませんでした。");
      assert();
    };
    try {
      if (result.type === "filter") markers.setAiFilter(result.targets!);
      else if (result.type === "color") aiColoring = result.coloring!;
      else {
        markers.setAiFilter(null);
        aiColoring = null;
      }
      await paint();
      assert(signal);
      if (!(await bridge.filter())) throw Error("地図への検索の反映を確認できませんでした。");
      assert(signal);
      return () => enqueue(restore);
    } catch (error) {
      if (!disposed && generation === clearRevision && key === identity())
        await restore().catch(() => undefined);
      throw error;
    }
  };
  const clearState = () => {
    ++clearRevision;
    const hadAiColoring = !!aiColoring;
    aiColoring = null;
    manualColoring = null;
    markers.setAiFilter(null);
    if (hadAiColoring) void bridge.resetColor().catch(() => undefined);
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
      mode: "desktop",
      iconUrl: (assetsUrl || "/assets/") + "ai_assistant.png",
      onActivate: (button) => chat?.open(button),
    });
    chat = createAiChat({
      mode: "desktop",
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
      onEnabledChange: (value) => {
        aiEnabled.value = value;
        launcher?.setEnabled(value);
      },
      onAccountChanged: clearState,
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
  watch(layer, clear, { flush: "sync" });
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
    applyPreset: async (id: string, signal?: AbortSignal) => {
      if (!chat) throw Error("AIアシスタントの準備ができていません。");
      await chat.applyPreset(id, signal);
    },
    clearAi: clear,
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
