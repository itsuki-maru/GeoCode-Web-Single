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
    colorMap = vi.fn().mockResolvedValue(true);
  markers.activateScope("a", false);
  shapes.activateScope("a", false);
  let search!: ReturnType<typeof useMapAnalysisSearch>;
  wrapper = mount(
    defineComponent({
      setup() {
        search = useMapAnalysisSearch(ref("a"), ref("master"), vi.fn(), vi.fn(), colorMap);
        return () => null;
      },
    }),
  );
  return { markers, shapes, search, colorMap };
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
