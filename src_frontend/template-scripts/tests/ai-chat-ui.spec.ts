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
const flush = async () => {
  for (let i = 0; i < 30; ++i) await Promise.resolve();
};
let chat: ReturnType<typeof createAiChat>;
const dialog = () => document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!;
const progress = () => document.querySelector<HTMLElement>(".ai-progress")!;
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

it("uses the shared spinner until the map adapter has finished without blocking the backdrop", async () => {
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
      return { outcome: "action", message: "学校を抽出します", action: definition, revision: "r1" };
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: ["marker:m1"], target_count: 1, definition };
    throw Error("unexpected path");
  });
  mount(transport, apply);
  await flush();
  submit();
  await flush();
  expect(apply).toHaveBeenCalledOnce();
  expect(progress().hidden).toBe(false);
  expect(progress().querySelector("svg")?.classList.contains("shared-progress-spinner")).toBe(true);
  expect(progress().querySelector("circle")?.getAttribute("stroke")).toBe("#76c7c0");
  expect(progress().textContent).toBe("");
  expect(document.querySelector<HTMLElement>(".ai-status")!.hidden).toBe(true);
  expect(document.querySelector(".map-progress-dialog")).toBeNull();
  expect(dialog().getAttribute("aria-busy")).toBe("true");
  finish();
  await flush();
  expect(progress().hidden).toBe(true);
  expect(document.querySelector<HTMLElement>(".ai-status")!.hidden).toBe(false);
  expect(document.querySelector(".ai-status")!.textContent).toContain("反映しました");
  expect(dialog().getAttribute("aria-busy")).toBe("false");
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

it("hides progress and aborts the request on backdrop dismissal, discarding a late model reply", async () => {
  let reply!: (value: unknown) => void;
  let signal!: AbortSignal;
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return capabilities;
    signal = currentSignal;
    return new Promise((resolve) => {
      reply = resolve;
    });
  });
  const apply = mount(transport);
  await flush();
  submit();
  await flush();
  expect(progress().hidden).toBe(false);
  outsideClick();
  expect(signal.aborted).toBe(true);
  expect(progress().hidden).toBe(true);
  reply({ outcome: "action", message: "遅れて返った回答", action: definition, revision: "r1" });
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
  expect(progress().hidden).toBe(false);
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
