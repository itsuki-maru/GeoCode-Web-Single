import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MessageModal from "@/components/common/MessageModal.vue";
import CommonFormsModal from "@/components/map-object/CommonFormsModal.vue";
import FormSettings from "@/components/map-object/MapObjectFormSettingsModal.vue";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
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
  api.isAxiosError.mockReturnValue(false);
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

describe("設定の検証・競合・公開URL操作", () => {
  it.each([
    ["title", "フォーム名を入力"],
    ["empty", "入力項目を追加"],
    ["label", "すべての項目名"],
    ["choices", "選択肢が必要"],
    ["password", "4〜64文字"],
  ])("不正な設定を送信しない: %s", async (kind, message) => {
    const config = structuredClone(existing);
    if (kind === "title") config.form_title = " ";
    if (kind === "empty") config.form_schema.fields = [];
    if (kind === "label") config.form_schema.fields[0]!.label = " ";
    if (kind === "choices")
      Object.assign(config.form_schema.fields[0]!, { type: "select", choices: [] });
    api.get.mockImplementation(async (url: string) => ({
      data: url === "/common-forms" ? [] : config,
    }));
    const w = await open();
    if (kind === "password") {
      await w.get('input[type="radio"][value="set"]').setValue(true);
      await w.get('input[type="password"]').setValue("abc");
    }
    await click(w, "フォーム設定を保存");
    expect(api.request).not.toHaveBeenCalled();
    expect(w.text()).toContain(message);
    w.unmount();
  });

  it("項目を並べ替え・削除し選択肢を正規化する", async () => {
    api.get.mockImplementation(async (url: string) => ({
      data:
        url === "/common-forms"
          ? []
          : {
              ...existing,
              form_schema: {
                fields: [
                  { ...field, id: "first", label: "先頭" },
                  { ...field, id: "second", label: "後続", type: "select", choices: ["A"] },
                ],
              },
            },
    }));
    const w = await open();
    await w.get('button[aria-label="入力項目の編集について"]').trigger("click");
    expect(w.text()).toContain("並べ替え");
    await w
      .findAll(".field-card")[0]!
      .findAll("button")
      .find((b) => b.text() === "↓")!
      .trigger("click");
    expect(
      w.findAll(".field-card")[0]!.get<HTMLInputElement>('input[type="text"]').element.value,
    ).toBe("後続");
    expect(w.findAll(".field-card")[0]!.findAll("button")[0]!.attributes("disabled")).toBeDefined();
    await w.findAll(".field-card")[0]!.get("textarea").setValue(" A \n\n B ");
    await w.findAll(".field-card")[1]!.get("button.danger").trigger("click");
    await click(w, "フォーム設定を保存");
    expect(api.request.mock.calls[0]![0].data.form_schema.fields).toEqual([
      expect.objectContaining({ id: "second", choices: ["A", "B"], max_length: null }),
    ]);
    w.unmount();
  });

  it.each([true, false])("公開URLをコピーし失敗時は手動コピーを案内する: %s", async (success) => {
    const writeText = vi.fn();
    if (success) writeText.mockResolvedValue(undefined);
    else writeText.mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const w = await open();
    await click(w, "URLをコピー");
    expect(writeText).toHaveBeenCalledWith(window.location.origin + "/forms/existing");
    expect(w.text()).toContain(success ? "URLをコピーしました" : "手動でコピー");
    w.unmount();
  });

  it.each([true, false])("URL再発行を確認し失敗時は現在のURLを保持する: %s", async (success) => {
    const w = await open();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(w, "URLを再発行");
    expect(api.post).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    if (success) api.post.mockResolvedValue({ data: { ...existing, public_path: "/forms/new" } });
    else api.post.mockRejectedValue(new Error("offline"));
    await click(w, "URLを再発行");
    expect(api.post).toHaveBeenCalledWith("/marker/target/form/rotate-url");
    expect(w.get("a").attributes("href")).toContain(success ? "/forms/new" : "/forms/existing");
    expect(w.text()).toContain(success ? "再発行しました" : "再発行できません");
    w.unmount();
  });

  it.each([409, 400])("サーバーの競合・検証エラーを表示して編集内容を保つ: %s", async (status) => {
    const w = await open();
    api.isAxiosError.mockReturnValue(true);
    api.request.mockRejectedValue({
      response: { status, data: { error: "validation error: 入力が無効です" } },
    });
    await click(w, "フォーム設定を保存");
    expect(w.text()).toContain(status === 409 ? "別の画面で設定が更新" : "入力が無効です");
    expect(w.get<HTMLInputElement>(".basic-settings input").element.value).toBe("既存");
    w.unmount();
  });

  it("共通フォームの新版を検出したら古い定義を送信しない", async () => {
    const w = await open({ commonMode: true, commonId: "template", targetId: "" });
    api.get.mockResolvedValue({ data: { ...common, version: 4 } });
    await click(w, "共通フォームを保存");
    expect(api.request).not.toHaveBeenCalled();
    expect(w.text()).toContain("別の画面で設定が更新");
    w.unmount();
  });

  it("定義の取得失敗を通知して閉じ、適用失敗では元の定義を維持する", async () => {
    const w = await open();
    await w.get("select").setValue("template");
    await click(w, "共通フォームを使用する");
    api.get.mockRejectedValue(new Error("offline"));
    await click(w.getComponent(MessageModal), "共通フォームを使用する");
    expect(w.text()).toContain("共通フォームを読み込めません");
    expect(w.get<HTMLInputElement>(".basic-settings input").element.value).toBe("既存");
    await w.setProps({ isOpen: false });
    await w.setProps({ isOpen: true });
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});

describe("共通フォーム管理の再読込と編集結果", () => {
  const manage = async () => {
    const w = mount(CommonFormsModal, {
      props: { isOpen: false },
      global: { stubs: { MapObjectFormSettingsModal: true, FormAnswersModal: true } },
    });
    await w.setProps({ isOpen: true });
    await flushPromises();
    return w;
  };
  it("一覧取得失敗を再読込で回復し、作成・編集・保存・閉じるを連携する", async () => {
    api.get.mockRejectedValueOnce(new Error("offline"));
    const w = await manage();
    expect(w.text()).toContain("一覧を読み込めません");
    await click(w, "共通フォームを作成");
    const editor = w.getComponent({ name: "MapObjectFormSettingsModal" });
    expect(editor.props("commonId")).toBe("");
    editor.vm.$emit("close");
    await flushPromises();
    await w.get('input[value="list"]').setValue(true);
    await click(w, "再読み込み");
    await click(w, "編集");
    expect(editor.props("commonId")).toBe("template");
    editor.vm.$emit("message", "入力の説明");
    await flushPromises();
    expect(w.text()).toContain("入力の説明");
    editor.vm.$emit("saved");
    await flushPromises();
    expect(w.text()).toContain("共通フォームを保存しました");
    expect(editor.props("isOpen")).toBe(false);
    await w.get('input[value="create"]').setValue(true);
    await click(w, "回答一覧と分析");
    expect(w.getComponent({ name: "FormAnswersModal" }).props("initialFormId")).toBe("");
    await w.get("header .close-button").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
  it("削除失敗は一覧を保持して再試行を案内する", async () => {
    const w = await manage();
    await w.get('input[value="list"]').setValue(true);
    await w.get("article button:last-child").trigger("click");
    api.delete.mockRejectedValueOnce(new Error("offline"));
    const confirm = w.findAllComponents(MessageModal).find((m) => m.props("isOpen"))!;
    confirm.vm.$emit("confirm");
    await flushPromises();
    expect(w.text()).toContain("削除できません");
    expect(w.findAll("article")).toHaveLength(1);
    w.unmount();
  });
  it("定義の全入力を保存へ反映し、共通フォーム一覧の失敗を個別設定の失敗にしない", async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === "/common-forms") throw new Error("offline");
      return { data: existing };
    });
    const w = await open();
    expect(w.text()).toContain("共通フォーム一覧を読み込めません");
    await w.get(".basic-settings textarea").setValue("新しい説明");
    await w.get('.field-card input[type="text"]').setValue("新しい項目名");
    await w.get('.field-card input[type="number"]').setValue("500");
    await w.get('.field-card input[type="checkbox"]').setValue(true);
    await w.get('input[type="radio"][value="clear"]').setValue(true);
    await click(w, "項目を追加");
    await w.findAll(".field-card")[1]!.findAll("button")[0]!.trigger("click");
    await click(w, "フォーム設定を保存");
    expect(api.request.mock.lastCall![0].data).toMatchObject({
      form_description: "新しい説明",
      password_mode: "clear",
      form_schema: {
        fields: [
          expect.anything(),
          expect.objectContaining({ label: "新しい項目名", max_length: 500, required: true }),
        ],
      },
    });
    await w.get("header .close-button").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
  it("保存前の反映先確認が失敗したら送信せず入力を保つ", async () => {
    const w = await open({ commonMode: true, commonId: "template", targetId: "" });
    api.get.mockRejectedValueOnce(new Error("offline"));
    await click(w, "共通フォームを保存");
    expect(api.request).not.toHaveBeenCalled();
    expect(w.text()).toContain("反映先を確認できません");
    w.unmount();
  });
});
