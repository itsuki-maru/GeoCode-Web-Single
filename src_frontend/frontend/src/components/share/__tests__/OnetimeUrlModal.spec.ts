import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OnetimeUrlModal from "../OnetimeUrlModal.vue";
import { invalidateOntimeMapUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
const writeText = vi.fn();
enableAutoUnmount(afterEach);
beforeEach(() => {
  api.delete.mockResolvedValue({});
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, clipboard: { writeText } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

function open(props = {}) {
  return mount(OnetimeUrlModal, {
    attachTo: document.body,
    props: {
      isOpen: true,
      url: "https://example.test/share/abc",
      uuid: "share-abc",
      isHttps: true,
      ...props,
    },
  });
}
function stop(wrapper: ReturnType<typeof open>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text() === "共有停止")!
    .trigger("click");
}

describe("共有URLの表示と停止", () => {
  it("HTTPSでは正確なURLをコピーし、完了を通知する", async () => {
    const wrapper = open();
    await wrapper.get("#link-copy-btn").trigger("click");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://example.test/share/abc");
    expect(wrapper.emitted("message")).toEqual([["クリップボードにコピーしました。"]]);
  });

  it("HTTPではテキストを選択し、クリップボードへ送らない", async () => {
    const wrapper = open({ isHttps: false });
    await wrapper.findAll("code").at(-1)!.trigger("click");
    expect(window.getSelection()?.toString().trim()).toBe("https://example.test/share/abc");
    expect(writeText).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")).toBeUndefined();
  });

  it("テキストが空ならコピーしない", async () => {
    const wrapper = open({ url: "" });
    await wrapper.get("#link-copy-btn").trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("コピー対象がDOMからなくなっても例外を起こさない", async () => {
    const wrapper = open();
    vi.spyOn(document, "getElementById").mockReturnValue(null);
    await wrapper.get("#link-copy-btn").trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("選択範囲を取得できない環境でも例外を起こさない", async () => {
    const wrapper = open({ isHttps: false });
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    await wrapper.findAll("code").at(-1)!.trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("有効期限がなければ期限欄を表示しない", () => {
    expect(open().find(".expiration-text").exists()).toBe(false);
  });

  it.each(["2025-12-31 23:59:59", "2025-12-31T23:59:59"])(
    "DBの日時をUTCとして解釈する: %s",
    (expiration) => {
      const format = vi.fn(() => "期限の表示");
      const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
        return { format } as unknown as Intl.DateTimeFormat;
      });
      const wrapper = open({ expiration });
      expect(formatter).toHaveBeenCalledWith(
        "ja-JP",
        expect.objectContaining({ year: "numeric", second: "2-digit" }),
      );
      expect((format.mock.calls[0] as unknown as [Date])[0].toISOString()).toBe(
        "2025-12-31T23:59:59.000Z",
      );
      expect(wrapper.get(".expiration-text").text()).toBe("有効期限: 期限の表示");
    },
  );

  it("解釈できない期限は元の値を表示する", () => {
    expect(open({ expiration: "invalid-date" }).get(".expiration-text").text()).toBe(
      "有効期限: invalid-date",
    );
  });

  it("停止APIの完了を待ってから無効化を通知する", async () => {
    let resolve!: (value: object) => void;
    api.delete.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = open();
    await stop(wrapper);
    expect(api.delete).toHaveBeenCalledExactlyOnceWith(`${invalidateOntimeMapUrl}share-abc`);
    expect(wrapper.emitted("invalidated")).toBeUndefined();
    resolve({});
    await flushPromises();
    expect(wrapper.emitted("invalidated")).toEqual([[]]);
    expect(wrapper.emitted("message")).toEqual([["共有を停止しました。"]]);
  });

  it.each([401, 500])("停止失敗では成功通知を出さず、再操作を受け付ける: %s", async (status) => {
    api.delete.mockRejectedValueOnce({ response: { status } });
    const wrapper = open();
    await stop(wrapper);
    await flushPromises();
    expect(wrapper.emitted("invalidated")).toBeUndefined();
    expect(wrapper.emitted("message")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    await stop(wrapper);
    await flushPromises();
    expect(wrapper.emitted("invalidated")).toEqual([[]]);
  });

  it("閉じる操作では共有停止APIを呼ばない", async () => {
    const wrapper = open();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "閉じる")!
      .trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    expect(api.delete).not.toHaveBeenCalled();
  });
});
