import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import FullScreenMapModal from "../FullScreenMapModal.vue";
import { shareSnapshotFixture } from "../../share/__tests__/share-snapshot-fixture";

vi.mock("@/router/urls", () => ({ mapAnatherLayerUrl: "http://localhost:3000/map-another" }));
const mapOrigin = "http://localhost:3000";
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});
const sendMessage = (source: Window | null, origin: string, data: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
const send = (source: Window | null, origin: string, snapshot: unknown) =>
  sendMessage(source, origin, { type: "shareMapSnapshot", snapshot });

describe("全画面地図の共有要求", () => {
  it("表示中のiframeの同一originの正しいスナップショットだけを親へ渡す", async () => {
    wrapper = mount(FullScreenMapModal, { props: { isOpen: true }, attachTo: document.body });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const snapshot = shareSnapshotFixture();
    send(window, "http://localhost:3000", snapshot);
    send(frame.contentWindow, "https://untrusted.test", snapshot);
    send(frame.contentWindow, "http://localhost:3000", {});
    expect(wrapper.emitted("share")).toBeUndefined();
    send(frame.contentWindow, "http://localhost:3000", snapshot);
    expect(wrapper.emitted("share")).toEqual([[snapshot]]);
    expect(wrapper.get("iframe").element).toBe(frame);
  });

  it("ベクタ背景を含むv2をメタデータごと親へ渡し、v1への偽装を拒否する", () => {
    wrapper = mount(FullScreenMapModal, { props: { isOpen: true }, attachTo: document.body });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const snapshot = shareSnapshotFixture();
    snapshot.version = 2;
    snapshot.state.tileServerId = "2";
    snapshot.tileServers["2"] = {
      ...snapshot.tileServers["1"]!,
      id: 2,
      kind: "vector",
      style_url: "/assets/styles/vector.json",
    };
    send(frame.contentWindow, mapOrigin, { ...snapshot, version: 1 });
    expect(wrapper.emitted("share")).toBeUndefined();
    send(frame.contentWindow, mapOrigin, snapshot);
    expect(wrapper.emitted("share")).toEqual([[snapshot]]);
    expect((wrapper.emitted("share")![0]![0] as typeof snapshot).tileServers["2"]).toMatchObject({
      kind: "vector",
      style_url: "/assets/styles/vector.json",
    });
  });

  it("閉じた画面と再表示前のiframeから遅れて届く応答を破棄する", async () => {
    wrapper = mount(FullScreenMapModal, { props: { isOpen: true }, attachTo: document.body });
    const oldSource = (wrapper.get("iframe").element as HTMLIFrameElement).contentWindow;
    await wrapper.setProps({ isOpen: false });
    send(oldSource, "http://localhost:3000", shareSnapshotFixture());
    expect(wrapper.emitted("share")).toBeUndefined();
    await wrapper.setProps({ isOpen: true });
    send(oldSource, "http://localhost:3000", shareSnapshotFixture());
    expect(wrapper.emitted("share")).toBeUndefined();
    const source = (wrapper.get("iframe").element as HTMLIFrameElement).contentWindow;
    send(source, "http://localhost:3000", shareSnapshotFixture());
    expect(wrapper.emitted("share")).toHaveLength(1);
  });
});

describe("全画面地図の終了操作", () => {
  const setup = async () => {
    vi.useFakeTimers();
    const modal = mount(FullScreenMapModal, { props: { isOpen: true }, attachTo: document.body });
    wrapper = modal;
    const iframe = modal.get("iframe");
    const source = iframe.element.contentWindow!;
    const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
    await iframe.trigger("load");
    const { sessionId } = post.mock.lastCall![0];
    expect(post).toHaveBeenLastCalledWith(
      { type: "readOnlyFullscreenCloseConnect", sessionId },
      mapOrigin,
    );
    return { modal, iframe, source, post, sessionId, button: modal.get("button") };
  };

  it("現在の地図からの通知で終了ボタンを隠し、終了要求を止める", async () => {
    const { modal, source, post, sessionId, button } = await setup();
    const state = { type: "readOnlyFullscreenCloseState", sessionId, modalOpen: true };
    sendMessage(window, mapOrigin, state);
    sendMessage(source, "https://untrusted.test", state);
    sendMessage(source, mapOrigin, { ...state, sessionId: sessionId - 1 });
    sendMessage(source, mapOrigin, { ...state, modalOpen: "true" });
    await nextTick();
    expect(button.isVisible()).toBe(true);

    sendMessage(source, mapOrigin, state);
    await nextTick();
    expect(button.isVisible()).toBe(false);
    await button.trigger("click");
    modal.vm.requestClose();
    expect(post).toHaveBeenCalledTimes(1);
    expect(modal.emitted("close")).toBeUndefined();

    sendMessage(source, mapOrigin, { ...state, modalOpen: false });
    await nextTick();
    expect(button.isVisible()).toBe(true);
    await button.trigger("click");
    const { requestId } = post.mock.lastCall![0];
    expect(post).toHaveBeenLastCalledWith(
      { type: "readOnlyFullscreenCloseRequest", sessionId, requestId },
      mapOrigin,
    );
    const result = {
      type: "readOnlyFullscreenCloseResult",
      sessionId,
      requestId,
      modalOpen: false,
    };
    sendMessage(source, mapOrigin, { ...result, requestId: requestId + 1 });
    expect(modal.emitted("close")).toBeUndefined();
    sendMessage(source, mapOrigin, result);
    expect(modal.emitted("close")).toHaveLength(1);
    sendMessage(source, mapOrigin, result);
    expect(modal.emitted("close")).toHaveLength(1);
  });

  it("開いた直後のモーダルを終了結果で検知し、古いiframe文書の通知を捨てる", async () => {
    const { modal, iframe, source, post, sessionId, button } = await setup();
    const state = { type: "readOnlyFullscreenCloseState", sessionId, modalOpen: false };
    sendMessage(source, mapOrigin, state);
    modal.vm.requestClose();
    const { requestId } = post.mock.lastCall![0];
    const result = { type: "readOnlyFullscreenCloseResult", sessionId, requestId, modalOpen: true };
    sendMessage(source, mapOrigin, result);
    await nextTick();
    expect(button.isVisible()).toBe(false);
    expect(modal.emitted("close")).toBeUndefined();

    await iframe.trigger("load");
    expect(button.isVisible()).toBe(true);
    sendMessage(source, mapOrigin, { ...state, modalOpen: true });
    sendMessage(source, mapOrigin, { ...result, modalOpen: false });
    await nextTick();
    expect(button.isVisible()).toBe(true);
    expect(modal.emitted("close")).toBeUndefined();
  });

  it("応答のない読み込み失敗時は退出でき、準備済みの地図では応答を待つ", async () => {
    const { modal, iframe, source, sessionId, button } = await setup();
    sendMessage(source, mapOrigin, {
      type: "readOnlyFullscreenCloseState",
      sessionId,
      modalOpen: false,
    });
    await button.trigger("click");
    expect(button.attributes("disabled")).toBeDefined();
    await vi.runOnlyPendingTimersAsync();
    expect(modal.emitted("close")).toBeUndefined();
    expect(button.attributes("disabled")).toBeUndefined();

    await iframe.trigger("load");
    await button.trigger("click");
    await iframe.trigger("load");
    expect(modal.emitted("close")).toBeUndefined();
    await vi.runOnlyPendingTimersAsync();
    expect(modal.emitted("close")).toHaveLength(1);
  });

  it("親側の共有モーダルが開いた場合は保留中の終了要求も取り消す", async () => {
    const { modal, source, post, sessionId, button } = await setup();
    modal.vm.requestClose();
    const { requestId } = post.mock.lastCall![0];
    await modal.setProps({ closeBlocked: true });
    expect(button.isVisible()).toBe(false);
    sendMessage(source, mapOrigin, {
      type: "readOnlyFullscreenCloseResult",
      sessionId,
      requestId,
      modalOpen: false,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(modal.emitted("close")).toBeUndefined();
    await modal.setProps({ closeBlocked: false });
    expect(button.isVisible()).toBe(true);
  });
});

it("表示中の地図iframeだけに印刷開始を要求する", async () => {
  const modal = mount(FullScreenMapModal, { props: { isOpen: true }, attachTo: document.body });
  wrapper = modal;
  const source = (modal.get("iframe").element as HTMLIFrameElement).contentWindow!;
  const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
  modal.vm.openPrint();
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: "readOnlyPrintOpen" },
    "http://localhost:3000",
  );
  await modal.setProps({ isOpen: false });
  modal.vm.openPrint();
  expect(post).toHaveBeenCalledTimes(1);
});
