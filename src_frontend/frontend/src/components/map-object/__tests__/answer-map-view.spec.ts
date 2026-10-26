import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnswerMapModal from "../AnswerMapModal.vue";

vi.mock("@/axiosClient", () => ({
  default: { post: vi.fn(), get: vi.fn(), isAxiosError: () => false },
}));
const action = "http://localhost:3000/form-answers/map";
const query = { mode: "history", conditions: [] };
const view = { latitude: 34.6937, longitude: 135.5023, zoom: 14 };
let iframe: HTMLIFrameElement;
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  document.body.innerHTML = '<iframe id="map-iframe" src="http://localhost:3000/map"></iframe>';
  iframe = document.getElementById("map-iframe") as HTMLIFrameElement;
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("回答地図へ現在位置を引き継ぐ", () => {
  it("現在のトップ位置を検索条件と分けて送信する", async () => {
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((data) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://localhost:3000",
          source: iframe.contentWindow,
          data: { type: "mapViewResult", requestId: data.requestId, view },
        }),
      );
    });
    wrapper = mount(AnswerMapModal, {
      attachTo: document.body,
      props: { isOpen: true, action, query },
    });
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledOnce();
    const sent = (name: string) =>
      (wrapper!.get(`input[name="${name}"]`).element as HTMLInputElement).value;
    expect(JSON.parse(sent("initial_view"))).toEqual(view);
    expect(JSON.parse(sent("query"))).toEqual(query);
  });

  it("位置取得中に閉じた場合、遅い応答から地図を開かない", async () => {
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    wrapper = mount(AnswerMapModal, {
      attachTo: document.body,
      props: { isOpen: true, action, query },
    });
    await wrapper.setProps({ isOpen: false });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:3000",
        source: iframe.contentWindow,
        data: { type: "mapViewResult", requestId: post.mock.calls[0]![0].requestId, view },
      }),
    );
    await flushPromises();
    expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
  });
});
