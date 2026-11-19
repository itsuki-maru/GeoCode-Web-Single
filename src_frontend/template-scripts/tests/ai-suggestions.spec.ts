import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAiChat } from "../src/ai/chat";
import { validateSuggestions, type AiTransport } from "../src/ai/types";

const caps = { enabled: true, voice_enabled: false, revision: "r1", protocol_version: 2 };
const candidate = "「施設点検」の「点検結果」が「要修繕」の施設を抽出して";
const general = "地図上のデータを絞り込む方法を教えて";
const response = (text = candidate, revision = "r1") => ({
  revision,
  as_of: "2026-11-16T00:00:00Z",
  suggestions: [{ text, kind: "filter" }],
});
const flush = async () => {
  for (let index = 0; index < 50; ++index) await Promise.resolve();
};
let chat: ReturnType<typeof createAiChat>;
let scope = "owner:layer-a";
let dataRevision = "data:1";
const draft = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const dialog = () => document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!;
const input = (value: string) => {
  draft().value = value;
  draft().dispatchEvent(new Event("input"));
};
const tab = (options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  draft().dispatchEvent(event);
  return event;
};
const mount = (transport: AiTransport) => {
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: [scope] }),
    getContextKey: () => scope,
    getSuggestionContextKey: () => dataRevision,
    apply: vi.fn(),
  });
  chat.open();
};
const normalTransport = (suggestions = response()) =>
  vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    if (path === "/ai/suggestions") return suggestions;
    if (path === "/ai/chat") return { message: "回答", revision: "r1", action: null };
    throw Error("unexpected request");
  });
beforeEach(() => {
  scope = "owner:layer-a";
  dataRevision = "data:1";
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads only read-only suggestions, fills the empty draft with Tab, and never submits", async () => {
  const transport = normalTransport();
  mount(transport);
  await flush();
  expect(draft().placeholder).toBe("例：" + candidate);
  expect(transport.mock.calls.map(([path]) => path)).toEqual([
    "/ai/capabilities",
    "/ai/capabilities",
    "/ai/suggestions",
  ]);
  expect(tab().defaultPrevented).toBe(true);
  expect(draft().value).toBe(candidate);
  expect(draft().selectionStart).toBe(candidate.length);
  expect(tab().defaultPrevented).toBe(false);
  expect(document.querySelector(".ai-log")!.textContent).toBe("");
  expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(false);
});

it("keeps focus navigation and IME composition intact and does not replace existing input", async () => {
  mount(normalTransport());
  await flush();
  for (const options of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ])
    expect(tab(options).defaultPrevented).toBe(false);
  draft().dispatchEvent(new Event("compositionstart"));
  expect(tab().defaultPrevented).toBe(false);
  expect(draft().value).toBe("");
  draft().dispatchEvent(new Event("compositionend"));
  input(" ");
  expect(tab().defaultPrevented).toBe(false);
  expect(draft().value).toBe(" ");
  input("自分で入力した指示");
  expect(tab().defaultPrevented).toBe(false);
  expect(draft().value).toBe("自分で入力した指示");
  input("");
  expect(tab().defaultPrevented).toBe(true);
});

it("only describes example input while it is available to an empty, non-composing draft", async () => {
  mount(normalTransport());
  await flush();
  const description = () => {
    const id = draft().getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent : null;
  };
  expect(description()).toContain("Tabキー");
  input("編集中の文章");
  expect(description()).toBeNull();
  expect(tab().defaultPrevented).toBe(false);
  input("");
  expect(description()).toContain("Tabキー");
  draft().dispatchEvent(new Event("compositionstart"));
  expect(description()).toBeNull();
  expect(tab().defaultPrevented).toBe(false);
  draft().dispatchEvent(new Event("compositionend"));
  expect(description()).toContain("Tabキー");
  chat.close();
  expect(description()).toBeNull();
  chat.open();
  await flush();
  expect(description()).toContain("Tabキー");
  expect(tab().defaultPrevented).toBe(true);
  expect(description()).toBeNull();
});

it("supports the example button on mobile without inserting labels or sending a request", async () => {
  const transport = normalTransport();
  mount(transport);
  await flush();
  document.querySelector<HTMLButtonElement>(".ai-use-suggestion")!.click();
  expect(draft().value).toBe(candidate);
  expect(document.activeElement).toBe(draft());
  expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(false);
});

it("never blocks typing or chat while candidate loading is pending and never overwrites a typed draft", async () => {
  let finish!: (value: unknown) => void;
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    if (path === "/ai/suggestions")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (path === "/ai/chat") return { message: "回答", revision: "r1", action: null };
    throw Error("unexpected request");
  });
  mount(transport);
  await flush();
  expect(dialog().querySelector('.ai-reply-status[data-state="waiting"]')).toBeNull();
  expect(draft().disabled).toBe(false);
  input("手入力を保持する");
  expect(document.querySelector<HTMLButtonElement>(".ai-send")!.disabled).toBe(false);
  finish(response());
  await flush();
  expect(draft().value).toBe("手入力を保持する");
  document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(true);
});

it("reuses a short-lived in-memory cache on reopen and focus, and refreshes only after expiry", async () => {
  vi.useFakeTimers();
  const transport = normalTransport();
  mount(transport);
  await flush();
  chat.close();
  chat.open();
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(draft().placeholder).toBe("例：" + general);
  expect(document.querySelector(".ai-suggestion-hint")!.textContent).not.toContain("Tab");
  expect(tab().defaultPrevented).toBe(false);
  chat.close();
  chat.open();
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(2);
});

it("aborts on close and refuses a late response even after reopening the same scope", async () => {
  let finish!: (value: unknown) => void;
  let oldSignal!: AbortSignal;
  let calls = 0;
  const transport = vi.fn(async (path: string, _body: unknown, signal: AbortSignal) => {
    if (path === "/ai/capabilities") return caps;
    if (path === "/ai/suggestions") {
      if (++calls > 1) return response("現在の例");
      oldSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw Error("unexpected request");
  });
  mount(transport);
  await flush();
  chat.close();
  expect(oldSignal.aborted).toBe(true);
  chat.open();
  await flush();
  finish(response("閉じる前の古い例"));
  await flush();
  expect(draft().placeholder).toBe("例：現在の例");
});

it("invalidates data-dependent examples without clearing conversation or pending input", async () => {
  vi.useFakeTimers();
  const transport = normalTransport();
  mount(transport);
  await flush();
  input("会話を残す");
  document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  input("編集中の文章");
  const before = document.querySelector(".ai-log")!.textContent;
  for (const revision of ["data:2", "data:3", "data:4"]) {
    dataRevision = revision;
    chat.invalidateSuggestions();
  }
  await vi.advanceTimersByTimeAsync(150);
  expect(document.querySelector(".ai-log")!.textContent).toBe(before);
  expect(draft().value).toBe("編集中の文章");
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(2);
});

it("debounces mutations arriving in separate frames and only loads the final data revision", async () => {
  vi.useFakeTimers();
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    return response("入力例 " + dataRevision);
  });
  mount(transport);
  await flush();
  expect(draft().placeholder).toContain("data:1");
  for (const revision of ["data:2", "data:3", "data:4"]) {
    dataRevision = revision;
    chat.invalidateSuggestions();
    expect(draft().placeholder).toBe("例：" + general);
    expect(tab().defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(2);
  expect(draft().placeholder).toBe("例：入力例 data:4");
});

it("aborts a stale lookup immediately while delaying only its replacement", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  let lookups = 0;
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return caps;
    if (++lookups > 1) return response("更新後の例");
    signal = currentSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  mount(transport);
  await flush();
  dataRevision = "data:2";
  chat.invalidateSuggestions();
  expect(signal.aborted).toBe(true);
  finish(response("更新前の古い例"));
  await flush();
  expect(draft().placeholder).not.toContain("古い例");
  await vi.advanceTimersByTimeAsync(149);
  expect(lookups).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(lookups).toBe(2);
  expect(draft().placeholder).toBe("例：更新後の例");
});

it.each(["close", "clear", "dispose"] as const)(
  "cancels a scheduled lookup when the chat is ended with %s",
  async (method) => {
    vi.useFakeTimers();
    const transport = normalTransport();
    mount(transport);
    await flush();
    dataRevision = "data:2";
    chat.invalidateSuggestions();
    await vi.advanceTimersByTimeAsync(100);
    chat[method]();
    await vi.advanceTimersByTimeAsync(200);
    expect(transport.mock.calls.filter(([path]) => path === "/ai/suggestions")).toHaveLength(1);
  },
);

it("refuses the old scope both at receipt and when Tab is pressed before invalidation is delivered", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  mount(transport);
  await flush();
  scope = "owner:layer-b";
  finish(response("layer-aの古い例"));
  await flush();
  expect(draft().placeholder).not.toContain("layer-a");
  expect(tab().defaultPrevented).toBe(false);
  chat.invalidateSuggestions();
  await vi.advanceTimersByTimeAsync(150);
  finish(response());
  await flush();
  expect(draft().placeholder).toContain(candidate);
  dataRevision = "data:3";
  expect(tab().defaultPrevented).toBe(false);
  expect(draft().placeholder).not.toContain(candidate);
});

it("falls back on old servers, empty or invalid responses, and preserves ordinary Tab navigation", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    throw Error("not found");
  });
  mount(transport);
  await flush();
  expect(draft().placeholder).toBe("例：" + general);
  expect(tab().defaultPrevented).toBe(false);
  document.querySelector<HTMLButtonElement>(".ai-use-suggestion")!.click();
  expect(draft().value).toBe(general);
  expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(false);
});

it("ends a stalled candidate request on timeout without displaying a global spinner", async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return caps;
    signal = currentSignal;
    return new Promise(() => {});
  });
  mount(transport);
  await flush();
  await vi.advanceTimersByTimeAsync(6001);
  expect(signal.aborted).toBe(true);
  expect(draft().placeholder).toBe("例：" + general);
  expect(document.querySelector(".ai-suggestion-hint")!.textContent).not.toContain(
    "確認しています",
  );
  expect(dialog().querySelector('.ai-reply-status[data-state="waiting"]')).toBeNull();
  expect(draft().disabled).toBe(false);
});

it("discards examples immediately when AI settings change or become disabled", async () => {
  let settings = { ...caps };
  let finish!: (value: unknown) => void;
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return settings;
    if (settings.revision === "r1") return response();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  mount(transport);
  await flush();
  settings = { ...caps, revision: "r2" };
  await chat.refreshCapabilities();
  await flush();
  expect(draft().placeholder).not.toContain(candidate);
  settings = { ...settings, enabled: false };
  await chat.refreshCapabilities();
  finish(response("無効化前の例", "r2"));
  await flush();
  expect(document.querySelector<HTMLElement>(".ai-suggestion-tools")!.hidden).toBe(true);
  expect(tab().defaultPrevented).toBe(false);
  expect(draft().placeholder).not.toContain("無効化前");
});

it("uses the normal account-conflict path only for a response from the current scope", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return caps;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  mount(transport);
  await flush();
  scope = "new-owner";
  reject(Error("ai_account_changed"));
  await flush();
  expect(document.querySelector(".ai-status")!.textContent).not.toContain("再読み込み");
  chat.invalidateSuggestions();
  await vi.advanceTimersByTimeAsync(150);
  reject(Error("ai_account_changed"));
  await flush();
  expect(document.querySelector(".ai-status")!.textContent).toContain("再読み込み");
  expect(document.querySelector<HTMLElement>(".ai-suggestion-tools")!.hidden).toBe(true);
});

it("validates bounded response text without interpreting HTML", () => {
  expect(
    validateSuggestions(response("<img src=x onerror=alert(1)>")).suggestions[0]!.text,
  ).toContain("<img");
  for (const value of [
    { ...response(), as_of: "invalid" },
    { ...response(), suggestions: [{ text: "x", kind: "create_layer" }] },
    {
      ...response(),
      suggestions: Array.from({ length: 4 }, () => ({ text: "x", kind: "filter" })),
    },
    response("x".repeat(301)),
    response("x\ncommand"),
  ])
    expect(() => validateSuggestions(value)).toThrow();
});
