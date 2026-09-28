import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraViewer } from "../src/live-map/camera";

class Peer {
  connectionState = "new";
  configuration: RTCConfiguration;
  static instances: Peer[] = [];
  close = vi.fn();
  onicecandidate: any;
  ontrack: any;
  onconnectionstatechange: any;
  remoteDescription: unknown = null;
  setRemoteDescription = vi.fn(async (d) => {
    this.remoteDescription = d;
  });
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" }));
  setLocalDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    Peer.instances.push(this);
  }
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let viewer: CameraViewer;
beforeEach(() => {
  vi.useFakeTimers();
  // jsdom はダイアログの表示 API を実装していないため、開閉状態を模擬する。
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function(this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  Peer.instances = [];
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  viewer = new CameraViewer("map", "member");
});
afterEach(() => {
  viewer.close();
  viewer.element.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("camera popup lifecycle", () => {
  it("expands when a previously unshared camera appears and shrinks on stop", async () => {
    let sharing = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) =>
      options.method === "DELETE" ? response({}) : url.endsWith("/viewers")
        ? sharing ? response({ ice_servers: [] }) : response({}, 404)
        : response({ messages: [] })));
    const layout: boolean[] = [];
    viewer.element.addEventListener("camera-layoutchange", () => {
      layout.push(viewer.element.classList.contains("has-video"));
    });
    viewer.open();
    await flush();
    expect(viewer.element.classList.contains("has-video")).toBe(false);
    sharing = true;
    await vi.advanceTimersByTimeAsync(5000);
    Peer.instances[0].ontrack({ track: {} });
    // 自動再生や最初のフレームを待たずに、映像領域に必要な幅を確保する。
    expect(layout).toEqual([true]);
    viewer.close();
    expect(layout).toEqual([true, false]);
  });
  async function receiveVideo() {
    document.body.append(viewer.element);
    const fetcher = vi.fn(async (url: string, options: RequestInit) =>
      options.method === "DELETE" ? response({}) : url.endsWith("/viewers")
        ? response({ ice_servers: [] }) : response({ messages: [] }));
    vi.stubGlobal("fetch", fetcher);
    viewer.open();
    await flush();
    const expand = [...viewer.element.querySelectorAll("button")].find(b => b.textContent === "全画面で表示")!;
    expect(expand.hidden).toBe(true);
    const peer = Peer.instances[0];
    peer.connectionState = "connected";
    peer.ontrack({ track: {} });
    expect(expand.hidden).toBe(true);
    const video = viewer.element.querySelector("video")!;
    Object.defineProperty(video, "readyState", { value: 2 });
    Object.defineProperty(video, "videoWidth", { value: 640 });
    video.dispatchEvent(new Event("playing"));
    expect(expand.hidden).toBe(false);
    return { fetcher, expand, video, peer };
  }

  it.each(["unsupported", "rejected"])("preserves the stream in the %s fullscreen fallback", async (mode) => {
    const { expand, video, peer, fetcher } = await receiveVideo();
    const stream = video.srcObject;
    if (mode === "rejected") Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true, value: vi.fn().mockRejectedValue(new Error("denied")),
    });
    try {
      expand.click();
      await flush();
      const dialog = document.querySelector("dialog")!;
      expect(dialog.open).toBe(true);
      expect(dialog.querySelector("video")).toBe(video);
      expect(video.srcObject).toBe(stream);
      await vi.advanceTimersByTimeAsync(25000);
      expect(peer.close).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/viewers"))).toHaveLength(1);
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      expect(document.querySelector("dialog")).toBeNull();
      expect(viewer.element.querySelector("video")).toBe(video);
      expect(document.activeElement).toBe(expand);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });

  it.each(["normal", "late"])("cleans up %s native fullscreen completion", async (mode) => {
    let fullscreen: Element | null = null;
    let complete!: () => void;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    const exit = vi.fn(async () => { fullscreen = null; });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true, value: function(this: HTMLElement) {
        return new Promise<void>(resolve => { complete = () => {
          fullscreen = this;
          document.dispatchEvent(new Event("fullscreenchange"));
          resolve();
        }; });
      },
    });
    try {
      const { expand, peer } = await receiveVideo();
      expand.click();
      if (mode === "late") viewer.close();
      complete();
      await flush();
      if (mode === "normal") {
        fullscreen = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(peer.close).not.toHaveBeenCalled();
      } else expect(exit).toHaveBeenCalledTimes(1);
      expect(document.querySelector("dialog")).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      Reflect.deleteProperty(document, "fullscreenElement");
      Reflect.deleteProperty(document, "exitFullscreen");
    }
  });

  it.each(["close", "background", "disconnect"])("removes expanded video on %s", async (reason) => {
    const { expand, video, peer } = await receiveVideo();
    expand.click();
    if (reason === "close") viewer.close();
    else if (reason === "background") {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    } else {
      peer.connectionState = "disconnected";
      peer.onconnectionstatechange();
    }
    expect(document.querySelector("dialog")).toBeNull();
    expect(video.srcObject).toBeNull();
    expect(expand.hidden).toBe(true);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "disconnected", "timeout"])("reports %s separately from normal departure", async (failure) => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) =>
      options.method === "DELETE" ? response({}) : url.endsWith("/viewers")
        ? response({ ice_servers: [], relay_only: false }) : response({ messages: [] }));
    vi.stubGlobal("fetch", fetcher);
    viewer.open();
    await flush();
    const peer = Peer.instances[0];
    expect(peer.configuration).toEqual({ iceServers: [], iceTransportPolicy: "all" });
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(20500);
    else { peer.connectionState = failure; peer.onconnectionstatechange(); }
    expect(peer.close).toHaveBeenCalledTimes(1);
    const leave = fetcher.mock.calls.find(([, options]) => options.method === "DELETE")!;
    expect(JSON.parse(leave[1].body as string).failed).toBe(true);
  });
  it("keeps successful P2P alive beyond the connection deadline and marks normal departure", async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) =>
      options.method === "DELETE" ? response({}) : url.endsWith("/viewers")
        ? response({ ice_servers: [] }) : response({ messages: [] }));
    vi.stubGlobal("fetch", fetcher);
    viewer.open();
    await flush();
    const peer = Peer.instances[0];
    peer.connectionState = "connected";
    peer.onconnectionstatechange();
    peer.ontrack({ track: {} });
    const video = viewer.element.querySelector("video")!;
    Object.defineProperty(video, "readyState", { value: 2 });
    Object.defineProperty(video, "videoWidth", { value: 640 });
    video.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(25000);
    expect(peer.close).not.toHaveBeenCalled();
    viewer.close();
    const leave = fetcher.mock.calls.find(([, options]) => options.method === "DELETE")!;
    expect(JSON.parse(leave[1].body as string).failed).toBe(false);
  });
  it.each(["connecting", "connected"])("does not mistake a track for received video while %s", async (state) => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) =>
      options.method === "DELETE" ? response({}) : url.endsWith("/viewers")
        ? response({ ice_servers: [] }) : response({ messages: [] }));
    vi.stubGlobal("fetch", fetcher);
    viewer.open();
    await flush();
    const peer = Peer.instances[0];
    peer.connectionState = state;
    peer.ontrack({ track: {} });
    expect(viewer.element.textContent).toContain("映像の受信を待っています");
    expect(viewer.element.textContent).not.toContain("カメラ共有中");
    await vi.advanceTimersByTimeAsync(20500);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(viewer.element.textContent).toContain(state === "connected" ? "映像を受信できません" : "映像に接続できません");
    const leave = fetcher.mock.calls.find(([, options]) => options.method === "DELETE")!;
    expect(JSON.parse(leave[1].body as string).failed).toBe(true);
  });
  it("does not create a peer after a late join response for a closed popup", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) =>
        options.method === "DELETE"
          ? Promise.resolve(response({}))
          : new Promise<Response>((r) => {
              finish = r;
            }),
      ),
    );
    viewer.open();
    viewer.close();
    finish(response({ ice_servers: [], relay_only: false }));
    await flush();
    expect(Peer.instances).toHaveLength(0);
  });
  it("answers once, releases the peer on backgrounding, and never automatically resumes", async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === "DELETE") return response({});
      if (url.endsWith("/viewers")) return response({ ice_servers: [] });
      return response({
        lease_ms: 15000,
        messages: [{ id: 1, viewer_id: "viewer", kind: "offer", data: "offer-sdp" }],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    viewer.open();
    await flush();
    expect(Peer.instances).toHaveLength(1);
    expect(Peer.instances[0].setRemoteDescription).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(Peer.instances[0].close).toHaveBeenCalledTimes(1);
    const count = fetcher.mock.calls.length;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(viewer.element.querySelector("video")?.srcObject).toBeNull();
  });
  it("closes existing media when permission is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) =>
        options.method === "DELETE"
          ? response({})
          : url.endsWith("/viewers")
            ? response({ ice_servers: [] })
            : response({}, 401),
      ),
    );
    viewer.open();
    await flush();
    expect(Peer.instances[0].close).toHaveBeenCalledTimes(1);
    expect(viewer.element.textContent).toContain("閲覧できなくなりました");
  });
  it("clears the peer after the control lease expires even if fetch hangs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) =>
        options.method === "DELETE"
          ? response({})
          : url.endsWith("/viewers")
            ? response({ ice_servers: [] })
            : new Promise<Response>(() => {}),
      ),
    );
    viewer.open();
    await flush();
    await vi.advanceTimersByTimeAsync(12500);
    expect(Peer.instances[0].close).toHaveBeenCalledTimes(1);
    expect(viewer.element.textContent).toContain("接続が途切れました");
  });
});
