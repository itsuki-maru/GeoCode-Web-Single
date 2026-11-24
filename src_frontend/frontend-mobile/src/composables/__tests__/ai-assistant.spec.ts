import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
const captured = vi.hoisted(() => ({
  options: null as any,
  clear: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
  invalidateSuggestions: vi.fn(),
  enabledImmediately: false,
}));
vi.mock("@/axiosClient", () => ({
  default: { get: vi.fn(), post: vi.fn(), isAxiosError: vi.fn(() => false) },
}));
vi.mock("../../../../template-scripts/src/ai/chat", () => ({
  createAiChat: (options: any) => {
    captured.options = options;
    if (captured.enabledImmediately) options.onEnabledChange(true);
    return {
      clear: captured.clear,
      dispose: captured.dispose,
      open: captured.open,
      invalidateSuggestions: captured.invalidateSuggestions,
    };
  },
}));
import { useAiAssistant } from "../useAiAssistant";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
import { useLayersStore } from "@/stores/layers";
import apiClient from "@/axiosClient";
import { notifyAiSuggestionDataChanged } from "../../../../template-scripts/src/ai/suggestion-events";
let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  captured.enabledImmediately = false;
});
afterEach(() => wrapper?.unmount());
const coloring = (name: string, id = "m1") => ({
  version: 1 as const,
  rules: [{ id: "r", label: name, color: "#ff0000" }],
  targets: { [`marker:${id}`]: "r" },
});
function setup(onAccountChanged?: () => void) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  markers.activateScope("l1", false);
  shapes.activateScope("l1", false);
  for (const id of ["m1", "m2"])
    markers.upsertRecord({
      id,
      layer_id: "l1",
      marker_name: id,
      latitude: 35,
      longitude: 139,
      detail: "",
      update_at: "",
    });
  const layer = ref("l1");
  const bridge = {
    filter: vi.fn().mockResolvedValue(true),
    color: vi.fn().mockResolvedValue(true),
    resetColor: vi.fn().mockResolvedValue(true),
    focus: vi.fn().mockResolvedValue(true),
    view: vi.fn().mockResolvedValue({ latitude: 35, longitude: 139, zoom: 12 }),
    identity: () => "map1",
  };
  let assistant!: ReturnType<typeof useAiAssistant>;
  wrapper = mount(
    defineComponent({
      setup() {
        assistant = useAiAssistant(layer, ref("master"), bridge, undefined, onAccountChanged);
        return () => null;
      },
    }),
  );
  return { markers, layer, bridge, assistant };
}
it("サーバー検出のアカウント不一致はstoreのIDが同じでもAI状態と検索編集を失効させる", async () => {
  const invalidateSearch = vi.fn(),
    { markers, bridge } = setup(invalidateSearch);
  const auth = useAuthStore();
  auth.accountId = "account-a";
  await captured.options.apply(
    { type: "color", coloring: coloring("AI") },
    new AbortController().signal,
  );
  markers.setAiFilter(["marker:m1"]);
  captured.options.onAccountChanged();
  expect(auth.accountId).toBe("account-a");
  expect(markers.aiFilterTargets).toBeNull();
  expect(bridge.resetColor).toHaveBeenCalled();
  expect(invalidateSearch).toHaveBeenCalledOnce();
});

it("shows only the enabled floating icon, retains synchronous capabilities and cleans up on unmount", () => {
  captured.enabledImmediately = true;
  setup();
  const button = document.querySelector<HTMLButtonElement>(
    'button.ai-launcher[data-mode="mobile"]',
  )!;
  expect(button).not.toBeNull();
  expect(button.hidden).toBe(false);
  expect(button.querySelector("img")!.src).toContain("ai_assistant.png");
  button.click();
  expect(captured.open).toHaveBeenCalledWith(button);
  captured.options.onEnabledChange(false);
  expect(button.hidden).toBe(true);
  button.click();
  expect(captured.open).toHaveBeenCalledTimes(1);
  wrapper.unmount();
  expect(document.querySelector(".ai-launcher")).toBeNull();
  expect(captured.dispose).toHaveBeenCalledTimes(1);
});

it("combines AI targets with manual attribute results, including zero matches, and undo preserves manual criteria", async () => {
  const { markers } = setup();
  markers.setAttributeSearch(
    { common_form_id: "f", definition_version: 1, layer_ids: ["l1"], conditions: [] },
    {
      common_form_id: "f",
      definition_version: 1,
      as_of: "now",
      marker_ids: ["m1"],
      shape_ids: [],
      target_count: 1,
    },
  );
  const undo = await captured.options.apply(
    { type: "filter", targets: ["marker:m2"], target_count: 1 },
    new AbortController().signal,
  );
  expect([...markers.mapObjectList.keys()]).toEqual([]);
  await undo();
  expect([...markers.mapObjectList.keys()]).toEqual(["m1"]);
  expect(markers.attributeSearch?.common_form_id).toBe("f");
  await captured.options.apply(
    { type: "filter", targets: [], target_count: 0 },
    new AbortController().signal,
  );
  expect(markers.aiFilterTargets?.size).toBe(0);
  expect([...markers.mapObjectList.keys()]).toEqual([]);
});
it("invalidates data-derived examples without clearing the conversation, AI display or undo", async () => {
  const { markers } = setup();
  const undo = await captured.options.apply(
    { type: "filter", targets: ["marker:m1"], target_count: 1 },
    new AbortController().signal,
  );
  const context = captured.options.getContextKey();
  const suggestionContext = captured.options.getSuggestionContextKey();
  captured.clear.mockClear();
  markers.upsertRecord({ ...markers.getById("m1"), marker_name: "更新後" });
  expect(captured.invalidateSuggestions).toHaveBeenCalledOnce();
  expect(captured.options.getContextKey()).toBe(context);
  expect(captured.options.getSuggestionContextKey()).not.toBe(suggestionContext);
  useShapeStore().removeRecord("removed-shape");
  expect(captured.invalidateSuggestions).toHaveBeenCalledTimes(2);
  expect(captured.clear).not.toHaveBeenCalled();
  expect([...markers.aiFilterTargets!]).toEqual(["marker:m1"]);
  await undo();
  expect(markers.aiFilterTargets).toBeNull();
});

it("refreshes examples for same-account form updates and removes the listener on unmount", () => {
  setup();
  useAuthStore().accountId = "form-owner";
  captured.clear.mockClear();
  const before = captured.options.getSuggestionContextKey();
  notifyAiSuggestionDataChanged("other-owner");
  expect(captured.invalidateSuggestions).not.toHaveBeenCalled();
  notifyAiSuggestionDataChanged("form-owner");
  expect(captured.invalidateSuggestions).toHaveBeenCalledOnce();
  expect(captured.options.getSuggestionContextKey()).not.toBe(before);
  expect(captured.clear).not.toHaveBeenCalled();
  wrapper.unmount();
  notifyAiSuggestionDataChanged("form-owner");
  expect(captured.invalidateSuggestions).toHaveBeenCalledOnce();
});
it("replaces manual coloring and restores each previous result on undo", async () => {
  const { assistant, bridge } = setup();
  await assistant.applyManualColoring(coloring("手動"));
  const undoColor = await captured.options.apply(
    { type: "color", coloring: coloring("AI", "m2") },
    new AbortController().signal,
  );
  expect(bridge.color.mock.lastCall?.[0]).toEqual(coloring("AI", "m2"));
  const undoReset = await captured.options.apply({ type: "reset" }, new AbortController().signal);
  expect(bridge.color.mock.lastCall?.[0]).toBeNull();
  await undoReset();
  expect(bridge.color.mock.lastCall?.[0]).toEqual(coloring("AI", "m2"));
  await undoColor();
  expect(bridge.color.mock.lastCall?.[0]).toEqual(coloring("手動"));
});
it("rolls AI filter back when the map rejects its update", async () => {
  const { markers, bridge } = setup();
  bridge.filter.mockResolvedValueOnce(false);
  await expect(
    captured.options.apply(
      { type: "filter", targets: [], target_count: 0 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("反映");
  expect(markers.aiFilterTargets).toBeNull();
  expect(markers.mapObjectList.size).toBe(2);
});
it("clears chat and AI display on layer changes and refuses old undo", async () => {
  const { markers, layer } = setup();
  const undo = await captured.options.apply(
    { type: "filter", targets: ["marker:m1"], target_count: 1 },
    new AbortController().signal,
  );
  layer.value = "l2";
  expect(markers.aiFilterTargets).toBeNull();
  expect(captured.clear).toHaveBeenCalled();
  await expect(undo()).rejects.toThrow("対象が変わりました");
});

it("finishes a cancelled rollback before applying the next instruction and recording its undo", async () => {
  const { markers, bridge } = setup();
  let finish!: (success: boolean) => void;
  bridge.color.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const first = captured.options
    .apply({ type: "filter", targets: ["marker:m1"], target_count: 1 }, controller.signal)
    .catch((error: Error) => error);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  const next = captured.options.apply(
    { type: "filter", targets: ["marker:m2"], target_count: 1 },
    new AbortController().signal,
  );
  finish(true);
  expect(await first).toBeInstanceOf(Error);
  const undo = await next;
  expect([...markers.aiFilterTargets!]).toEqual(["marker:m2"]);
  await undo();
  expect(markers.aiFilterTargets).toBeNull();
});

it("binds AI POST requests to the authenticated account without adding an actor to capabilities", async () => {
  setup();
  useAuthStore().accountId = "original-account";
  vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as any);
  vi.mocked(apiClient.get).mockResolvedValue({ data: {} } as any);
  const signal = new AbortController().signal;
  await captured.options.transport("/ai/chat", { message: "質問" }, signal);
  expect(apiClient.post).toHaveBeenLastCalledWith(
    "/ai/chat",
    { message: "質問" },
    { signal, timeout: 180000, headers: { "X-AI-Account-ID": "original-account" } },
  );
  await captured.options.transport("/ai/capabilities", undefined, signal);
  expect(apiClient.get).toHaveBeenLastCalledWith("/ai/capabilities", { signal, timeout: 180000 });
});

it("clears the AI conversation when only the shape cache scope changes", () => {
  const { markers } = setup();
  const generation = markers.recordCache.generation;
  const shapeGeneration = useShapeStore().recordCache.generation;
  const before = captured.clear.mock.calls.length;
  useShapeStore().resetCache();
  expect(useShapeStore().recordCache.generation).not.toBe(shapeGeneration);
  expect(markers.recordCache.generation).toBe(generation);
  expect(captured.clear.mock.calls.length).toBeGreaterThan(before);
});

it("guards layer-list synchronization with the original account and scope before accepting results", async () => {
  setup();
  const auth = useAuthStore();
  auth.accountId = "account-before-create";
  let finish!: (value: boolean) => void;
  const init = vi.spyOn(useLayersStore(), "initList").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const signal = new AbortController().signal;
  const pending = captured.options
    .onLayerCreated({ id: "created-layer", name: "施設" }, signal)
    .catch((error: Error) => error);
  const options = init.mock.calls[0]![0]!;
  expect(options.accountId).toBe("account-before-create");
  expect(options.signal).toBe(signal);
  expect(options.isCurrent!()).toBe(true);
  auth.accountId = "account-after-create";
  expect(options.isCurrent!()).toBe(false);
  finish(true);
  expect(await pending).toBeInstanceOf(Error);
});

it("binds write-result GETs to the actor and maps the denied-operation code to its fixed message", async () => {
  setup();
  useAuthStore().accountId = "result-owner";
  vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { status: "prepared" } } as any);
  const signal = new AbortController().signal;
  await captured.options.transport("/ai/operations/op-id", undefined, signal);
  expect(apiClient.get).toHaveBeenLastCalledWith("/ai/operations/op-id", {
    signal,
    timeout: 180000,
    headers: { "X-AI-Account-ID": "result-owner" },
  });
  vi.mocked(apiClient.isAxiosError).mockReturnValue(true);
  vi.mocked(apiClient.get).mockRejectedValueOnce({
    response: {
      status: 403,
      data: { code: "ai_operation_not_allowed", error: "forbidden: arbitrary text" },
    },
  });
  try {
    await expect(
      captured.options.transport("/ai/operations/op-id", undefined, signal),
    ).rejects.toThrow("要求された操作は許可されていません。");
  } finally {
    vi.mocked(apiClient.isAxiosError).mockReturnValue(false);
  }
});

it.each(["filter", "color"] as const)("%sの解除で他方の条件を維持し、Undoで戻す", async (kind) => {
  const { markers, bridge, assistant } = setup();
  await assistant.applyManualColoring(coloring("手動"));
  await captured.options.apply(
    { type: "filter", targets: ["marker:m2"], target_count: 1 },
    new AbortController().signal,
  );
  await captured.options.apply(
    { type: "color", coloring: coloring("AI", "m2") },
    new AbortController().signal,
  );
  const beforeColoring = structuredClone(bridge.color.mock.lastCall![0]);
  const undo = await captured.options.clear(kind, new AbortController().signal);
  if (kind === "filter") {
    expect(markers.aiFilterTargets).toBeNull();
    expect(bridge.color.mock.lastCall![0]).toEqual(beforeColoring);
  } else {
    expect([...markers.aiFilterTargets!]).toEqual(["marker:m2"]);
    expect(bridge.color.mock.lastCall![0]).toBeNull();
  }
  await undo();
  expect([...markers.aiFilterTargets!]).toEqual(["marker:m2"]);
  expect(bridge.color.mock.lastCall![0]).toEqual(beforeColoring);
});

it("AI条件の解除に失敗した場合は片側だけ消えた状態を残さない", async () => {
  const { markers, bridge } = setup();
  await captured.options.apply(
    { type: "filter", targets: ["marker:m1"], target_count: 1 },
    new AbortController().signal,
  );
  bridge.filter.mockResolvedValueOnce(false);
  await expect(captured.options.clear("filter", new AbortController().signal)).rejects.toThrow(
    "反映",
  );
  expect([...markers.aiFilterTargets!]).toEqual(["marker:m1"]);
});
