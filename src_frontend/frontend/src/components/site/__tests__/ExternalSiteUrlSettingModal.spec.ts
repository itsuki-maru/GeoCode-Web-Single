import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({
  default: { get: deps.get, put: deps.put, isAxiosError: (e: any) => !!e?.isAxiosError },
}));
import Modal from "../ExternalSiteUrlSettingModal.vue";
import { externalSiteUrl } from "@/router/urls";

enableAutoUnmount(afterEach);
beforeEach(() => {
  deps.get.mockResolvedValue({ data: { url: "https://example.test/saved" } });
  deps.put.mockResolvedValue({ data: { url: "https://example.test/normalized" } });
});
async function open() {
  const wrapper = mount(Modal, { props: { isOpen: false } });
  expect(deps.get).not.toHaveBeenCalled();
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  return wrapper;
}
const save = async (wrapper: Awaited<ReturnType<typeof open>>) => {
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "保存")!
    .trigger("click");
  await flushPromises();
};
const failure = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, data },
});

describe("external site settings", () => {
  it("loads on opening, blocks editing during loading, and reloads on reopening", async () => {
    let resolve!: (value: any) => void;
    deps.get.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = mount(Modal, { props: { isOpen: false } });
    await wrapper.setProps({ isOpen: true });
    expect(wrapper.get<HTMLInputElement>("input").element.disabled).toBe(true);
    expect(
      wrapper
        .findAll("button")
        .find((b) => b.text() === "保存")!
        .attributes("disabled"),
    ).toBeDefined();
    resolve({ data: { url: "https://example.test/" } });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("https://example.test/");
    expect(wrapper.get<HTMLInputElement>("input").element.disabled).toBe(false);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    expect(deps.get).toHaveBeenCalledTimes(2);
    expect(deps.get).toHaveBeenLastCalledWith(externalSiteUrl);
  });
  it("requires a URL and does not report an unsent change as saved", async () => {
    const wrapper = await open();
    await wrapper.get("input").setValue("   ");
    await save(wrapper);
    expect(deps.put).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")).toContainEqual(["URLを入力してください。"]);
    expect(wrapper.emitted("saved")).toBeUndefined();
  });
  it("sends the edited value, uses the canonical server response, and closes after saving", async () => {
    const wrapper = await open();
    await wrapper.get("input").setValue("https://example.test/new");
    await save(wrapper);
    expect(deps.put).toHaveBeenCalledWith(externalSiteUrl, { url: "https://example.test/new" });
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
      "https://example.test/normalized",
    );
    expect(wrapper.emitted("saved")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(wrapper.emitted("message")).toContainEqual(["外部サイトURLを更新しました。"]);
  });
  it.each([
    ["http or https scheme required", "http:// または https:// で始まるURLを入力してください。"],
    [{ error: "validation error: invalid url" }, "URLの形式が正しくありません。"],
    [{ error: "validation error: over length" }, "URLの長さが正しくありません。"],
    [{ error: "validation error: no input" }, "URLを入力してください。"],
  ])("explains a rejected URL without losing the pending edit (%j)", async (data, message) => {
    deps.put.mockRejectedValueOnce(failure(400, data));
    const wrapper = await open();
    await wrapper.get("input").setValue("ftp://example.test/pending");
    await save(wrapper);
    expect(wrapper.emitted("message")).toContainEqual([message]);
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("ftp://example.test/pending");
    expect(wrapper.emitted("saved")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
  });
  it.each(["load", "save"])("requests login on an expired session during %s", async (phase) => {
    if (phase === "load") deps.get.mockRejectedValueOnce(failure(401, {}));
    else deps.put.mockRejectedValueOnce(failure(401, {}));
    const wrapper = await open();
    if (phase === "save") await save(wrapper);
    expect(wrapper.emitted("loginRedirect")).toHaveLength(1);
    expect(wrapper.emitted("saved")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
  });
  it("reports load failures and restores editing controls", async () => {
    deps.get.mockRejectedValueOnce(new Error("offline"));
    const wrapper = await open();
    expect(wrapper.emitted("message")).toContainEqual(["外部サイトURLの取得に失敗しました。"]);
    expect(wrapper.get<HTMLInputElement>("input").element.disabled).toBe(false);
  });
  it("reports save failures without closing, and closes only on user cancellation", async () => {
    deps.put.mockRejectedValueOnce(failure(500, {}));
    const wrapper = await open();
    await save(wrapper);
    expect(wrapper.emitted("message")).toContainEqual(["外部サイトURLの更新に失敗しました。"]);
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
