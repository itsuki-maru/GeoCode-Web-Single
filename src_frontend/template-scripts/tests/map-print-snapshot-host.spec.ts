import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMapPrintPreview, READ_ONLY_MAP_PRINT_PATH } from "../src/map/common/map-print-host";

const snapshot = { state: { view: { zoom: 12 } }, bootstrap: { markers: { m: { id: "m" } } } };
let host: ReturnType<typeof openMapPrintPreview> | undefined;

const frame = () => document.querySelector<HTMLIFrameElement>(".map-print-host iframe")!;
const send = (
  target: HTMLIFrameElement,
  type: string,
  requestId = target.name,
  origin = location.origin,
) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      source: target.contentWindow,
      origin,
      data: { type, requestId },
    }),
  );
const pressPrint = (repeat = false) => {
  const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, repeat, cancelable: true });
  window.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  host?.dispose();
  host = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("全画面地図の印刷ホスト", () => {
  it("同一オリジンの現行セッションにだけ固定データと印刷操作を送る", async () => {
    const getState = vi.fn().mockResolvedValue(snapshot);
    const close = vi.fn();
    host = openMapPrintPreview({ url: READ_ONLY_MAP_PRINT_PATH, snapshot: true, getState, close });
    const current = frame();
    const other = document.body.appendChild(document.createElement("iframe"));
    const post = vi.spyOn(current.contentWindow!, "postMessage").mockImplementation(() => {});
    expect(new URL(current.src).pathname).toBe(READ_ONLY_MAP_PRINT_PATH);
    expect(new URL(current.src).search).toBe("");
    expect(current.getAttribute("referrerpolicy")).toBe("no-referrer");
    await Promise.resolve();

    send(other, "printReady", current.name);
    send(current, "printReady", "print-old");
    send(current, "printReady", current.name, "https://invalid.test");
    send(current, "printInitialized");
    expect(pressPrint().defaultPrevented).toBe(true);
    expect(post).not.toHaveBeenCalled();

    send(current, "printReady");
    send(current, "printReady");
    expect(post).toHaveBeenCalledExactlyOnceWith(
      { type: "printInitialize", requestId: current.name, snapshot },
      location.origin,
    );
    expect(post.mock.calls[0]![0].snapshot).toBe(snapshot);
    send(current, "printInitialized", "print-old");
    pressPrint();
    expect(post).toHaveBeenCalledTimes(1);
    send(current, "printInitialized");
    pressPrint(true);
    pressPrint();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      { type: "printExecute", requestId: current.name },
      location.origin,
    );
    send(current, "printClose", "print-old");
    expect(close).not.toHaveBeenCalled();
    send(current, "printClose");
    expect(close).toHaveBeenCalledOnce();
    expect(pressPrint().defaultPrevented).toBe(false);
  });

  it("失敗後は新しいセッションで同じ固定データを再送する", async () => {
    const getState = vi.fn().mockResolvedValue(snapshot);
    host = openMapPrintPreview({
      url: READ_ONLY_MAP_PRINT_PATH,
      snapshot: true,
      getState,
      close: vi.fn(),
    });
    const first = frame();
    const firstWindow = first.contentWindow!;
    send(first, "printReady");
    await Promise.resolve();
    send(first, "printError");
    expect(getState.mock.calls[0]![0].aborted).toBe(true);
    expect(first.isConnected).toBe(false);
    send(first, "printInitialized");
    document.querySelector<HTMLButtonElement>(".print-loading button")!.click();

    const second = frame();
    const post = vi.spyOn(second.contentWindow!, "postMessage").mockImplementation(() => {});
    expect(second.name).not.toBe(first.name);
    send(second, "printReady", first.name);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: firstWindow,
        origin: location.origin,
        data: { type: "printReady", requestId: second.name },
      }),
    );
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    send(second, "printReady");
    expect(post).toHaveBeenCalledExactlyOnceWith(
      { type: "printInitialize", requestId: second.name, snapshot },
      location.origin,
    );
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("別オリジンではプレビューやデータ取得を開始しない", () => {
    const getState = vi.fn().mockResolvedValue(snapshot);
    expect(() =>
      openMapPrintPreview({
        url: "https://invalid.test/assets/read-only-map-print.html",
        snapshot: true,
        getState,
        close: vi.fn(),
      }),
    ).toThrow("同じサイト");
    expect(getState).not.toHaveBeenCalled();
    expect(document.querySelector(".map-print-host")).toBeNull();
  });
});
