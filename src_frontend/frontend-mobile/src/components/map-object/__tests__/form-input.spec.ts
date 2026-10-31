import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, it, expect, vi } from "vitest";
import apiClient from "@/axiosClient";
import Modal from "../MapObjectFormInputModal.vue";
import { resizeImage } from "@/utils/form-image-resize";
vi.mock("@/axiosClient", () => ({
  default: { get: vi.fn(), post: vi.fn(), isAxiosError: (e: any) => !!e?.response },
}));
vi.mock("@/utils/form-image-resize", () => ({ resizeImage: vi.fn() }));
const config = () => ({
  form_title: "施設情報",
  form_description: "説明",
  config_token: "token",
  values: {
    n: "9007199254740993",
    flag: false,
    date: "2020-04-01",
    choice: "GX",
    radio: "A",
    note: "備考",
  },
  form_schema: {
    fields: [
      { id: "n", label: "耐用年数", type: "number", required: true },
      { id: "flag", label: "確認", type: "checkbox" },
      { id: "date", label: "建設年月日", type: "date" },
      { id: "choice", label: "材質", type: "select", choices: ["GX", "塩ビ"] },
      { id: "radio", label: "区分", type: "radio", choices: ["A", "B"] },
      { id: "note", label: "備考", type: "textarea" },
      { id: "photo", label: "画像", type: "image" },
    ],
  },
});
const mountModal = async () => {
  const w = mount(Modal, { props: { isOpen: true, targetType: "marker", targetId: "one" } });
  await flushPromises();
  return w;
};
beforeEach(() => {
  vi.mocked(apiClient.get).mockReset().mockResolvedValue({ data: config() });
  vi.mocked(apiClient.post)
    .mockReset()
    .mockResolvedValue({ data: { object: { id: "one", detail: "追記済み" } } });
  vi.mocked(resizeImage)
    .mockReset()
    .mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
});
describe("所有者フォーム入力", () => {
  it("最新値・false・数値精度を保持し、構造化データと設定トークンを送る", async () => {
    const w = await mountModal();
    expect(apiClient.get).toHaveBeenCalledWith("/marker/one/form/input", expect.anything());
    expect((w.get("#owner-form-n").element as HTMLInputElement).value).toBe("9007199254740993");
    expect((w.get("#owner-form-flag").element as HTMLInputElement).checked).toBe(false);
    await w.get("#owner-form-n").setValue("9007199254740995");
    await w.get("form").trigger("submit");
    await flushPromises();
    const [url, data] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(url).toBe("/marker/one/form/submissions");
    const body = JSON.parse((data as FormData).get("submission") as string);
    expect(body).toEqual({
      config_token: "token",
      values: {
        n: "9007199254740995",
        flag: false,
        date: "2020-04-01",
        choice: "GX",
        radio: "A",
        note: "備考",
      },
    });
    expect(w.emitted("saved")![0]).toEqual([{ id: "one", detail: "追記済み" }]);
    w.unmount();
  });
  it("画像処理中と保存中は二重送信せず、画像はmultipartに添付する", async () => {
    const w = await mountModal();
    let finish!: (v: Blob) => void;
    vi.mocked(resizeImage).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const input = w.get("#owner-form-photo");
    Object.defineProperty(input.element, "files", {
      value: [new File(["raw"], "sample.png")],
      configurable: true,
    });
    await input.trigger("change");
    await w.get("form").trigger("submit");
    expect(apiClient.post).not.toHaveBeenCalled();
    finish(new Blob(["prepared"], { type: "image/jpeg" }));
    await flushPromises();
    let resolve!: (v: any) => void;
    vi.mocked(apiClient.post).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await w.get("form").trigger("submit");
    await w.get("form").trigger("submit");
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(apiClient.post).mock.calls[0]![1] as FormData).get("image__photo"),
    ).toBeInstanceOf(File);
    expect(
      w
        .findAll("button")
        .find((b) => b.text() === "閉じる")!
        .attributes("disabled"),
    ).toBeDefined();
    resolve({ data: { object: { id: "one" } } });
    await flushPromises();
    w.unmount();
  });
  it("409では入力を保持し、再読み込みするまで再送しない", async () => {
    const w = await mountModal();
    await w.get("#owner-form-n").setValue("20");
    vi.mocked(apiClient.post).mockRejectedValueOnce({ response: { status: 409, data: {} } });
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.text()).toContain("フォームの設定が変更されました");
    expect((w.get("#owner-form-n").element as HTMLInputElement).value).toBe("20");
    await w.get("form").trigger("submit");
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    await w
      .findAll("button")
      .find((b) => b.text() === "再読み込み")!
      .trigger("click");
    await flushPromises();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    w.unmount();
  });
  it("古い取得応答を破棄し、取得失敗後も閉じられる", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(apiClient.get).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const w = mount(Modal, { props: { isOpen: true, targetType: "marker", targetId: "old" } });
    await w.setProps({ targetType: "shape", targetId: "new" });
    await flushPromises();
    resolve({ data: { ...config(), form_title: "古いフォーム" } });
    await flushPromises();
    expect(w.text()).not.toContain("古いフォーム");
    expect(apiClient.get).toHaveBeenLastCalledWith("/shape/new/form/input", expect.anything());
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error("network"));
    await w.setProps({ targetId: "failed" });
    await flushPromises();
    expect(w.text()).toContain("フォームを取得できませんでした");
    await w
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});

describe("入力フォームの取得・変換エラー", () => {
  it.each([404, 400])("取得エラーを利用者へ説明し、送信可能にしない: %s", async (status) => {
    vi.mocked(apiClient.get).mockRejectedValueOnce({
      response: { status, data: { error: "validation error: 入力エラー" } },
    });
    const w = await mountModal();
    expect(w.text()).toContain(status === 404 ? "見つかりません" : "入力エラー");
    expect(apiClient.post).not.toHaveBeenCalled();
    w.unmount();
  });
  it("不正なフォーム応答を拒否する", async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: { values: {}, form_schema: { fields: null } },
    });
    const w = await mountModal();
    expect(w.text()).toContain("フォームを取得できません");
    expect(w.find("form").exists()).toBe(false);
    w.unmount();
  });
  it.each([new Error("画像が壊れています"), "unknown"])(
    "画像変換失敗の後に再選択できる: %s",
    async (error) => {
      const w = await mountModal();
      vi.mocked(resizeImage).mockRejectedValueOnce(error);
      const file = w.get('input[type="file"]');
      Object.defineProperty(file.element, "files", {
        configurable: true,
        value: [new File(["bad"], "bad.png")],
      });
      await file.trigger("change");
      await flushPromises();
      expect(w.text()).toContain(error instanceof Error ? error.message : "画像を処理できません");
      expect((file.element as HTMLInputElement).value).toBe("");
      await file.trigger("change");
      await flushPromises();
      expect(w.text()).toContain("準備完了");
      w.unmount();
    },
  );
  it("選択項目・ラジオ・チェック・テキストを編集し、未選択へ戻す", async () => {
    const w = await mountModal();
    await w.get("#owner-form-choice").setValue("塩ビ");
    await w.get('input[type="radio"][value="B"]').setValue(true);
    await w.get("#owner-form-flag").setValue(true);
    await w.get("#owner-form-note").setValue("変更");
    const reset = w.findAll("button").find((b) => b.text().includes("選択を解除"))!;
    await reset.trigger("click");
    await w.get("form").trigger("submit");
    await flushPromises();
    const body = JSON.parse(
      String((vi.mocked(apiClient.post).mock.lastCall![1] as FormData).get("submission")),
    );
    expect(body.values).toMatchObject({ choice: "塩ビ", radio: "", flag: true, note: "変更" });
    w.unmount();
  });
});
