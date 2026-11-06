import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { preview, validate } = vi.hoisted(() => ({ preview: vi.fn(), validate: vi.fn() }));
vi.mock("../src/map/print/print-preview", () => ({
  createReadOnlySnapshotPrintPreview: preview,
}));
vi.mock("../src/map/print/read-only-print-snapshot", () => ({
  isReadOnlyPrintSnapshot: validate,
}));

const session = { parentOrigin: location.origin, requestId: "print-session" };
const snapshot = { state: { view: { zoom: 12 } }, bootstrap: { markers: { m: { id: "m" } } } };
const embed = () => {
  const parent = document.body.appendChild(document.createElement("iframe")).contentWindow!;
  const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  vi.stubGlobal("parent", parent);
  const send = (
    data: Record<string, unknown> = {},
    origin = location.origin,
    source: Window = parent,
  ) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { type: "printInitialize", requestId: session.requestId, snapshot, ...data },
      }),
    );
  return { post, send };
};
beforeEach(() => {
  vi.resetModules();
  preview.mockReset();
  validate.mockReset().mockImplementation((value) => value === snapshot);
  vi.stubGlobal("name", session.requestId);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("正しい親・オリジン・セッションからのデータで一度だけ印刷画面を作成する", async () => {
  const { post, send } = embed();
  await import("../src/entries/read-only-map-print");
  expect(post).toHaveBeenLastCalledWith(
    { type: "printReady", requestId: session.requestId },
    session.parentOrigin,
  );
  send({}, "https://invalid.test");
  send({}, location.origin, window);
  send({ requestId: "print-old" });
  expect(validate).not.toHaveBeenCalled();
  expect(preview).not.toHaveBeenCalled();
  send();
  send();
  expect(validate).toHaveBeenCalledExactlyOnceWith(snapshot);
  expect(preview).toHaveBeenCalledExactlyOnceWith(snapshot, expect.any(Function), session);
  expect(post).toHaveBeenLastCalledWith(
    { type: "printInitialized", requestId: session.requestId },
    session.parentOrigin,
  );
  preview.mock.calls[0]![1]();
  expect(post).toHaveBeenLastCalledWith(
    { type: "printClose", requestId: session.requestId },
    session.parentOrigin,
  );
});

it("不正なデータを相関済みエラーで返し、同じセッションの再初期化を拒む", async () => {
  const { post, send } = embed();
  await import("../src/entries/read-only-map-print");
  send({ snapshot: {} });
  send();
  expect(post).toHaveBeenLastCalledWith(
    { type: "printError", requestId: session.requestId },
    session.parentOrigin,
  );
  expect(validate).toHaveBeenCalledOnce();
  expect(preview).not.toHaveBeenCalled();
});

it("ページを離れた後は未初期化のセッションを破棄する", async () => {
  const { send } = embed();
  await import("../src/entries/read-only-map-print");
  window.dispatchEvent(new Event("pagehide"));
  send();
  expect(validate).not.toHaveBeenCalled();
  expect(preview).not.toHaveBeenCalled();
});

it("単独で開いた場合は待受を開始しない", async () => {
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  await import("../src/entries/read-only-map-print");
  expect(post).not.toHaveBeenCalled();
});
