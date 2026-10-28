import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MessageModal from "@/components/common/MessageModal.vue";
import CommonFormsModal from "@/components/map-object/CommonFormsModal.vue";
import FormSettings from "@/components/map-object/MapObjectFormSettingsModal.vue";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
  delete: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
const field = {
  id: "stable_id",
  label: "値",
  type: "text",
  required: false,
  max_length: 200,
  choices: [],
};
const common = {
  id: "template",
  version: 3,
  form_title: "共通",
  form_description: "説明",
  form_schema: { fields: [field] },
};
const existing = {
  enabled: true,
  form_title: "既存",
  form_description: "",
  form_schema: { fields: [{ ...field, id: "existing" }] },
  is_password_protected: true,
  public_path: "/forms/existing",
};
beforeEach(() => {
  api.get.mockImplementation(async (url: string) => ({
    data: url === "/common-forms" ? [common] : url.startsWith("/common-forms/") ? common : existing,
  }));
  api.request.mockResolvedValue({ data: { ...existing, ...common } });
});
const open = async (extra = {}) => {
  const wrapper = mount(FormSettings, {
    props: { isOpen: false, targetType: "marker", targetId: "target", ...extra },
  });
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  return wrapper;
};
const click = async (wrapper: ReturnType<typeof mount>, text: string) => {
  const button = wrapper.findAll("button").find((button) => button.text() === text);
  expect(button).toBeTruthy();
  await button!.trigger("click");
  await flushPromises();
};
describe("共通フォームのコピー適用", () => {
  it.each(["marker", "shape"] as const)(
    "%sの公開設定を維持して項目IDと適用元を保存する",
    async (targetType) => {
      const wrapper = await open({ targetType });
      await wrapper.get("select").setValue("template");
      await click(wrapper, "共通フォームを使用する");
      expect(api.get).not.toHaveBeenCalledWith("/common-forms/template");
      await click(wrapper.getComponent(MessageModal), "共通フォームを使用する");
      await click(wrapper, "フォーム設定を保存");
      const request = api.request.mock.calls[0][0];
      expect(request.url).toBe(`/${targetType}/target/form`);
      expect(request.data).toMatchObject({
        enabled: true,
        password_mode: "keep",
        password: null,
        source_form: { id: "template", version: 3 },
        form_schema: { fields: [field] },
      });
      expect(wrapper.get("a").attributes("href")).toContain("/forms/existing");
      wrapper.unmount();
    },
  );
  it("適用のキャンセルで入力内容を変更しない", async () => {
    const wrapper = await open();

    await wrapper.get("select").setValue("template");
    await click(wrapper, "共通フォームを使用する");
    await click(wrapper.getComponent(MessageModal), "閉じる");
    await click(wrapper, "フォーム設定を保存");
    expect(api.request.mock.calls[0][0].data.form_title).toBe("既存");
    expect(api.request.mock.calls[0][0].data.source_form).toBeNull();
    wrapper.unmount();
  });
  it("共通フォームの編集で版を送信し、項目の種類変更でIDを新しくする", async () => {
    const wrapper = await open({ commonMode: true, commonId: "template", targetId: "" });
    expect(wrapper.text()).toContain("パスワード");
    const select = wrapper
      .findAll("select")
      .find((select) => select.find('option[value="number"]').exists());
    await select!.setValue("number");
    await click(wrapper, "共通フォームを保存");
    const request = api.request.mock.calls[0][0];
    expect(request).toMatchObject({
      method: "put",
      url: "/common-forms/template",
      data: { version: 3 },
    });
    expect(request.data.form_schema.fields[0].id).not.toBe("stable_id");
    expect(request.data.form_schema.fields[0].type).toBe("number");
    wrapper.unmount();
  });
  it("新規作成をPOSTし、失敗時は入力内容とエラーを表示する", async () => {
    const wrapper = await open({ commonMode: true, targetId: "" });
    const title = wrapper.findAll('input[type="text"]')[0];
    await title.setValue("新規");
    await click(wrapper, "項目を追加");
    api.request.mockRejectedValueOnce(new Error("failure"));
    await click(wrapper, "共通フォームを保存");
    expect(api.request.mock.calls[0][0]).toMatchObject({ method: "post", url: "/common-forms" });
    expect(wrapper.text()).toContain("保存できませんでした");
    expect((title.element as HTMLInputElement).value).toBe("新規");
    expect(wrapper.emitted("saved")).toBeUndefined();
    wrapper.unmount();
  });
});

describe("共通フォーム管理の確認操作", () => {
  it("削除はメッセージモーダルで確認してから実行し、閉じる場合は削除しない", async () => {
    const wrapper = mount(CommonFormsModal, { props: { isOpen: false } });
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    await wrapper.get('input[value="list"]').setValue(true);
    await wrapper.get("article button:last-child").trigger("click");
    const dialog = wrapper.findAllComponents(MessageModal).find((modal) => modal.props("isOpen"))!;
    expect(dialog.props("message")).toContain("適用済みのフォームと回答履歴は残ります");
    expect(api.delete).not.toHaveBeenCalled();
    await click(dialog, "閉じる");
    expect(api.delete).not.toHaveBeenCalled();
    await wrapper.get("article button:last-child").trigger("click");
    api.delete.mockResolvedValueOnce({});
    await click(dialog, "削除");
    expect(api.delete).toHaveBeenCalledExactlyOnceWith("/common-forms/template");
    wrapper.unmount();
  });
});

describe("レイヤ管理と共通パスワード", () => {
  it("管理中の定義を編集不可にし、公開可否とURLだけ操作できる", async () => {
    api.get.mockResolvedValue({
      data: { ...existing, managed_layer_id: "layer", source_form: { id: "template", version: 3 } },
    });
    const w = await open();
    expect(w.text()).toContain("このレイヤの地図オブジェクトには共通フォームが設定されています。");
    expect(w.get(".readonly-definition").attributes("disabled")).toBeDefined();
    expect(w.find(".common-form-apply-row").exists()).toBe(false);
    expect(w.find('input[type="password"]').exists()).toBe(false);
    expect(w.find("a").exists()).toBe(false);
    await w.get(".enabled-row input").setValue(false);
    await click(w, "フォーム設定を保存");
    expect(api.request.mock.calls[0][0].data).toMatchObject({
      enabled: false,
      password_mode: "keep",
      form_title: "既存",
    });
    w.unmount();
  });
  it("共通フォームの反映先を確認し、キャンセルでは保存しない", async () => {
    api.get.mockImplementation(async (url: string) => ({
      data:
        url === "/common-forms"
          ? [common]
          : {
              ...common,
              managed_layer_count: 2,
              managed_target_count: 30,
              applied_target_count: 40,
              is_password_protected: true,
            },
    }));
    const w = await open({ commonMode: true, commonId: "template", targetId: "" });
    await w.get('input[type="radio"][value="set"]').setValue(true);
    await w.get('input[type="password"]').setValue("new-password");
    await click(w, "共通フォームを保存");
    expect(api.request).not.toHaveBeenCalled();
    const confirmation = w
      .findAllComponents(MessageModal)
      .find((c) => c.props("confirmLabel") === "保存して反映する")!;
    expect(confirmation.props("isOpen")).toBe(true);
    expect(confirmation.props("message")).toContain("2レイヤ・30対象");
    expect(confirmation.props("message")).toContain("40対象");
    confirmation.vm.$emit("close");
    await flushPromises();
    expect(api.request).not.toHaveBeenCalled();
    await click(w, "共通フォームを保存");
    confirmation.vm.$emit("confirm");
    await flushPromises();
    expect(api.request.mock.calls[0][0].data).toMatchObject({
      password_mode: "set",
      password: "new-password",
      expected_managed_count: 30,
      expected_applied_count: 40,
    });
    w.unmount();
  });
});

it("回答一覧を開いている間だけ生成し、閉じる・再表示でインスタンスを作り直す", async () => {
  const stub = {
    name: "FormAnswersModal",
    props: ["isOpen", "initialFormId"],
    emits: ["close"],
    template: "<div />",
  };
  const wrapper = mount(CommonFormsModal, {
    props: { isOpen: false },
    global: { stubs: { FormAnswersModal: stub } },
  });
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  expect(wrapper.findComponent({ name: "FormAnswersModal" }).exists()).toBe(false);
  await wrapper.get('input[value="list"]').setValue(true);
  await click(wrapper, "回答一覧");
  const first = wrapper.getComponent({ name: "FormAnswersModal" });
  expect(first.props("initialFormId")).toBe("template");
  first.vm.$emit("close");
  await flushPromises();
  expect(wrapper.findComponent({ name: "FormAnswersModal" }).exists()).toBe(false);
  await click(wrapper, "回答一覧");
  expect(wrapper.getComponent({ name: "FormAnswersModal" }).vm).not.toBe(first.vm);
  await wrapper.setProps({ isOpen: false });
  expect(wrapper.findComponent({ name: "FormAnswersModal" }).exists()).toBe(false);
  wrapper.unmount();
});
