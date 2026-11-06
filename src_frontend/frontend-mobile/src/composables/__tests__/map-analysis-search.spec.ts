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
      return { open: vi.fn(), close: modal.close, dispose: vi.fn() };
    },
  }),
);
import { useMapAnalysisSearch } from "../useMapAnalysisSearch";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useAuthStore } from "@/stores/auth";
let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
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
