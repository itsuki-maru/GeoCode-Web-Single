import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));
const modal = vi.hoisted(() => ({ options: null as any, close: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock(
  "../../../../template-scripts/src/map/common/advanced-map-search",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createAdvancedMapSearchModal: (options: any) => {
      modal.options = options;
      return { open: vi.fn(), close: modal.close, dispose: vi.fn(), refreshPresetData: vi.fn() };
    },
  }),
);
import { useMapAnalysisSearch } from "../useMapAnalysisSearch";
import { useAiAssistant } from "../useAiAssistant";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
import { notifyAiSuggestionDataChanged } from "../../../../template-scripts/src/ai/suggestion-events";
let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.isAxiosError.mockReturnValue(false);
});
afterEach(() => wrapper?.unmount());
const shape = (id: string, at = "1") => ({
  id,
  layer_id: "a",
  user_id: "account",
  shape_type: "circle" as const,
  name: id,
  geojson: {},
  created_at: "",
  updated_at: at,
});
const at = "2026-10-30T00:00:00Z";
const result = (targets: string[]) => ({
  as_of: at,
  targets,
  target_count: targets.length,
  answer_count: targets.length,
  forms: [],
  fields: [],
});
const criteria = {
  use_map_filter: true,
  common_form_id: "form",
  definition_version: 1,
  layer_ids: ["a"],
  conditions: [],
};
const specification = {
  common_form_id: "form",
  rules: [
    {
      id: "r",
      label: "分類",
      color: "#ff0000",
      conditions: [{ field_id: "n", field_type: "number", op: "filled", value: null, upper: null }],
    },
  ],
};
const state = {
  version: 1 as const,
  rules: specification.rules.map(({ id, label, color }) => ({ id, label, color })),
  targets: { "shape:s1": "r" },
};
function setup() {
  const markers = useMapObjectStore(),
    shapes = useShapeStore(),
    colorMap = vi.fn().mockResolvedValue(true),
    apply = vi.fn(),
    layer = ref("a"),
    message = vi.fn();
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  let search!: ReturnType<typeof useMapAnalysisSearch>;
  wrapper = mount(
    defineComponent({
      setup() {
        search = useMapAnalysisSearch(layer, ref("master"), apply, message, colorMap);
        return () => null;
      },
    }),
  );
  return { markers, shapes, search, colorMap, apply, layer, message };
}
function pending() {
  let resolve!: (v: any) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("保存条件の取得・保存・削除をactorへ結び付け、不一致後はリロードまで要求しない", async () => {
  const { search, message } = setup();
  const auth = useAuthStore();
  auth.accountId = "account-a";
  const signal = new AbortController().signal;
  api.get.mockResolvedValue({ data: { items: [] } });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: null });
  await modal.options.transport("/form-answers/map-presets?versions=2", undefined, signal);
  await modal.options.transport("/form-answers/map-presets", { name: "変更後" }, signal);
  await modal.options.transport("/form-answers/map-presets/saved-a", undefined, signal, "DELETE");
  for (const mock of [api.get, api.post, api.delete]) {
    const config = mock.mock.calls.at(-1)!.at(-1);
    expect(config).toMatchObject({ signal, headers: { "X-AI-Account-ID": "account-a" } });
  }
  api.isAxiosError.mockReturnValue(true);
  api.post.mockRejectedValueOnce({
    response: { status: 409, data: { code: "ai_account_changed" } },
  });
  const closed = modal.close.mock.calls.length;
  await expect(
    modal.options.transport("/form-answers/map-presets", { name: "漏らさない" }, signal),
  ).rejects.toThrow("ai_account_changed");
  expect(auth.accountId).toBe("account-a");
  expect(modal.close.mock.calls.length).toBeGreaterThan(closed);
  expect(message).toHaveBeenCalledWith(expect.stringContaining("再読み込み"));
  const count = api.post.mock.calls.length;
  auth.accountId = "account-b";
  await expect(
    modal.options.transport("/form-answers/map-presets", { name: "再送禁止" }, signal),
  ).rejects.toThrow("再読み込み");
  await expect(search.recallSavedPreset({} as any)).rejects.toThrow("再読み込み");
  expect(api.post.mock.calls.length).toBe(count);
  expect(message).toHaveBeenCalledOnce();
});

it.each(["account", "layer"])("詳しい検索は%s切替と同時に閉じる", (change) => {
  const { layer } = setup();
  const before = modal.close.mock.calls.length;
  if (change === "account") useAuthStore().accountId = "next-account";
  else layer.value = "next-layer";
  expect(modal.close.mock.calls.length).toBeGreaterThan(before);
});

it("色分けのみの適用時は属性検索による表示制限を作らずに変更対象を再判定する", async () => {
  const { markers, shapes, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s2"]) });
  shapes.upsertRecord(shape("s2"));
  await flushPromises();
  expect(markers.attributeSearch).toBeNull();
  expect(markers.attributeShapeIds).toBeNull();
  expect(colorMap).toHaveBeenLastCalledWith({
    ...state,
    targets: { "shape:s1": "r", "shape:s2": "r" },
  });
  expect(api.post.mock.calls[0]![1]).toMatchObject({
    targets: ["shape:s2"],
    scope: { kind: "layers", layer_ids: ["a"] },
  });
});
it("地図から失敗の応答を受けた場合は分類結果を確定しない", async () => {
  const { colorMap, search } = setup();
  colorMap.mockResolvedValueOnce(false);
  await expect(modal.options.analysis.apply(specification, state)).rejects.toThrow(
    "反映を確認できません",
  );
  expect(search.getAnalysisState()).toEqual({ specification: null, coloring: null });
});
it("絞り込みと併用し、色分けだけを解除しても絞り込みを保持する", async () => {
  const { markers, search, colorMap, apply } = setup();
  const matched = {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
    coloring: state,
  };
  await modal.options.analysis.apply(specification, state);
  await modal.options.onApply(criteria, matched);
  expect(apply).toHaveBeenCalledOnce();
  expect(markers.attributeSearch).toEqual(criteria);
  expect(search.coloringActive.value).toBe(true);
  await modal.options.analysis.apply(null, null);
  expect(colorMap).toHaveBeenLastCalledWith(null);
  expect(search.coloringActive.value).toBe(false);
  expect(markers.attributeSearch).toEqual(criteria);
  expect(markers.attributeShapeIds).toEqual(new Set(["s1"]));
});
it("絞り込みだけを解除すると対象全体に色分けを再適用する", async () => {
  const { markers, search, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  await modal.options.onApply(criteria, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
    coloring: state,
  });
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s1", "marker:m2"]) });
  await modal.options.onApply(null, null);
  expect(markers.attributeSearch).toBeNull();
  expect(search.coloringActive.value).toBe(true);
  expect(colorMap).toHaveBeenLastCalledWith({
    ...state,
    targets: { "shape:s1": "r", "marker:m2": "r" },
  });
});
it("地図への色分け反映に失敗した絞り込みでは適用済みの条件と色を保持する", async () => {
  const { markers, search, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  const original = {
    ...criteria,
    conditions: [{ field_id: "n", field_type: "number", op: "filled" }],
  };
  markers.setAttributeSearch(original, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  colorMap.mockResolvedValueOnce(false);
  await expect(
    modal.options.onApply(criteria, {
      common_form_id: "form",
      definition_version: 1,
      as_of: at,
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
      coloring: { ...state, targets: {} },
    }),
  ).rejects.toThrow("反映を確認できません");
  expect(markers.attributeSearch).toEqual(original);
  expect(search.getAnalysisState().coloring).toEqual(state);
});
it("レイヤ切替で色分けを解除し、閉じるまでに届いた再判定応答を破棄する", async () => {
  const { layer, shapes, search, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  const read = pending();
  api.post.mockReturnValueOnce(read.promise);
  shapes.upsertRecord(shape("s2"));
  await flushPromises();
  layer.value = "b";
  await flushPromises();
  expect(search.coloringActive.value).toBe(false);
  expect(colorMap).toHaveBeenLastCalledWith(null);
  read.resolve({ data: result(["shape:s2"]) });
  await flushPromises();
  expect(search.getAnalysisState()).toEqual({ specification: null, coloring: null });
  expect(colorMap).toHaveBeenLastCalledWith(null);
});
it("絞り込みの地図反映に失敗すると直前の条件と色を復元する", async () => {
  const { markers, search, apply, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  const original = {
    ...criteria,
    conditions: [{ field_id: "n", field_type: "number", op: "filled" }],
  };
  markers.setAttributeSearch(original, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  apply
    .mockRejectedValueOnce(Error("地図への絞り込みを確認できません"))
    .mockResolvedValue(undefined);
  await expect(
    modal.options.onApply(criteria, {
      common_form_id: "form",
      definition_version: 1,
      as_of: at,
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
      coloring: { ...state, targets: {} },
    }),
  ).rejects.toThrow("絞り込みを確認できません");
  expect(markers.attributeSearch).toEqual(original);
  expect(markers.attributeShapeIds).toEqual(new Set(["s1"]));
  expect(search.getAnalysisState().coloring).toEqual(state);
  expect(colorMap).toHaveBeenLastCalledWith(state);
  expect(apply).toHaveBeenCalledTimes(2);
});
it("再読み込み失敗で復元した色分けを再判定し、変更した対象だけ更新する", async () => {
  const { search, colorMap, shapes } = setup();
  await modal.options.analysis.apply(specification, state);
  const snapshot = search.getAnalysisState();
  search.resetAnalysis();
  await search.restoreAnalysisState(snapshot);
  expect(search.coloringActive.value).toBe(true);
  expect(colorMap).toHaveBeenLastCalledWith(state);
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s2"]) });
  shapes.upsertRecord(shape("s2"));
  await flushPromises();
  expect(colorMap).toHaveBeenLastCalledWith({
    ...state,
    targets: { "shape:s1": "r", "shape:s2": "r" },
  });
  expect(api.post.mock.calls[0]![1].targets).toEqual(["shape:s2"]);
});
it("リロード時は反映待ちの色分けを解除し、遅れて届いた完了通知を反映しない", async () => {
  const { search, colorMap } = setup(),
    ack = pending();
  colorMap.mockReturnValueOnce(ack.promise);
  const applying = modal.options.analysis.apply(specification, state);
  search.resetAnalysis();
  expect(colorMap).toHaveBeenLastCalledWith(null);
  ack.resolve(true);
  await expect(applying).rejects.toThrow("状態が変わりました");
  expect(search.coloringActive.value).toBe(false);
  expect(search.getAnalysisState().specification).toBeNull();
});
it("並行して保存されたオブジェクトは個別の再判定が終わるまで以前の検索結果への所属を維持する", async () => {
  const { markers, shapes, search } = setup();
  shapes.upsertRecord(shape("s1"));
  markers.setAttributeSearch(criteria, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  const full = pending(),
    saved = pending();
  api.post.mockReturnValueOnce(full.promise).mockReturnValueOnce(saved.promise);
  search.refreshAttributeSearch();
  shapes.upsertRecord(shape("s1", "2"));
  full.resolve({ data: result([]) });
  await flushPromises();
  expect(markers.attributeShapeIds?.has("s1")).toBe(true);
  expect(api.post.mock.calls[1]![1].targets).toEqual(["shape:s1"]);
  saved.resolve({ data: result([]) });
  await flushPromises();
  expect(markers.attributeShapeIds?.has("s1")).toBe(false);
});

it("地図反映失敗後に一覧と図形の表示も直前に戻る", async () => {
  const { markers, shapes, apply } = setup();
  shapes.upsertRecord(shape("s1"));
  markers.upsertRecord({
    id: "m1",
    layer_id: "a",
    marker_name: "設備",
    detail: "",
    latitude: 35,
    longitude: 139,
    update_at: at,
  });
  const original = {
    ...criteria,
    conditions: [{ field_id: "n", field_type: "number", op: "filled" }],
  };
  markers.setAttributeSearch(original, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: ["m1"],
    shape_ids: ["s1"],
    target_count: 2,
  });
  expect([...markers.mapObjectList.keys()]).toEqual(["m1"]);
  expect(markers.filteredShapeIds).toEqual(["s1"]);
  apply.mockRejectedValueOnce(Error("ACK lost")).mockResolvedValue(undefined);
  await expect(
    modal.options.onApply(criteria, {
      common_form_id: "form",
      definition_version: 1,
      as_of: at,
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
    }),
  ).rejects.toThrow("ACK lost");
  expect(markers.attributeSearch).toEqual(original);
  expect(markers.attributeMarkerIds).toEqual(new Set(["m1"]));
  expect.soft([...markers.mapObjectList.keys()]).toEqual(["m1"]);
  expect.soft(markers.filteredShapeIds).toEqual(["s1"]);
});

it("初回の色分け反映待ち中に保存された対象も再判定される", async () => {
  const { shapes, colorMap, search } = setup();
  shapes.upsertRecord(shape("s1"));
  const ack = pending();
  colorMap.mockReturnValueOnce(ack.promise);
  const applying = modal.options.analysis.apply(specification, state);
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s2"]) });
  shapes.upsertRecord(shape("s2", "2"));
  await flushPromises();
  ack.resolve(true);
  await applying;
  await flushPromises();
  expect(api.post).toHaveBeenCalled();
  expect(search.getAnalysisState().coloring?.targets["shape:s2"]).toBe("r");
});

it("検索の地図反映待ち中にキャッシュがリセットされたら古い条件を復元しない", async () => {
  const { markers, apply } = setup();
  markers.setAttributeSearch(criteria, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  let reject!: (error: Error) => void;
  apply
    .mockReturnValueOnce(
      new Promise((_done, fail) => {
        reject = fail;
      }),
    )
    .mockResolvedValue(undefined);
  const applying = modal.options.onApply(
    { ...criteria, conditions: [{ field_id: "n", field_type: "number", op: "filled" }] },
    {
      common_form_id: "form",
      definition_version: 1,
      as_of: at,
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
    },
  );
  await flushPromises();
  markers.resetCache();
  reject(Error("frame removed"));
  await expect(applying).rejects.toThrow("frame removed");
  expect(markers.attributeSearch).toBeNull();
});

it("新しい色分けの失敗後も、反映待ち中の保存を元の分類で再判定する", async () => {
  const { shapes, search, colorMap } = setup();
  await modal.options.analysis.apply(specification, state);
  const ack = pending();
  colorMap.mockReturnValueOnce(ack.promise);
  const next = structuredClone(specification);
  next.rules[0]!.color = "#0000ff";
  const applying = modal.options.analysis.apply(next, { ...state, rules: next.rules });
  shapes.upsertRecord(shape("s2", "2"));
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s2"]) });
  ack.resolve(false);
  await expect(applying).rejects.toThrow("反映を確認できません");
  await flushPromises();
  expect(search.getAnalysisState().specification).toEqual(specification);
  expect(search.getAnalysisState().coloring?.targets["shape:s2"]).toBe("r");
});

it("連続実行した古い完了応答で最新の分類や保留した保存結果を上書きしない", async () => {
  const { shapes, search, colorMap } = setup();
  const ack = pending();
  colorMap.mockReturnValueOnce(ack.promise);
  const old = modal.options.analysis.apply(specification, state);
  shapes.upsertRecord(shape("s2", "2"));
  api.post
    .mockResolvedValueOnce({ data: result([]) })
    .mockResolvedValueOnce({ data: result(["shape:s2"]) });
  const next = structuredClone(specification);
  next.rules[0]!.color = "#0000ff";
  await modal.options.analysis.apply(next, { ...state, rules: next.rules });
  ack.resolve(true);
  await expect(old).rejects.toThrow("状態が変わりました");
  await flushPromises();
  expect(search.getAnalysisState().specification).toEqual(next);
  expect(search.getAnalysisState().coloring?.rules[0]?.color).toBe("#0000ff");
  expect(search.getAnalysisState().coloring?.targets["shape:s2"]).toBe("r");
});

it("アカウント変更後に届いた初回色分けの応答を採用しない", async () => {
  const { search, colorMap } = setup();
  const ack = pending();
  colorMap.mockReturnValueOnce(ack.promise);
  const applying = modal.options.analysis.apply(specification, state);
  useAuthStore().setAccount("other-account");
  ack.resolve(true);
  await expect(applying).rejects.toThrow("状態が変わりました");
  expect(search.getAnalysisState()).toEqual({ specification: null, coloring: null });
  expect(search.coloringActive.value).toBe(false);
});

it("中断後に絞り込み完了が届いても、同じ表示範囲なら元の条件と一覧に戻す", async () => {
  const { markers, shapes, apply } = setup();
  shapes.upsertRecord(shape("s1"));
  const original = {
    ...criteria,
    conditions: [{ field_id: "n", field_type: "number", op: "filled" }],
  };
  markers.setAttributeSearch(original, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  const ack = pending(),
    controller = new AbortController();
  apply.mockReturnValueOnce(ack.promise).mockResolvedValue(undefined);
  const applying = modal.options.onApply(
    criteria,
    {
      common_form_id: "form",
      definition_version: 1,
      as_of: at,
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
    },
    controller.signal,
  );
  await flushPromises();
  controller.abort();
  ack.resolve(undefined);
  await expect(applying).rejects.toThrow("状態が変わりました");
  expect(markers.attributeSearch).toEqual(original);
  expect(markers.filteredShapeIds).toEqual(["s1"]);
});

it("色の復旧が失敗しても元の絞り込みと一覧の復旧を試みる", async () => {
  const { markers, shapes, colorMap, apply } = setup();
  shapes.upsertRecord(shape("s1"));
  await modal.options.analysis.apply(specification, state);
  markers.setAttributeSearch(criteria, {
    common_form_id: "form",
    definition_version: 1,
    as_of: at,
    marker_ids: [],
    shape_ids: ["s1"],
    target_count: 1,
  });
  colorMap.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  apply.mockRejectedValueOnce(Error("filter ACK lost")).mockResolvedValue(undefined);
  await expect(
    modal.options.onApply(
      { ...criteria, conditions: [{ field_id: "n", field_type: "number", op: "filled" }] },
      {
        common_form_id: "form",
        definition_version: 1,
        as_of: at,
        marker_ids: [],
        shape_ids: [],
        target_count: 0,
        coloring: { ...state, targets: {} },
      },
    ),
  ).rejects.toThrow("filter ACK lost");
  expect(markers.attributeSearch).toEqual(criteria);
  expect(markers.filteredShapeIds).toEqual(["s1"]);
  expect(apply).toHaveBeenCalledTimes(2);
});

function setupSharedConditions() {
  const layer = ref("a");
  const master = ref("master");
  const markers = useMapObjectStore();
  const shapes = useShapeStore();
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  for (const id of ["s1", "s2", "s3"]) shapes.upsertRecord(shape(id));
  const filter = vi.fn().mockResolvedValue(true);
  const color = vi.fn().mockResolvedValue(true);
  const resetColor = vi.fn().mockResolvedValue(true);
  const mapBridge = {
    filter,
    color,
    resetColor,
    focus: vi.fn(),
    view: vi.fn(),
    identity: () => "scope",
    evaluatePreset: (
      definition: import("../../../../template-scripts/src/ai/types").AiDefinition,
    ) => analysis.evaluatePreset(definition),
    prepareManualReplacement: (
      kind: "filter" | "color" | "all",
      signal: AbortSignal,
      localPreset?: boolean,
    ) => analysis.prepareManualReplacement(kind, signal, localPreset),
  };
  let analysis!: ReturnType<typeof useMapAnalysisSearch>;
  let assistant!: ReturnType<typeof useAiAssistant>;
  wrapper = mount(
    defineComponent({
      setup() {
        assistant = useAiAssistant(layer, master, mapBridge);
        analysis = useMapAnalysisSearch(
          layer,
          master,
          async () => {
            if (!(await filter())) throw Error("filter rejected");
          },
          vi.fn(),
          assistant.applyManualColoring,
          resetColor,
          assistant.applyDefinition,
          assistant.clearDefinition,
          assistant.replaceAppliedCondition,
          assistant.getRecalledColoring,
        );
        return () => null;
      },
    }),
  );
  return { analysis, assistant, markers, filter, color };
}
const manualFilterResult = {
  as_of: at,
  common_form_id: "form",
  definition_version: 1,
  marker_ids: [],
  shape_ids: ["s1"],
  target_count: 1,
  coloring: state,
};
const savedFilter = (query1: string) => ({
  type: "filter" as const,
  expression: { op: "text", query1 },
});

it("地物または回答の更新後は、前の表示条件と古い判定用データを次の適用へ持ち越さない", async () => {
  const { markers, shapes, search } = setup();
  const auth = useAuthStore();
  auth.accountId = "owner";
  shapes.upsertRecord(shape("s1"));
  const original = modal.options.getPresetData();
  markers.setAiFilter([]);
  expect(search.evaluatePreset(savedFilter("s1")).targets).toEqual(["shape:s1"]);
  expect(modal.options.getPresetData()).toBe(original);
  shapes.upsertRecord({ ...shape("s1", "2"), name: "更新済み" });
  expect(search.evaluatePreset(savedFilter("更新済み")).targets).toEqual(["shape:s1"]);
  const updated = modal.options.getPresetData();
  expect(updated).not.toBe(original);
  notifyAiSuggestionDataChanged("owner");
  expect(modal.options.getPresetData()).not.toBe(updated);
  expect(api.post).not.toHaveBeenCalled();
});

const savedColor = (value: string) => ({
  type: "color" as const,
  common_form_id: "form",
  rules: [{ ...specification.rules[0], color: value }],
});
const presetData = {
  as_of: at,
  next_cursor: null,
  rows: [
    {
      target: "shape:s1",
      id: "answer-s1",
      form_id: "form",
      revision: 1,
      fields: { n: { type: "number", value: "12" } },
    },
  ],
};

it("別の保存済み絞り込みへ連続切替し、失敗した置換では直前の絞り込みと色分けを保持する", async () => {
  api.get.mockResolvedValue({
    data: { enabled: false, voice_enabled: false, revision: "disabled" },
  });
  api.post.mockResolvedValue({ data: presetData });
  const { analysis, assistant, markers, filter, color } = setupSharedConditions();
  await modal.options.analysis.apply(specification, state);
  await modal.options.onApply(criteria, manualFilterResult);
  await modal.options
    .getPresetData()
    .prepare([savedColor("#ff0000")], new AbortController().signal);
  api.post.mockClear();
  filter.mockResolvedValueOnce(false);
  await expect(assistant.applyDefinition(savedFilter("s2"))).rejects.toThrow("地図への検索");
  expect(markers.attributeSearch).toEqual(criteria);
  expect(markers.aiFilterTargets).toBeNull();

  await assistant.applyDefinition(savedFilter("s2"));
  await assistant.applyDefinition(savedFilter("s3"));
  expect(markers.attributeSearch).toBeNull();
  expect(markers.aiFilterTargets).toEqual(new Set(["shape:s3"]));
  expect(analysis.getAnalysisState().specification).toEqual(specification);
  expect(color).toHaveBeenLastCalledWith(state);
  expect(api.post).not.toHaveBeenCalled();

  filter.mockResolvedValueOnce(false);
  await expect(modal.options.onApply(criteria, manualFilterResult)).rejects.toThrow(
    "filter rejected",
  );
  expect(markers.attributeSearch).toBeNull();
  expect(markers.aiFilterTargets).toEqual(new Set(["shape:s3"]));
  await modal.options.onApply(criteria, manualFilterResult);
  expect(markers.attributeSearch).toEqual(criteria);
  expect(markers.aiFilterTargets).toBeNull();
});

it("別の保存済み色分けに続けて切り替え、手動の色分けへ戻しても絞り込みを保持する", async () => {
  api.get.mockResolvedValue({
    data: { enabled: false, voice_enabled: false, revision: "disabled" },
  });
  api.post.mockResolvedValue({ data: presetData });
  const { analysis, assistant, markers, color } = setupSharedConditions();
  await modal.options.analysis.apply(specification, state);
  await modal.options.onApply(criteria, manualFilterResult);
  await modal.options
    .getPresetData()
    .prepare([savedColor("#223344")], new AbortController().signal);
  api.post.mockClear();
  await assistant.applyDefinition(savedColor("#223344"));
  await assistant.applyDefinition(savedColor("#334455"));
  expect(api.post).not.toHaveBeenCalled();
  expect(markers.attributeSearch).toEqual(criteria);
  expect(analysis.getAnalysisState().specification).toBeNull();
  expect(color).toHaveBeenLastCalledWith({
    ...state,
    rules: [{ ...state.rules[0], color: "#334455" }],
  });

  color.mockResolvedValueOnce(false);
  await expect(modal.options.analysis.apply(specification, state)).rejects.toThrow(
    "地図への色分け",
  );
  expect(color).toHaveBeenLastCalledWith({
    ...state,
    rules: [{ ...state.rules[0], color: "#334455" }],
  });
  await modal.options.analysis.apply(specification, state);
  expect(markers.attributeSearch).toEqual(criteria);
  expect(analysis.getAnalysisState().specification).toEqual(specification);
  expect(color).toHaveBeenLastCalledWith(state);
});

it("チャットからの解除は絞り込みと色分けを同時に外し、元に戻すと両方を復元する", async () => {
  api.get.mockResolvedValue({
    data: { enabled: true, voice_enabled: false, revision: "r1", protocol_version: 2 },
  });
  api.post.mockImplementation(async (path) => ({
    data:
      path === "/ai/chat"
        ? { message: "解除", action: { type: "reset" }, revision: "r1" }
        : path === "/ai/assist/execute"
          ? { type: "reset" }
          : { revision: "r1", as_of: at, suggestions: [] },
  }));
  const { analysis, assistant, markers, color } = setupSharedConditions();
  await modal.options.analysis.apply(specification, state);
  await modal.options.onApply(criteria, manualFilterResult);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value() {
        this.removeAttribute("open");
      },
    },
  });
  assistant.openAiChat();
  await flushPromises();
  const chat = document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!;
  chat.querySelector("textarea")!.value = "解除";
  chat
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(markers.attributeSearch).toBeNull();
  expect(analysis.getAnalysisState().specification).toBeNull();
  expect(color).toHaveBeenLastCalledWith(null);
  [...chat.querySelectorAll("button")].find((button) => button.textContent === "元に戻す")!.click();
  await flushPromises();
  expect(markers.attributeSearch).toEqual(criteria);
  expect(analysis.getAnalysisState().specification).toEqual(specification);
  expect(color).toHaveBeenLastCalledWith(state);
});
