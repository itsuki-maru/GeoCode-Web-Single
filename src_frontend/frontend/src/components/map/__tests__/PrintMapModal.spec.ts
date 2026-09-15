import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrintMapModal from "../PrintMapModal.vue";

vi.mock("@/router/urls", () => ({ mapAnatherLayerUrl: "http://localhost:3000/map-another" }));
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  document.body.innerHTML = '<iframe id="map-iframe" src="http://localhost:3000/map"></iframe>';
});
afterEach(() => {
  wrapper?.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});
describe("印刷モーダルの地図連携", () => {
  it("ヘッダーからの印刷キーは準備完了後だけ転送し、長押しを抑止する", () => {
    wrapper = mount(PrintMapModal, { props: { layerIds: null }, attachTo: document.body });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const press = (extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "p",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      wrapper!.get(".print-header button").element.dispatchEvent(event);
      return event;
    };
    expect(press().defaultPrevented).toBe(true);
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:3000",
        source: frame.contentWindow,
        data: { type: "printInitialized" },
      }),
    );
    expect(press({ repeat: true }).defaultPrevented).toBe(true);
    expect(post).not.toHaveBeenCalled();
    press();
    press({ ctrlKey: false, metaKey: true });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith({ type: "printExecute" }, "http://localhost:3000");
    expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
    wrapper.unmount();
    wrapper = undefined;
    const after = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it("要求先の地図からの応答だけを採用し、プレビューの準備完了後に状態を送る", async () => {
    const source = document.querySelector("iframe")!;
    const sourcePost = vi.spyOn(source.contentWindow!, "postMessage");
    wrapper = mount(PrintMapModal, { props: { layerIds: ["a"] }, attachTo: document.body });
    const request = sourcePost.mock.calls[0]![0];
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const send = (
      source: Window | null,
      type: string,
      extra = {},
      origin = "http://localhost:3000",
    ) => {
      window.dispatchEvent(
        new MessageEvent("message", { origin, source, data: { type, ...extra } }),
      );
    };
    send(frame.contentWindow, "printReady");
    send(window, "printStateResult", { requestId: request.requestId, state: {} });
    send(
      source.contentWindow,
      "printStateResult",
      { requestId: request.requestId, state: {} },
      "https://invalid.test",
    );
    expect(post).not.toHaveBeenCalled();
    send(source.contentWindow, "printStateResult", {
      requestId: request.requestId,
      state: { tileServerId: "2" },
    });
    expect(post).toHaveBeenCalledWith(
      { type: "printInitialize", state: { tileServerId: "2", layerIds: ["a"] } },
      "http://localhost:3000",
    );
    send(frame.contentWindow, "printInitialized");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".print-loading").exists()).toBe(false);
    send(frame.contentWindow, "printClose");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
  it("読み込みが停止した場合に再試行できる", async () => {
    wrapper = mount(PrintMapModal, { props: { layerIds: null }, attachTo: document.body });
    await vi.advanceTimersByTimeAsync(15000);
    expect(wrapper.text()).toContain("読み込めませんでした");
    const source = document.querySelector<HTMLIFrameElement>("#map-iframe")!;
    const post = vi.spyOn(source.contentWindow!, "postMessage");
    await wrapper.get(".print-loading button").trigger("click");
    expect(post).toHaveBeenCalled();
    expect(wrapper.text()).toContain("準備しています");
  });
});
