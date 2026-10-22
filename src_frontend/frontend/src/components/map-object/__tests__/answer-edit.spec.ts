import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Modal from "../MapObjectFormInputModal.vue";
import api from "@/axiosClient";
import { resizeImage } from "@/utils/form-image-resize";
vi.mock("@/axiosClient", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), isAxiosError: (e: any) => !!e?.response },
}));
vi.mock("@/utils/form-image-resize", () => ({ resizeImage: vi.fn() }));
const config = (sync = false) => ({
  revision: 7,
  form_title: "投稿時のフォーム",
  form_description: "旧版の説明",
  values: { n: "9007199254740993", flag: false, pic: { url: "/static/images/old.jpg" } },
  form_schema: {
    fields: [
      { id: "n", type: "number", label: "数値", required: true },
      { id: "flag", type: "checkbox", label: "確認" },
      { id: "pic", type: "image", label: "写真" },
    ],
  },
  body_info: {
    sync_required: sync,
    body: "元の本文",
    body_token: "body-version",
    managed_markdown: "回答部分",
  },
});
beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue({ data: config() });
  vi.mocked(api.put)
    .mockReset()
    .mockResolvedValue({ data: { object: { id: "target", detail: "更新後" } } });
  vi.mocked(api.post).mockReset();
  vi.mocked(resizeImage)
    .mockReset()
    .mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
});
async function open() {
  const w = mount(Modal, {
    props: { isOpen: true, targetType: "marker", targetId: "target", answerId: "answer" },
  });
  await flushPromises();
  return w;
}
const payload = () =>
  JSON.parse((vi.mocked(api.put).mock.calls.at(-1)![1] as FormData).get("submission") as string);
describe("既存回答の編集", () => {
  it("投稿時の定義・版番号・数値精度・false・既存画像を維持してPUTする", async () => {
    const w = await open();
    expect(api.get).toHaveBeenCalledWith("/form-answers/marker/answer", expect.anything());
    expect(w.text()).toContain("投稿時のフォーム");
    expect((w.get("#owner-form-n").element as HTMLInputElement).value).toBe("9007199254740993");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith("/form-answers/marker/answer", expect.any(FormData));
    expect(api.post).not.toHaveBeenCalled();
    expect(payload()).toEqual({
      revision: 7,
      values: { n: "9007199254740993", flag: false },
      image_actions: { pic: "keep" },
    });
    expect(w.emitted("saved")?.[0]).toEqual([{ id: "target", detail: "更新後" }]);
    w.unmount();
  });
  it("競合しても入力を保持し、再読み込みまで保存を止める", async () => {
    vi.mocked(api.put).mockRejectedValueOnce({ response: { status: 409 } });
    const w = await open();
    await w.get("#owner-form-n").setValue("123");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.text()).toContain("他で更新されました");
    expect((w.get("#owner-form-n").element as HTMLInputElement).value).toBe("123");
    expect(w.emitted("saved")).toBeUndefined();
    expect(w.get('button[type="submit"]').attributes()).toHaveProperty("disabled");
    w.unmount();
  });
  it("旧本文が曖昧なら明示確認と本文トークン付きで再同期する", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: config(true) });
    const w = await open();
    expect(w.get('button[type="submit"]').attributes()).toHaveProperty("disabled");
    await w.get(".body-reconcile textarea").setValue("残す自由記述");
    await w.get('.body-reconcile input[type="checkbox"]').setValue(true);
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(payload().reconcile).toEqual({ free_text: "残す自由記述", token: "body-version" });
    w.unmount();
  });
  it("画像を回答から外す操作は添付ファイルを送らず明示する", async () => {
    const w = await open();
    await w.get('[aria-label="写真の画像操作"]').setValue("remove");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(payload().image_actions).toEqual({ pic: "remove" });
    expect((vi.mocked(api.put).mock.calls.at(-1)![1] as FormData).has("image__pic")).toBe(false);
    w.unmount();
  });
  it("画像の差し替えだけ新しい添付ファイルを送る", async () => {
    const w = await open();
    await w.get('[aria-label="写真の画像操作"]').setValue("replace");
    const file = w.get('input[type="file"]');
    Object.defineProperty(file.element, "files", {
      value: [new File(["input"], "new.png", { type: "image/png" })],
    });
    await file.trigger("change");
    await flushPromises();
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(payload().image_actions.pic).toBe("replace");
    expect((vi.mocked(api.put).mock.calls.at(-1)![1] as FormData).has("image__pic")).toBe(true);
    w.unmount();
  });
});
