import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCurrentMapView } from "../map-view";

const view = { latitude: 34.6937, longitude: 135.5023, zoom: 14 };
let iframe: HTMLIFrameElement;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<iframe id="map-iframe" src="http://localhost:3000/map"></iframe>';
  iframe = document.getElementById("map-iframe") as HTMLIFrameElement;
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("現在のトップ地図の表示位置", () => {
  it("保存位置を使わず、対象iframeから中心とズームを取得する", async () => {
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const remove = vi.spyOn(window, "removeEventListener");
    const result = requestCurrentMapView();
    const request = post.mock.calls[0]![0];
    expect(post).toHaveBeenCalledWith(
      { type: "mapViewRequest", requestId: expect.any(String) },
      "http://localhost:3000",
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "http://localhost:3000",
        data: { type: "mapViewResult", requestId: request.requestId, view },
      }),
    );
    expect(await result).toEqual(view);
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("別ウィンドウ・別オリジン・別要求の応答を採用しない", async () => {
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const result = requestCurrentMapView();
    const request = post.mock.calls[0]![0];
    const resolved = vi.fn();
    void result.then(resolved);
    for (const override of [
      { source: window },
      { origin: "https://other.example" },
      { data: { type: "mapViewResult", requestId: "other", view } },
    ]) {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "http://localhost:3000",
          data: { type: "mapViewResult", requestId: request.requestId, view },
          ...override,
        }),
      );
    }
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeNull();
  });

  it.each([
    { ...view, latitude: 91 },
    { ...view, longitude: NaN },
    { ...view, zoom: 31 },
    { ...view, zoom: "14" },
  ])("範囲外または不正な表示位置を使わない: %j", async (invalid) => {
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const result = requestCurrentMapView();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "http://localhost:3000",
        data: {
          type: "mapViewResult",
          requestId: post.mock.calls[0]![0].requestId,
          view: invalid,
        },
      }),
    );
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("地図がない場合はすぐに返し、中止時も待機とリスナーを破棄する", async () => {
    document.body.innerHTML = "";
    expect(await requestCurrentMapView()).toBeNull();
    document.body.append(iframe);
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    const controller = new AbortController();
    const remove = vi.spyOn(window, "removeEventListener");
    const result = requestCurrentMapView(controller.signal);
    controller.abort();
    expect(await result).toBeNull();
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
