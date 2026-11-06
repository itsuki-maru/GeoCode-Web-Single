import { afterEach, describe, expect, it, vi } from "vitest";
import { installReadOnlyFullscreenClose } from "../src/map/common/read-only-fullscreen-close";

const connect = { type: "readOnlyFullscreenCloseConnect", sessionId: 1 };
const request = { type: "readOnlyFullscreenCloseRequest", sessionId: 1, requestId: 2 };
const state = (modalOpen: boolean, sessionId = 1) => ({
  type: "readOnlyFullscreenCloseState",
  sessionId,
  modalOpen,
});
const result = (modalOpen: boolean) => ({
  type: "readOnlyFullscreenCloseResult",
  sessionId: 1,
  requestId: 2,
  modalOpen,
});

let dispose: ReturnType<typeof installReadOnlyFullscreenClose>;
const setup = (referrer = "", trustedOrigins: string[] = []) => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const parent = frame.contentWindow!;
  const origin = referrer ? new URL(referrer).origin : location.origin;
  vi.stubGlobal("parent", parent);
  vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
  const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  dispose = installReadOnlyFullscreenClose(trustedOrigins);
  const send = (data: unknown, source: Window = parent, sender = origin) =>
    window.dispatchEvent(new MessageEvent("message", { data, source, origin: sender }));
  return { origin, parent, post, send };
};

const openDialog = () => {
  const dialog = document.body.appendChild(document.createElement("dialog"));
  dialog.open = true;
  return dialog;
};

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("全画面地図iframeの終了確認", () => {
  it("単独で開いた地図や許可外の親画面と通信しない", () => {
    expect(installReadOnlyFullscreenClose([])).toBeUndefined();
    const { post, send } = setup("https://untrusted.test/fullscreen");
    expect(dispose).toBeUndefined();
    send(connect);
    send(request);
    expect(post).not.toHaveBeenCalled();
  });

  it("許可した開発用オリジンと現在の親からの正しい要求だけに応答する", () => {
    const { origin, parent, post, send } = setup("http://localhost:5173/map", [
      "http://localhost:5173",
    ]);
    send(request);
    send(connect, window);
    send(connect, parent, "https://untrusted.test");
    send({ ...connect, sessionId: "1" });
    send({ ...connect, sessionId: 0 });
    expect(post).not.toHaveBeenCalled();

    send(connect);
    expect(post).toHaveBeenCalledExactlyOnceWith(state(false), origin);
    send({ ...request, sessionId: 3 });
    send({ ...request, requestId: Number.MAX_SAFE_INTEGER + 1 });
    send(request, parent, "https://untrusted.test");
    expect(post).toHaveBeenCalledTimes(1);
    send(request);
    expect(post).toHaveBeenLastCalledWith(result(false), origin);

    send({ ...connect, sessionId: 3 });
    expect(post).toHaveBeenLastCalledWith(state(false, 3), origin);
    send(request);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("重なったダイアログの最後が閉じるまで終了を保留する", async () => {
    const { origin, post, send } = setup();
    send(connect);
    const analysis = openDialog();
    await Promise.resolve();
    expect(post.mock.calls).toEqual([
      [state(false), origin],
      [state(true), origin],
    ]);

    const notice = openDialog();
    await Promise.resolve();
    analysis.open = false;
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2);

    notice.remove();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenLastCalledWith(state(false), origin);

    analysis.open = true;
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(state(true), origin);
    analysis.open = false;
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(state(false), origin);
  });

  it("開閉通知を待たずに終了要求を受けた時点のダイアログを確認する", async () => {
    const { origin, post, send } = setup();
    send(connect);
    const print = openDialog();
    send(request);
    expect(post).toHaveBeenNthCalledWith(2, result(true), origin);

    print.open = false;
    await Promise.resolve();
    send(request);
    expect(post).toHaveBeenLastCalledWith(result(false), origin);
  });

  it("ページの破棄時に通知と監視を終了する", async () => {
    const { post, send } = setup();
    send(connect);
    window.dispatchEvent(new Event("pagehide"));
    openDialog();
    send(connect);
    send(request);
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
