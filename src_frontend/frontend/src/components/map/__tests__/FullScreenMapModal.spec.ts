import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FullScreenMapModal from "../FullScreenMapModal.vue";
import { shareSnapshotFixture } from "../../share/__tests__/share-snapshot-fixture";

vi.mock("@/router/urls", () => ({ mapAnatherLayerUrl: "http://localhost:3000/map-another" }));
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.replaceChildren();
});
const send = (source: Window | null, origin: string, snapshot: unknown) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      source,
      origin,
      data: { type: "shareMapSnapshot", snapshot },
    }),
  );

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
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
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
