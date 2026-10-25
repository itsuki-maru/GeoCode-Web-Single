import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "@/axiosClient";
import AnswerColoringPanel from "../AnswerColoringPanel.vue";
vi.mock("@/axiosClient", () => ({ default: { post: vi.fn() } }));
const fields = [
  { id: "n", label: "数値", field_type: "number", choices: [] },
  { id: "c", label: "状態", field_type: "checkbox", choices: [] },
];
beforeEach(() => vi.mocked(apiClient.post).mockResolvedValue({ data: { fields } }));
afterEach(() => vi.restoreAllMocks());
const create = () =>
  mount(AnswerColoringPanel, {
    props: {
      forms: [
        { id: "form", label: "共通フォーム" },
        { id: "other", label: "別フォーム" },
      ],
      endpoint: "/form-answers/map-filter",
      query: { mode: "latest" },
      targets: ["marker:one"],
      requiredForm: "form",
      disabled: false,
      active: false,
    },
  });
const click = async (wrapper: ReturnType<typeof create>, text: string) => {
  await wrapper
    .findAll("button")
    .find((button) => button.text() === text)!
    .trigger("click");
  await flushPromises();
};
describe("色分けの分類編集", () => {
  it("保存は編集中の定義だけを渡し、呼び出しも実行せずに数値・falseを復元する", async () => {
    const w = create();
    const definition = {
      common_form_id: "form",
      rules: [
        {
          id: "saved",
          label: "保存した分類",
          color: "#2166ac",
          conditions: [
            {
              field_id: "n",
              field_type: "number",
              op: "between",
              value: "9007199254740993.1",
              upper: "9007199254740994.1",
            },
            { field_id: "c", field_type: "checkbox", op: "eq", value: false, upper: null },
          ],
        },
      ],
    };
    w.vm.restoreDraft(definition, fields);
    await flushPromises();
    expect(w.get('[aria-label="分類名"]').element.value).toBe("保存した分類");
    expect(w.get('[aria-label="色分けの条件値"]').element.value).toBe("9007199254740993.1");
    expect(w.get('[aria-label="色分けの範囲終了値"]').element.value).toBe("9007199254740994.1");
    expect(w.get('[aria-label="色分けの回答値"]').element.value).toBe("false");
    expect(w.emitted("apply")).toBeUndefined();
    expect(apiClient.post).not.toHaveBeenCalled();
    await click(w, "検索条件を保存");
    expect(w.emitted("save")![0][0]).toMatchObject({
      common_form_id: "form",
      rules: [{ label: "保存した分類", conditions: definition.rules[0].conditions }],
    });
    expect(w.emitted("apply")).toBeUndefined();
    expect(() =>
      w.vm.restoreDraft(
        {
          ...definition,
          rules: [
            {
              ...definition.rules[0],
              conditions: [
                { field_id: "removed", field_type: "number", op: "gte", value: "50", upper: null },
              ],
            },
          ],
        },
        fields,
      ),
    ).toThrow("項目が見つかりません");
    await flushPromises();
    expect(w.get('[aria-label="分類名"]').element.value).toBe("保存した分類");
    expect(w.get('[aria-label="色分けの条件値"]').element.value).toBe("9007199254740993.1");
    w.unmount();
  });
  it("パネルを開くまで取得せず、条件を編集・並べ替えて未適用の設定として送る", async () => {
    const w = create();
    expect(apiClient.post).not.toHaveBeenCalled();
    const panel = w.get("details");
    (panel.element as HTMLDetailsElement).open = true;
    await panel.trigger("toggle");
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(
      w
        .get('[aria-label="色分けの共通フォーム"]')
        .findAll("option")
        .map((option) => option.element.value),
    ).toEqual(["", "form"]);
    await click(w, "分類を追加");
    await w.get('[aria-label="分類名"]').setValue("高額");
    await w.get('[aria-label="色分けの条件値"]').setValue("9007199254740993.1");
    await click(w, "分類を追加");
    await w.findAll('[aria-label="分類名"]')[1].setValue("未確認");
    await w.findAll('[aria-label="色分けの入力項目"]')[1].setValue("c:checkbox");
    await w.get('[aria-label="色分けの回答値"]').setValue("false");
    await w.findAll('[aria-label="分類を上へ"]')[1].trigger("click");
    await click(w, "色分け実行");
    const value = w.emitted("apply")![0][0] as any;
    expect(value.common_form_id).toBe("form");
    expect(value.rules.map((rule: any) => rule.label)).toEqual(["未確認", "高額"]);
    expect(value.rules[0].conditions[0].value).toBe(false);
    expect(value.rules[1].conditions[0].value).toBe("9007199254740993.1");
    expect(w.text()).toContain("色分けは未適用");
    w.unmount();
  });
  it("API失敗を表示し、操作禁止中は実行できない", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(Error("network"));
    const w = create();
    (w.get("details").element as HTMLDetailsElement).open = true;
    await w.get("details").trigger("toggle");
    await flushPromises();
    expect(w.text()).toContain("入力項目を取得できません");
    await w.setProps({ disabled: true });
    expect(w.get("fieldset").attributes("disabled")).toBeDefined();
    expect(w.emitted("apply")).toBeUndefined();
    await w.setProps({ requiredForm: "other" });
    await w.setProps({ disabled: false });
    await flushPromises();
    expect(w.text()).not.toContain("入力項目を取得できません");
    expect(
      w
        .findAll("button")
        .find((button) => button.text() === "分類を追加")!
        .attributes("disabled"),
    ).toBeUndefined();
    w.unmount();
  });
  it("開いたパネルのフォーム制約が変わった場合と操作禁止解除後に入力項目を取得する", async () => {
    const w = create();
    const panel = w.get("details");
    (panel.element as HTMLDetailsElement).open = true;
    await panel.trigger("toggle");
    await flushPromises();
    await w.setProps({ requiredForm: "other" });
    await flushPromises();
    expect(apiClient.post).toHaveBeenLastCalledWith(
      "/form-answers/map-filter",
      expect.objectContaining({ common_form_id: "other" }),
      expect.anything(),
    );
    await w.setProps({ disabled: true });
    const count = vi.mocked(apiClient.post).mock.calls.length;
    await w.setProps({ requiredForm: "form" });
    expect(apiClient.post).toHaveBeenCalledTimes(count);
    await w.setProps({ disabled: false });
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(count + 1);
    expect(apiClient.post).toHaveBeenLastCalledWith(
      "/form-answers/map-filter",
      expect.objectContaining({ common_form_id: "form" }),
      expect.anything(),
    );
    expect(
      w
        .findAll("button")
        .find((button) => button.text() === "分類を追加")!
        .attributes("disabled"),
    ).toBeUndefined();
    w.unmount();
  });
});
