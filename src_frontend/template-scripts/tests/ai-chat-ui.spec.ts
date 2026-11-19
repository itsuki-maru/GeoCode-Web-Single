import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAiChat } from "../src/ai/chat";
import type { AiTransport } from "../src/ai/types";

const capabilities = {
  enabled: true,
  voice_enabled: false,
  revision: "r1",
  protocol_version: 2,
  write_enabled: true,
};
const definition = { type: "filter", expression: { op: "text", query1: "学校" } };
const filterResult = { type: "filter", targets: ["marker:m1"], target_count: 1, definition };
const colorDefinition = {
  type: "color",
  common_form_id: "form1",
  rules: [{ id: "red", label: "点検済み", color: "#ff0000", conditions: [] }],
};
const colorResult = {
  type: "color",
  definition: colorDefinition,
  coloring: {
    version: 1,
    rules: [{ id: "red", label: "点検済み", color: "#ff0000" }],
    targets: {},
  },
};
const flush = async () => {
  for (let i = 0; i < 30; ++i) await Promise.resolve();
};
let chat: ReturnType<typeof createAiChat>;
const dialog = () => document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!;
const reply = () =>
  dialog().querySelector<HTMLElement>('.ai-message[data-role="assistant"]:last-child')!;
const replyStatus = () => reply().querySelector<HTMLElement>(".ai-reply-status")!;
const sendButton = () => dialog().querySelector<HTMLButtonElement>(".ai-send")!;
const cancelButton = () => dialog().querySelector<HTMLButtonElement>(".ai-cancel")!;
const submit = (text = "学校を検索して") => {
  const draft = document.querySelector("textarea")!;
  draft.value = text;
  draft.dispatchEvent(new Event("input"));
  document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
};
const pointer = (type: string, x: number, y: number, id = 1, target: HTMLElement = dialog()) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } });
  target.dispatchEvent(event);
};
const outsideClick = () => {
  pointer("pointerdown", 20, 20);
  pointer("pointerup", 20, 20);
  pointer("click", 20, 20);
};
const mount = (transport: AiTransport, apply = vi.fn().mockResolvedValue(undefined)) => {
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner:map",
    apply,
  });
  vi.spyOn(dialog(), "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 100,
    right: 560,
    bottom: 760,
    width: 460,
    height: 660,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  chat.open();
  return apply;
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});
afterEach(() => {
  chat?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("follows the visible viewport when a keyboard opens or pans, and detaches on disposal", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 390,
    height: 844,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  mount(vi.fn().mockResolvedValue(capabilities));
  const element = dialog();
  expect(element.hasAttribute("data-compact")).toBe(false);
  viewport.height = 320;
  viewport.offsetTop = 120;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.getPropertyValue("--ai-viewport-height")).toBe("320px");
  expect(element.style.getPropertyValue("--ai-viewport-top")).toBe("120px");
  expect(element.hasAttribute("data-compact")).toBe(true);
  viewport.offsetLeft = 24;
  viewport.dispatchEvent(new Event("scroll"));
  expect(element.style.getPropertyValue("--ai-viewport-left")).toBe("24px");
  viewport.height = 844;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.hasAttribute("data-compact")).toBe(false);
  chat.dispose();
  viewport.height = 200;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.getPropertyValue("--ai-viewport-height")).toBe("844px");
});

it.each([
  { result: filterResult, completion: "検索条件に一致：1件" },
  { result: colorResult, completion: "色分けを地図へ反映しました。" },
])(
  "会話で $result.type の回答と地図反映を待ち、完了後に同じ返信へ結果を表示する",
  async ({ result, completion }) => {
    let answer!: (value: unknown) => void;
    let finish!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const transport = vi.fn(async (path: string) => {
      if (path === "/ai/capabilities") return capabilities;
      if (path === "/ai/chat")
        return new Promise((resolve) => {
          answer = resolve;
        });
      if (path === "/ai/assist/execute") return result;
      throw Error("unexpected path");
    });
    mount(transport, apply);
    await flush();
    submit();
    const pending = reply();
    expect(pending.previousElementSibling?.textContent).toContain("学校を検索して");
    expect(replyStatus().textContent).toBe("回答を準備中…");
    expect(replyStatus().dataset.state).toBe("waiting");
    expect(replyStatus().querySelectorAll(".ai-reply-dots[aria-hidden=true] > span")).toHaveLength(
      3,
    );
    expect(dialog().querySelector("textarea")!.value).toBe("");
    expect(cancelButton().hidden).toBe(false);
    expect(cancelButton().disabled).toBe(false);
    expect(sendButton().hidden).toBe(true);
    expect(document.querySelector(".shared-progress-spinner, .map-progress-dialog")).toBeNull();
    await flush();
    answer({
      outcome: "action",
      message: "操作を実行します",
      action: result.definition,
      revision: "r1",
    });
    await flush();
    expect(apply).toHaveBeenCalledOnce();
    expect(reply()).toBe(pending);
    expect(reply().textContent).toContain("操作を実行します");
    expect(replyStatus().textContent).toBe("地図に反映中…");
    expect(replyStatus().dataset.state).toBe("waiting");
    finish();
    await flush();
    expect(reply()).toBe(pending);
    expect(replyStatus().textContent).toContain(completion);
    expect(replyStatus().dataset.state).toBe("done");
    expect(cancelButton().hidden).toBe(true);
    expect(sendButton().hidden).toBe(false);
  },
);

it("地図への反映中に中止した場合は復元を待ち、成功の案内を表示しない", async () => {
  let finishApply!: (undo: () => Promise<void>) => void;
  let finishRestore!: () => void;
  const undo = vi.fn(() => new Promise<void>((resolve) => (finishRestore = resolve)));
  const apply = vi.fn(() => new Promise<() => Promise<void>>((resolve) => (finishApply = resolve)));
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/chat")
      return { message: "学校を抽出します", action: definition, revision: "r1" };
    if (path === "/ai/assist/execute") return filterResult;
    throw Error("unexpected path");
  });
  mount(transport, apply);
  await flush();
  submit();
  await flush();
  expect(replyStatus().textContent).toBe("地図に反映中…");
  cancelButton().click();
  expect(replyStatus().textContent).toBe("処理を中止しました。");
  finishApply(undo);
  await flush();
  expect(undo).toHaveBeenCalledOnce();
  expect(sendButton().hidden).toBe(true);
  expect(dialog().querySelector("textarea")!.disabled).toBe(true);
  finishRestore();
  await flush();
  expect(replyStatus().textContent).toBe("処理を中止しました。");
  expect(sendButton().hidden).toBe(false);
  expect(dialog().querySelector("textarea")!.disabled).toBe(false);
});

it("反映に失敗した理由を対応する返信に表示する", async () => {
  const apply = vi.fn().mockRejectedValue(Error("地図への反映を確認できませんでした。"));
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/chat")
      return { message: "学校を抽出します", action: definition, revision: "r1" };
    if (path === "/ai/assist/execute") return filterResult;
    throw Error("unexpected path");
  });
  mount(transport, apply);
  await flush();
  submit();
  await flush();
  expect(replyStatus().textContent).toBe("地図への反映を確認できませんでした。");
  expect(replyStatus().dataset.state).toBe("error");
  expect(cancelButton().hidden).toBe(true);
});

it("応答を待ち切れなかった指示を入力欄に戻し、再送の履歴へ混ぜない", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/suggestions")
      return { revision: "r1", as_of: "2026-11-18T00:00:00Z", suggestions: [] };
    if (path === "/ai/chat" && !finish) {
      signal = currentSignal;
      return new Promise((resolve) => (finish = resolve));
    }
    return { message: "検索方法を説明します", revision: "r1" };
  });
  mount(transport);
  await flush();
  submit();
  await flush();
  await vi.advanceTimersByTimeAsync(240000);
  expect(signal.aborted).toBe(true);
  expect(replyStatus().dataset.state).toBe("error");
  expect(replyStatus().textContent).toContain("時間がかかりすぎました");
  expect(dialog().querySelector("textarea")!.value).toBe("学校を検索して");
  expect(sendButton().disabled).toBe(false);
  submit();
  await flush();
  finish({ message: "遅延した回答", revision: "r1" });
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/chat")[1]![1]).toMatchObject({
    message: "学校を検索して",
    history: [],
  });
  expect(reply().textContent).toContain("検索方法を説明します");
  expect(replyStatus().hidden).toBe(true);
  expect(dialog().textContent).not.toContain("遅延した回答");
});

it("requires both press and release outside, ignores cancelled pointers, and consumes the closing click", async () => {
  mount(vi.fn().mockResolvedValue(capabilities));
  await flush();
  pointer("pointerdown", 120, 120);
  pointer("pointerup", 20, 20);
  pointer("click", 20, 20);
  expect(dialog().open).toBe(true);
  pointer("pointerdown", 120, 120);
  pointer("pointerup", 120, 120);
  pointer("click", 120, 120);
  expect(dialog().open).toBe(true);
  pointer("pointerdown", 20, 20);
  pointer("pointercancel", 20, 20);
  pointer("pointerup", 20, 20);
  pointer("click", 20, 20);
  expect(dialog().open).toBe(true);
  const underlying = vi.fn();
  document.addEventListener("click", underlying);
  outsideClick();
  document.removeEventListener("click", underlying);
  expect(dialog().open).toBe(false);
  expect(underlying).not.toHaveBeenCalled();
});

it("ends inline progress and aborts the request on backdrop dismissal, discarding a late model reply", async () => {
  let respond!: (value: unknown) => void;
  let signal!: AbortSignal;
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return capabilities;
    signal = currentSignal;
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  const apply = mount(transport);
  await flush();
  submit();
  await flush();
  expect(replyStatus().dataset.state).toBe("waiting");
  outsideClick();
  expect(signal.aborted).toBe(true);
  expect(replyStatus().textContent).toBe("処理を中止しました。");
  respond({ outcome: "action", message: "遅れて返った回答", action: definition, revision: "r1" });
  await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(dialog().open).toBe(false);
  expect(document.querySelector(".ai-log")!.textContent).not.toContain("遅れて");
});

it("preserves the original operation ID and result lookup after dismissal during commit", async () => {
  let operationId = "";
  let finishCommit!: (value: unknown) => void;
  const result = { type: "create_layer", id: "layer-created", name: "調査" };
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/chat")
      return {
        outcome: "action",
        message: "作成を提案します",
        action: { type: "create_layer", name: "調査" },
        revision: "r1",
      };
    if (path === "/ai/operations/prepare") {
      operationId = body.operation_id;
      return {
        operation_id: operationId,
        status: "prepared",
        summary: { type: "create_layer", name: "調査" },
      };
    }
    if (path === "/ai/operations/commit")
      return new Promise((resolve) => {
        finishCommit = resolve;
      });
    if (path === "/ai/operations/" + operationId)
      return { operation_id: operationId, status: "completed", result };
    throw Error("unexpected path");
  });
  mount(transport);
  await flush();
  submit("調査レイヤーを作成して");
  await flush();
  const button = (text: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text,
    )!;
  button("確定する").click();
  await flush();
  expect(cancelButton().hidden).toBe(false);
  expect(dialog().querySelector(".ai-status")!.textContent).toBe("処理中です…");
  outsideClick();
  finishCommit({ operation_id: operationId, status: "completed", result });
  await flush();
  chat.open();
  await flush();
  expect(document.querySelector<HTMLButtonElement>(".ai-send")!.disabled).toBe(true);
  button("結果を確認").click();
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/prepare")).toHaveLength(
    1,
  );
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/commit")).toHaveLength(1);
  expect(transport.mock.calls.some(([path]) => path === "/ai/operations/" + operationId)).toBe(
    true,
  );
  expect(dialog().textContent).toContain("レイヤーを作成しました：調査");
});
