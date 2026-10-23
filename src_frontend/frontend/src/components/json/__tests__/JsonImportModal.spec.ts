import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  isAxiosError: vi.fn((value) => !!value?.isAxiosError),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
import JsonImportModal from "@/components/json/JsonImportModal.vue";

let wrapper: VueWrapper;
const file = (text = "{}") => {
  const bytes = new TextEncoder().encode(text);
  const value = new File([text], "export.json", { type: "application/json" });
  Object.defineProperty(value, "arrayBuffer", { value: async () => bytes.buffer });
  return value;
};
async function select(value: File) {
  const input = wrapper.get("input[type=file]");
  Object.defineProperty(input.element, "files", { configurable: true, value: [value] });
  await input.trigger("change");
}
async function submit() {
  await wrapper.get(".btn-file-upload").trigger("click");
  await flushPromises();
}
const key = (index: number) => api.post.mock.calls[index]![2].headers["Idempotency-Key"];

beforeEach(() => {
  sessionStorage.clear();
  api.post.mockResolvedValue({ data: { message: "Upload Ok." } });
  api.get.mockResolvedValue({ data: { id: "account" } });
  wrapper = mount(JsonImportModal, { props: { isOpen: true, accountScope: "account" } });
});
afterEach(() => wrapper.unmount());

describe("JSON取込の再試行", () => {
  it.each([
    { isAxiosError: true, message: "network" },
    { isAxiosError: true, response: { status: 500, data: { error: "database error" } } },
    { isAxiosError: true, response: { status: 401, data: { error: "token_expired" } } },
  ])("結果が未確認の再試行では同じキーとファイルを送る (%j)", async (error) => {
    api.post.mockRejectedValueOnce(error);
    const value = file();
    await select(value);
    await submit();
    expect(wrapper.emitted("imported")).toBeUndefined();
    expect(wrapper.emitted("message")).toHaveLength(1);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await submit();
    expect(key(1)).toBe(key(0));
    expect(api.post.mock.calls[1]![2].headers["X-Import-Account"]).toBe("account");
    expect((api.post.mock.calls[1]![1] as FormData).get("upload_file")).toBe(value);
    expect(wrapper.emitted("imported")).toHaveLength(1);
  });

  it("ファイルのクリアや別ファイル選択で未解決操作を失わず、成功後は新しいキーにする", async () => {
    api.post.mockRejectedValueOnce({ isAxiosError: true });
    await select(file("A"));
    await submit();
    await wrapper.get(".btn-secondary").trigger("click");
    await select(file("B"));
    await submit();
    await select(file("A"));
    await submit();
    expect(key(2)).toBe(key(0));
    expect(key(1)).not.toBe(key(0));
    await select(file("A"));
    await submit();
    expect(key(3)).not.toBe(key(0));
  });

  it("処理中の二重クリックを防ぎ、成功通知はHTTP成功後に一度だけ行う", async () => {
    let resolve!: (value: unknown) => void;
    api.post.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await select(file());
    await submit();
    await submit();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("imported")).toBeUndefined();
    resolve({ data: {} });
    await flushPromises();
    expect(wrapper.emitted("imported")).toHaveLength(1);
    expect(wrapper.emitted("message")).toBeUndefined();
    expect(wrapper.emitted("showProgress")).toEqual([[true], [false]]);
  });

  it("キーを保存できない場合はPOSTを実行しない", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await select(file());
    await submit();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")?.[0]?.[0]).toContain("保存できません");
  });

  it("別タブでアカウントが変わっていた場合は送信せず再読み込みを案内する", async () => {
    api.get.mockResolvedValue({ data: { id: "different-account" } });
    await select(file());
    await submit();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")?.[0]?.[0]).toContain("アカウントが変わりました");
    expect(wrapper.emitted("imported")).toBeUndefined();
  });

  it("通信失敗からの再試行でも現在のアカウントを再確認する", async () => {
    api.post.mockRejectedValueOnce({ isAxiosError: true });
    await select(file());
    await submit();
    api.get.mockResolvedValue({ data: { id: "different-account" } });
    await submit();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("message")?.at(-1)?.[0]).toContain("アカウントが変わりました");
  });

  it("表示だけの再更新ではPOSTせず親へ要求する", async () => {
    await wrapper.setProps({ syncFailed: true });
    await wrapper.get(".sync-retry button").trigger("click");
    expect(wrapper.emitted("retrySync")).toHaveLength(1);
    expect(api.post).not.toHaveBeenCalled();
  });
});
