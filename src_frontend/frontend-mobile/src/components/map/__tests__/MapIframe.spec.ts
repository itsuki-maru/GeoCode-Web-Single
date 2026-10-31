import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import MapIframe from "@/components/map/MapIframe.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MapIframe", () => {
  it("waits for a selected-layer URL before creating the frame and reports when it loads", async () => {
    const wrapper = mount(MapIframe, {
      props: { srcUrl: "", allowedOrigins: window.location.origin },
    });
    expect(wrapper.find("iframe").exists()).toBe(false);
    const srcUrl = "/map?layer=selected&is_master=false";
    await wrapper.setProps({ srcUrl });
    await wrapper.get("iframe").trigger("load");
    expect(wrapper.emitted("mapLoaded")).toEqual([[srcUrl]]);
    wrapper.unmount();
  });
  it("iframeに位置情報の利用を許可する", () => {
    const wrapper = mount(MapIframe, {
      props: {
        srcUrl: "/map?layer=master&is_master=true",
        allowedOrigins: window.location.origin,
      },
    });

    expect(wrapper.get("iframe").attributes("allow")).toBe("geolocation");
    wrapper.unmount();
  });

  it("図形フォーカス要求に種別と図形IDを含める", () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl: "/map?layer=master&is_master=true",
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

  it("Piniaなしで制限設定を受け取り、読み込み・変更・再読み込み時に地図へ通知する", async () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: {
        srcUrl: "/map?layer=selected&is_master=false",
        allowedOrigins: window.location.origin,
        inputPolicies: { selected: true, other: false },
      },
    });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await wrapper.get("iframe").trigger("load");
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: "layerInputPolicies", policies: { selected: true, other: false } },
      window.location.origin,
    );
    await wrapper.setProps({ inputPolicies: { selected: false, other: true } });
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: "layerInputPolicies", policies: { selected: false, other: true } },
      window.location.origin,
    );
    postMessage.mockClear();
    await wrapper.get("iframe").trigger("load");
    expect(postMessage).toHaveBeenCalledWith(
      { type: "layerInputPolicies", policies: { selected: false, other: true } },
      window.location.origin,
    );
    wrapper.unmount();
  });

  it("制限設定を省略した既存の呼び出しでは設定を送信しない", async () => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: { srcUrl: "/map", allowedOrigins: window.location.origin },
    });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await wrapper.get("iframe").trigger("load");
    expect(postMessage).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("地図フレーム通信の失敗と再送", () => {
  const open = (suffix = "") => {
    const wrapper = mount(MapIframe, {
      attachTo: document.body,
      props: { srcUrl: "/map" + suffix, allowedOrigins: window.location.origin, height: 80 },
    });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data,
        }),
      );
    return { wrapper, frame, post, send };
  };
  it.each(["error", "clone"])("メッセージ転送の%s失敗は待機を残さずfalseを返す", async (kind) => {
    const { wrapper, post } = open();
    post.mockImplementation(() => {
      throw kind === "clone"
        ? new DOMException("cannot clone", "DataCloneError")
        : new Error("closed");
    });
    expect(await wrapper.vm.updateMapObject({ id: "m", objectType: "marker" } as any)).toBe(false);
    expect(post).toHaveBeenCalledTimes(kind === "clone" ? 2 : 1);
    wrapper.unmount();
  });
  it("応答期限切れとフレーム切替で保存待機を解除する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { wrapper } = open();
    try {
      const first = wrapper.vm.updateMapObject({ id: "m", objectType: "marker" } as any);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await first).toBe(false);
      const second = wrapper.vm.deleteMapObject("m", "marker");
      await wrapper.setProps({ srcUrl: "/map?layer=next" });
      expect(await second).toBe(false);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });
  it.each(["42", "0"])("読込後にフィルターと初期フォーカスを再送する: marker_id=%s", async (id) => {
    const { wrapper, post } = open(`?marker_id=${id}&latitude=35&longitude=139`);
    wrapper.vm.filterMapObjects(["m"], ["s"]);
    await wrapper.get("iframe").trigger("load");
    expect(post).toHaveBeenCalledWith(
      { type: "mapObjectFilter", markerIds: ["m"], shapeIds: ["s"] },
      window.location.origin,
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "focus",
        objectType: id === "0" ? "shape" : "marker",
        id: id === "0" ? "" : id,
        lat: 35,
        lng: 139,
      }),
      window.location.origin,
    );
    wrapper.unmount();
  });
  it("アップサートとタイル更新は応答で完了し、プレビュー・再読込・位置エラーを通知する", async () => {
    const { wrapper, post, send } = open();
    const updates = [
      wrapper.vm.upsertMapObject("marker", { id: "m" } as any),
      wrapper.vm.updateTileOverlays([{ id: "rain" }]),
    ];
    for (const [message] of post.mock.calls) {
      send({
        type:
          message.type === "tileOverlaysUpdate"
            ? "tileOverlaysUpdateResult"
            : "mapObjectUpdateResult",
        requestId: message.requestId,
        success: true,
      });
    }
    expect(await Promise.all(updates)).toEqual([true, true]);
    send({ type: "callParentImagePreview", message: "photo.png" });
    send({ type: "callParentReload", layerId: "next" });
    send({ type: "callParentLoginRedirect" });
    send({ type: "userLocationError", code: "2" });
    expect(wrapper.emitted("previewImage")).toEqual([["photo.png"]]);
    expect(wrapper.emitted("mapReloadRequested")).toEqual([["next"]]);
    expect(wrapper.emitted("loginRedirect")).toEqual([[]]);
    expect(wrapper.emitted("userLocationError")).toEqual([[2]]);
    wrapper.unmount();
  });
});
