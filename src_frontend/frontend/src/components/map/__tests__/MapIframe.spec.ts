import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import MapIframe from "@/components/map/MapIframe.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MapIframe", () => {
  it("図形フォーカス要求に種別と図形IDを含める", () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl: "/map?layer=master&is_master=true",
        height: 80,
        allowedOrigins: window.location.origin,
      },
    });
    const iframe = wrapper.get("iframe").element as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    wrapper.vm.focusObject("shape", "shape-1", 35.685, 139.765);

    expect(postMessage).toHaveBeenCalledWith(
      {
        objectType: "shape",
        id: "shape-1",
        lat: 35.685,
        lng: 139.765,
        type: "focus",
      },
      window.location.origin,
    );

    wrapper.unmount();
  });

  it("同じ地図URLでもiframeを明示的に再読み込みできる", () => {
    const srcUrl = "/map?layer=master&is_master=true";
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl,
        height: 80,
        allowedOrigins: window.location.origin,
      },
    });
    const iframe = wrapper.get("iframe").element as HTMLIFrameElement;
    iframe.src = "about:blank";

    expect(wrapper.vm.reloadMapFrame()).toBe(true);
    expect(iframe.src).toBe(new URL(srcUrl, window.location.origin).href);

    wrapper.unmount();
  });

  it("マーカー削除要求をiframeへ送り、結果を待つ", async () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl: "/map?layer=master&is_master=true",
        height: 80,
        allowedOrigins: window.location.origin,
      },
    });
    const iframe = wrapper.get("iframe").element as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    const deletion = wrapper.vm.deleteMapObject("marker-1");
    const message = postMessage.mock.calls[0][0] as {
      id: string;
      requestId: string;
      type: string;
    };
    expect(message).toMatchObject({ id: "marker-1", type: "mapObjectDelete" });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "mapObjectDeleteResult",
          requestId: message.requestId,
          success: true,
        },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    );
    expect(await deletion).toBe(true);

    wrapper.unmount();
  });

  it("既存のマーカー更新要求もiframeの結果を待つ", async () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl: "/map?layer=master&is_master=true",
        height: 80,
        allowedOrigins: window.location.origin,
      },
    });
    const iframe = wrapper.get("iframe").element as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const update = wrapper.vm.updateMapObject({
      objectType: "marker",
      id: "marker-1",
      layerId: "layer-1",
      name: "updated",
      detail: "detail",
      latitude: 35,
      longitude: 139,
    });
    const message = postMessage.mock.calls[0][0] as { requestId: string; type: string };
    expect(message.type).toBe("mapObjectUpdate");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "mapObjectUpdateResult",
          requestId: message.requestId,
          success: true,
        },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    );
    expect(await update).toBe(true);

    wrapper.unmount();
  });
});
