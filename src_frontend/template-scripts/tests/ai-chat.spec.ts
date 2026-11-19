import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAiChat } from "../src/ai/chat";
import { createAiOperationId } from "../src/ai/types";

const capabilities = { enabled: true, voice_enabled: false, revision: "r1" };
const modernCapabilities = { ...capabilities, protocol_version: 2, write_enabled: true };
const filterDefinition = { type: "filter" as const, expression: { op: "text", query1: "学校" } };
const colorDefinition = {
  type: "color" as const,
  common_form_id: "form1",
  rules: [
    {
      id: "red",
      label: "10年以上",
      color: "#ff0000",
      conditions: [{ field_id: "age", field_type: "number", op: "gte", value: "10" }],
    },
  ],
};

it.each(["filter", "color"] as const)(
  "編集画面の%s解除は片側の定義だけを消し、Undoで元に戻す",
  async (kind) => {
    const undoClear = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undoClear);
    const apply = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    const transport = vi.fn(async (path: string, body?: any) => {
      if (path === "/ai/capabilities") return modernCapabilities;
      if (path === "/ai/suggestions")
        return { revision: "r1", as_of: "2026-11-17T00:00:00Z", suggestions: [] };
      if (path === "/ai/assist/execute") {
        if (body.action.type === "reset") return { type: "reset" };
        if (body.action.type === "filter")
          return { type: "filter", targets: [], target_count: 0, definition: body.action };
        return {
          type: "color",
          definition: body.action,
          coloring: {
            version: 1,
            rules: [{ id: "red", label: "10年以上", color: "#ff0000" }],
            targets: {},
          },
        };
      }
      if (path === "/ai/chat") return { message: "確認しました", revision: "r1", action: null };
      throw Error("unexpected request");
    });
    chat = createAiChat({
      transport,
      getContext: () => ({ layer_ids: ["l1"] }),
      getContextKey: () => "owner:l1",
      apply,
      clear,
    });
    await flush();
    await chat.applyDefinition(filterDefinition);
    await chat.applyDefinition(colorDefinition);
    await chat.clearDefinition(kind);
    expect(clear).toHaveBeenCalledWith(kind, expect.any(AbortSignal));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(false);
    expect(transport).toHaveBeenCalledWith(
      "/ai/assist/execute",
      {
        protocol_version: 2,
        revision: "r1",
        action: { type: "reset" },
        context: { layer_ids: ["l1"] },
      },
      expect.any(AbortSignal),
    );
    chat.open();
    await flush();
    submit("現在の条件を確認");
    await flush();
    expect(transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1].state).toEqual({
      filter: kind === "filter" ? null : filterDefinition,
      color: kind === "color" ? null : colorDefinition,
    });
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "元に戻す")!
      .click();
    await flush();
    expect(undoClear).toHaveBeenCalledOnce();
    submit("復元後の条件を確認");
    await flush();
    expect(transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1].state).toEqual({
      filter: filterDefinition,
      color: colorDefinition,
    });
  },
);

it.each(["account", "context", "abort", "revision"])(
  "編集画面の解除で%sが変わっても遅延応答を地図へ反映しない",
  async (reason) => {
    let finish!: (value: unknown) => void;
    let key = "owner",
      revision = "r1";
    const accountChanged = vi.fn(),
      clear = vi.fn();
    const transport = vi.fn(async (path: string) => {
      if (path === "/ai/capabilities") return { ...modernCapabilities, revision };
      if (path === "/ai/assist/execute") {
        const response = await new Promise((resolve) => {
          finish = resolve;
        });
        if (reason === "account") throw Error("ai_account_changed");
        return response;
      }
      throw Error("unexpected request");
    });
    chat = createAiChat({
      transport,
      clear,
      apply: vi.fn(),
      getContext: () => ({ layer_ids: null }),
      getContextKey: () => key,
      onAccountChanged: accountChanged,
    });
    await flush();
    const controller = new AbortController();
    const pending = chat
      .clearDefinition("filter", controller.signal)
      .catch((error: Error) => error);
    await flush();
    if (reason === "context") key = "other-owner";
    if (reason === "abort") controller.abort();
    if (reason === "revision") revision = "r2";
    finish({ type: "reset" });
    expect(await pending).toMatchObject({
      name: reason === "abort" || reason === "revision" ? "AbortError" : "Error",
    });
    expect(clear).not.toHaveBeenCalled();
    if (reason === "account") expect(accountChanged).toHaveBeenCalledOnce();
  },
);

it("解除の表示処理中に中止しても復元完了まで次の表示操作を受け付けない", async () => {
  let finish!: (value: () => Promise<void>) => void;
  let restore!: () => void;
  const undo = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        restore = resolve;
      }),
  );
  const clear = vi.fn(
    () =>
      new Promise<() => Promise<void>>((resolve) => {
        finish = resolve;
      }),
  );
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/assist/execute") return { type: "reset" };
    throw Error("unexpected request");
  });
  chat = createAiChat({
    transport,
    clear,
    apply: vi.fn(),
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
  });
  await flush();
  const controller = new AbortController();
  const pending = chat.clearDefinition("filter", controller.signal).catch((error: Error) => error);
  await flush();
  controller.abort();
  finish(undo);
  await flush();
  await expect(chat.clearDefinition("color")).rejects.toThrow("現在のAI処理");
  await expect(chat.applyDefinition(filterDefinition)).rejects.toThrow("現在のAI処理");
  expect(undo).toHaveBeenCalledOnce();
  restore();
  expect(await pending).toMatchObject({ name: "AbortError" });
});
let chat: ReturnType<typeof createAiChat>;
const flush = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};
const submit = (text = "2010年以前を抽出") => {
  const draft = document.querySelector("textarea")!;
  draft.value = text;
  draft.dispatchEvent(new Event("input"));
  document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});
afterEach(() => {
  chat?.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps the same operation ID when commit is uncertain even if a status read still says prepared", async () => {
  let operationId = "",
    commits = 0,
    turns = 0;
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/chat")
      return {
        message: "レイヤーを作成します",
        revision: "r1",
        outcome: "action",
        action: turns++ === 0 ? { type: "create_layer", name: "調査" } : null,
      };
    if (path === "/ai/operations/prepare") {
      operationId = body.operation_id;
      return {
        operation_id: operationId,
        status: "prepared",
        summary: { type: "create_layer", name: "調査" },
      };
    }
    if (path === "/ai/operations/commit") {
      if (++commits === 1) throw Error("commit response timed out");
      return {
        operation_id: operationId,
        status: "completed",
        result: { type: "create_layer", id: "new-layer", name: "調査" },
      };
    }
    if (path === "/ai/operations/" + operationId)
      return { operation_id: operationId, status: "prepared" };
    throw Error("unexpected path");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  submit("調査というレイヤーを作成");
  await flush();
  const confirm = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "確定する",
    )!;
  confirm().click();
  await flush();
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  submit("別のレイヤーを作成");
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/chat")).toHaveLength(1);
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/prepare")).toHaveLength(
    1,
  );
  confirm().click();
  await flush();
  expect(
    transport.mock.calls
      .filter(([path]) => path === "/ai/operations/commit")
      .map(([, body]) => body.operation_id),
  ).toEqual([operationId, operationId]);
  submit("作成結果を教えて");
  await flush();
  const history = transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1].history;
  expect(history.find((entry: any) => entry.role === "assistant").content).toContain(
    "作成・保存完了",
  );
  expect(history.find((entry: any) => entry.role === "assistant").content).toContain("new-layer");
});

it("records an unconfirmed proposal as pending rather than successful execution", async () => {
  let turn = 0;
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/chat")
      return {
        message: "作成します",
        revision: "r1",
        outcome: "action",
        action: turn++ === 0 ? { type: "create_layer", name: "未確定" } : null,
      };
    if (path === "/ai/operations/prepare")
      return {
        operation_id: body.operation_id,
        status: "prepared",
        summary: { type: "create_layer", name: "未確定" },
      };
    throw Error("commit must not be called");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  submit("未確定レイヤー作成");
  await flush();
  submit("まだ実行しないで説明して");
  await flush();
  const history = transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1].history;
  const record = history.find((entry: any) => entry.role === "assistant").content;
  expect(record).toContain("確認待ち・未実行");
  expect(record).not.toContain("適用成功");
});

it("does not restore old applied definitions after asynchronous undo crosses an account or scope clear", async () => {
  let turn = 0,
    key = "old-account",
    finishUndo!: () => void;
  const undo = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishUndo = resolve;
      }),
  );
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/chat")
      return {
        message: "条件を適用します",
        revision: "r1",
        outcome: "action",
        action: [filterDefinition, colorDefinition, null][turn++],
      };
    if (path === "/ai/assist/execute")
      return body.action.type === "filter"
        ? { type: "filter", targets: [], target_count: 0, definition: filterDefinition }
        : {
            type: "color",
            coloring: {
              version: 1,
              rules: [{ id: "red", label: "10年以上", color: "#ff0000" }],
              targets: {},
            },
            definition: colorDefinition,
          };
    throw Error("unexpected path");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => key,
    apply: vi.fn().mockResolvedValue(undo),
  });
  chat.open();
  await flush();
  submit("旧アカウントで検索");
  await flush();
  submit("色分け");
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "元に戻す")!
    .click();
  await flush();
  key = "new-account";
  chat.clear();
  chat.open();
  await flush();
  finishUndo();
  await flush();
  submit("新アカウントの質問");
  await flush();
  const latest = transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1];
  expect(latest.state).toEqual({ filter: null, color: null });
  expect(latest.history).toEqual([]);
  expect(document.querySelector(".ai-status")!.textContent).not.toContain("元に戻しました");
});

it.each(["cancel", "close", "revision"])(
  "Undo中の%s後も同じ対象の復元を定義と履歴へ確定する",
  async (interruption) => {
    let revision = "r1",
      painted = "initial",
      saveNext = true;
    let finishUndo!: () => void;
    const undoLast = vi.fn(
      () =>
        new Promise<void>((done) => {
          finishUndo = () => {
            painted = "first";
            done();
          };
        }),
    );
    const transport = vi.fn(async (path: string, body?: any) => {
      if (path === "/ai/capabilities") return { ...modernCapabilities, revision };
      if (path === "/ai/suggestions")
        return { revision, as_of: "2026-11-17T00:00:00Z", suggestions: [] };
      if (path === "/ai/assist/execute")
        return { type: "filter", targets: [], target_count: 0, definition: body.action };
      if (path === "/ai/chat") {
        const action = saveNext ? { type: "save_preset", kind: "filter", name: "復元後" } : null;
        saveNext = false;
        return { message: "条件を確認します", revision, outcome: "action", action };
      }
      if (path === "/ai/operations/prepare")
        return {
          operation_id: body.operation_id,
          status: "prepared",
          summary: {
            type: "save_preset",
            kind: "filter",
            name: "復元後",
            definition: body.state.filter,
          },
        };
      throw Error("unexpected request");
    });
    const apply = vi.fn(async (result: any) => {
      const previous = painted;
      painted = result.definition.expression.query1;
      return painted === "second"
        ? undoLast
        : async () => {
            painted = previous;
          };
    });
    chat = createAiChat({
      transport,
      getContext: () => ({ layer_ids: null }),
      getContextKey: () => "owner",
      apply,
    });
    await flush();
    const first = { type: "filter" as const, expression: { op: "text", query1: "first" } };
    await chat.applyDefinition(first);
    await chat.applyDefinition({ type: "filter", expression: { op: "text", query1: "second" } });
    chat.open();
    await flush();
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === text,
      )!;
    button("元に戻す").click();
    await flush();
    expect(undoLast).toHaveBeenCalledOnce();
    if (interruption === "close") chat.close();
    else if (interruption === "revision") {
      revision = "r2";
      await chat.refreshCapabilities();
    } else button("中止").click();
    finishUndo();
    await flush();
    expect(painted).toBe("first");
    chat.open();
    await flush();
    submit("元に戻した条件を保存して");
    await flush();
    expect(
      transport.mock.calls.find(([path]) => path === "/ai/operations/prepare")![1].state,
    ).toEqual({ filter: first, color: null });
    button("取り消す").click();
    await flush();
    // 復元済みのUndoを再実行せず、その前の操作を戻せることも確認する。
    button("元に戻す").click();
    await flush();
    expect(painted).toBe("initial");
    expect(undoLast).toHaveBeenCalledOnce();
    submit("現在の条件を確認");
    await flush();
    expect(transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1].state).toEqual({
      filter: null,
      color: null,
    });
  },
);

it("generates CSPRNG UUIDs without randomUUID on HTTP LAN and never uses Math.random", () => {
  let count = 0;
  const random = vi.fn((bytes: Uint8Array) => {
    bytes.fill(++count);
    return bytes;
  });
  vi.stubGlobal("crypto", { getRandomValues: random });
  const first = createAiOperationId(),
    second = createAiOperationId();
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
  expect(random).toHaveBeenCalledTimes(2);
  vi.stubGlobal("crypto", {});
  expect(() => createAiOperationId()).toThrow("安全な操作ID");
});

it("preserves applied definitions separately, saves the actual state after confirmation, and restores definitions with undo", async () => {
  let turn = 0;
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/chat")
      return {
        message: "条件を確認します",
        revision: "r1",
        outcome: "action",
        action: [
          filterDefinition,
          colorDefinition,
          { type: "save_preset", kind: "filter", name: "学校" },
          null,
        ][turn++],
      };
    if (path === "/ai/assist/execute")
      return body.action.type === "filter"
        ? { type: "filter", targets: ["marker:m1"], target_count: 1, definition: filterDefinition }
        : {
            type: "color",
            coloring: {
              version: 1,
              rules: [{ id: "red", label: "10年以上", color: "#ff0000" }],
              targets: { "marker:m1": "red" },
            },
            definition: colorDefinition,
          };
    if (path === "/ai/operations/prepare")
      return {
        operation_id: body.operation_id,
        status: "prepared",
        summary: {
          type: "save_preset",
          kind: "filter",
          name: "学校",
          definition: filterDefinition,
        },
      };
    if (path === "/ai/operations/commit")
      return {
        operation_id: body.operation_id,
        status: "completed",
        result: { type: "save_preset", id: "saved1", name: "学校", kind: "filter" },
      };
    throw Error("unexpected request");
  });
  const undo = vi.fn().mockResolvedValue(undefined);
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: ["l1"] }),
    getContextKey: () => "owner:l1",
    apply: vi.fn().mockResolvedValue(undo),
  });
  chat.open();
  await flush();
  submit("学校を検索");
  await flush();
  submit("耐用年数で色分け");
  await flush();
  submit("この検索条件を学校として保存");
  await flush();
  const prepared = transport.mock.calls.find(([path]) => path === "/ai/operations/prepare")![1];
  expect(prepared.state).toEqual({ filter: filterDefinition, color: colorDefinition });
  expect(transport.mock.calls.some(([path]) => path === "/ai/operations/commit")).toBe(false);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "確定する",
  )!;
  confirm.click();
  confirm.click();
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/commit")).toHaveLength(1);
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "元に戻す")!
    .click();
  await flush();
  submit("現在の条件を教えて");
  await flush();
  const lastChat = transport.mock.calls.filter(([path]) => path === "/ai/chat").at(-1)![1];
  expect(lastChat.protocol_version).toBe(2);
  expect(lastChat.state).toEqual({ filter: filterDefinition, color: null });
  expect(undo).toHaveBeenCalledOnce();
});

it("recovers a committed write by operation ID and retries only the layer list after synchronization fails", async () => {
  let operationId = "";
  const name = "<img src=x onerror=alert(1)>";
  const result = () => ({
    operation_id: operationId,
    status: "completed",
    result: { type: "create_layer", id: "layer-new", name },
  });
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/chat")
      return {
        message: "レイヤーを作成します",
        revision: "r1",
        outcome: "action",
        action: { type: "create_layer", name },
      };
    if (path === "/ai/operations/prepare") {
      operationId = body.operation_id;
      return {
        operation_id: operationId,
        status: "prepared",
        summary: { type: "create_layer", name },
      };
    }
    if (path === "/ai/operations/commit") throw Error("response lost after commit");
    if (path === `/ai/operations/${operationId}`) return result();
    throw Error("unexpected request");
  });
  const onLayerCreated = vi
    .fn()
    .mockRejectedValueOnce(Error("refresh failed"))
    .mockResolvedValue(undefined);
  const apply = vi.fn();
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply,
    onLayerCreated,
  });
  chat.open();
  await flush();
  submit("レイヤーを作成");
  await flush();
  expect(document.querySelector(".ai-panel img")).toBeNull();
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "確定する")!
    .click();
  await flush();
  expect(onLayerCreated).toHaveBeenCalledOnce();
  expect(document.querySelector(".ai-panel")!.textContent).toContain("作成は完了");
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "一覧を更新")!
    .click();
  await flush();
  expect(onLayerCreated).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/prepare")).toHaveLength(
    1,
  );
  expect(transport.mock.calls.filter(([path]) => path === "/ai/operations/commit")).toHaveLength(1);
  expect(
    transport.mock.calls.filter(([path]) => path === `/ai/operations/${operationId}`),
  ).toHaveLength(1);
  expect(apply).not.toHaveBeenCalled();
});

it("forces the denied message and never executes an action attached to a denied answer", async () => {
  const transport = vi.fn(async (path: string) =>
    path === "/ai/capabilities"
      ? modernCapabilities
      : {
          outcome: "denied",
          message: "モデルが勝手に書いた説明",
          action: { type: "create_layer", name: "unwanted" },
          revision: "r1",
        },
  );
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  submit("削除して");
  await flush();
  expect(document.querySelector(".ai-log")!.textContent).toContain(
    "要求された操作は許可されていません。",
  );
  expect(document.querySelector(".ai-log")!.textContent).not.toContain("モデルが勝手に");
  expect(
    transport.mock.calls.every(([path]) =>
      ["/ai/capabilities", "/ai/suggestions", "/ai/chat"].includes(path),
    ),
  ).toBe(true);
});

it.each(["loaded", "aborted"])(
  "保存条件一覧をテキストで表示し、呼び出しで地図へ適用せず中断後もチャットを開かない: %s",
  async (outcome) => {
    const transport = vi.fn(async (path: string, body?: any) => {
      if (path === "/ai/capabilities") return modernCapabilities;
      if (path === "/ai/chat")
        return {
          message: "保存条件を表示します",
          action: { type: "list_presets", kind: "filter" },
          revision: "r1",
          outcome: "action",
        };
      if (path === "/ai/assist/execute" && body.action.type === "list_presets")
        return {
          type: "presets",
          items: [
            {
              id: "preset-two",
              name: "<img src=x>学校",
              kind: "filter",
              schema_version: 2,
              create_at: "2026-11-17",
              definition: filterDefinition,
              display: { form_label: null, fields: [] },
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
          kind: "filter",
        };
      if (path === "/ai/assist/execute")
        return { type: "filter", targets: [], target_count: 0, definition: filterDefinition };
      throw Error("unexpected request");
    });
    const apply = vi.fn().mockResolvedValue(undefined);
    const recall = vi.fn(async () => {
      if (outcome === "aborted") throw new DOMException("Aborted", "AbortError");
    });
    chat = createAiChat({
      transport,
      getContext: () => ({ layer_ids: ["l1"] }),
      getContextKey: () => "owner",
      apply,
      onRecallPreset: recall,
    });
    chat.open();
    await flush();
    submit("絞り込み条件一覧");
    await flush();
    expect(document.querySelector(".ai-panel img")).toBeNull();
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "呼び出し")!
      .click();
    await flush();
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "preset-two",
        definition: filterDefinition,
        schema_version: 2,
      }),
    );
    expect(document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!.open).toBe(false);
    expect(transport.mock.calls.filter(([path]) => path === "/ai/assist/execute")).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
  },
);

it("チャットを開かず複合下書きを実行し、実際の定義を次の保存要求へ引き継ぐ", async () => {
  const definition = {
    type: "filter" as const,
    expression: {
      op: "or",
      children: [
        { op: "text", query1: "学校" },
        {
          op: "not",
          child: {
            op: "attribute",
            common_form_id: "form-two",
            conditions: [
              { field_id: "n", field_type: "number", op: "gte", value: "1234567890123456789.123" },
            ],
          },
        },
      ],
    },
  };
  const original = structuredClone(definition);
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/suggestions")
      return { revision: "r1", as_of: "2026-11-17T00:00:00Z", suggestions: [] };
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: [], target_count: 0, definition: body.action };
    if (path === "/ai/chat")
      return {
        message: "保存します",
        revision: "r1",
        outcome: "action",
        action: { type: "save_preset", kind: "filter", name: "編集済み" },
      };
    if (path === "/ai/operations/prepare")
      return {
        operation_id: body.operation_id,
        status: "prepared",
        summary: {
          type: "save_preset",
          kind: "filter",
          name: "編集済み",
          definition: body.state.filter,
        },
      };
    throw Error("unexpected request");
  });
  const undo = vi.fn().mockResolvedValue(undefined),
    apply = vi.fn().mockResolvedValue(undo);
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: ["layer-one"] }),
    getContextKey: () => "owner:layer-one",
    apply,
  });
  await flush();
  await chat.applyDefinition(definition, new AbortController().signal);
  expect(document.querySelector<HTMLDialogElement>(".geocode-ai-chat")!.open).toBe(false);
  expect(apply).toHaveBeenCalledOnce();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/chat")).toHaveLength(0);
  expect(transport).toHaveBeenCalledWith(
    "/ai/assist/execute",
    {
      protocol_version: 2,
      action: original,
      revision: "r1",
      context: { layer_ids: ["layer-one"] },
    },
    expect.any(AbortSignal),
  );
  definition.expression.children.reverse();
  chat.open();
  await flush();
  submit("この条件を保存して");
  await flush();
  expect(
    transport.mock.calls.find(([path]) => path === "/ai/operations/prepare")![1].state.filter,
  ).toEqual(original);
  await expect(chat.applyDefinition(original)).rejects.toThrow("現在のAI処理");
});

it("編集画面からの実行も元に戻す操作で適用済み定義と地図を一緒に復元する", async () => {
  const undo = vi.fn().mockResolvedValue(undefined);
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/suggestions")
      return { revision: "r1", as_of: "2026-11-17T00:00:00Z", suggestions: [] };
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: [], target_count: 0, definition: body.action };
    if (path === "/ai/chat") return { message: "現在の条件です", revision: "r1", action: null };
    throw Error("unexpected request");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply: vi.fn().mockResolvedValue(undo),
  });
  await flush();
  await chat.applyDefinition({ type: "filter", expression: { op: "text", query1: "学校" } });
  chat.open();
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "元に戻す")!
    .click();
  await flush();
  expect(undo).toHaveBeenCalledOnce();
  submit("現在の条件を確認");
  await flush();
  expect(transport.mock.calls.find(([path]) => path === "/ai/chat")![1].state).toEqual({
    filter: null,
    color: null,
  });
});

it.each(["abort", "context", "revision"])(
  "編集画面実行の%s後に遅延応答が届いても地図へ反映しない",
  async (reason) => {
    let resolve!: (value: unknown) => void;
    let key = "owner:layer-one",
      revision = "r1";
    const transport = vi.fn(async (path: string) => {
      if (path === "/ai/capabilities") return { ...modernCapabilities, revision };
      if (path === "/ai/assist/execute")
        return new Promise((done) => {
          resolve = done;
        });
      throw Error("unexpected request");
    });
    const apply = vi.fn(),
      controller = new AbortController();
    chat = createAiChat({
      transport,
      getContext: () => ({ layer_ids: ["layer-one"] }),
      getContextKey: () => key,
      apply,
    });
    await flush();
    const pending = chat.applyDefinition(
      { type: "filter", expression: { op: "all" } },
      controller.signal,
    );
    const failure = expect(pending).rejects.toThrow();
    await flush();
    await expect(
      chat.applyDefinition({ type: "filter", expression: { op: "all" } }),
    ).rejects.toThrow("現在のAI処理");
    if (reason === "abort") controller.abort();
    else if (reason === "context") key = "owner:layer-two";
    else revision = "r2";
    resolve({
      type: "filter",
      targets: [],
      target_count: 0,
      definition: { type: "filter", expression: { op: "all" } },
    });
    await failure;
    expect(apply).not.toHaveBeenCalled();
    expect(transport.mock.calls.filter(([path]) => path === "/ai/chat")).toHaveLength(0);
  },
);

it("地図の反映応答直後に編集画面が取り消された場合は反映を戻す", async () => {
  const controller = new AbortController(),
    undo = vi.fn().mockResolvedValue(undefined);
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: [], target_count: 0, definition: body.action };
    throw Error("unexpected request");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply: vi.fn(async () => {
      controller.abort();
      return undo;
    }),
  });
  await flush();
  await expect(
    chat.applyDefinition({ type: "filter", expression: { op: "all" } }, controller.signal),
  ).rejects.toThrow();
  expect(undo).toHaveBeenCalledOnce();
});

it("設定変更で通信を取り消しても旧表示の復元完了まで新しい表示操作を始めない", async () => {
  let revision = "r1",
    painted = "baseline",
    first = true;
  let finishApply!: () => void, finishRollback!: () => void;
  const rollback = vi.fn(
    () =>
      new Promise<void>((done) => {
        finishRollback = () => {
          painted = "baseline";
          done();
        };
      }),
  );
  const transport = vi.fn(async (path: string, body?: any) => {
    if (path === "/ai/capabilities") return { ...modernCapabilities, revision };
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: [], target_count: 0, definition: body.action };
    if (path === "/ai/suggestions")
      return { revision, as_of: "2026-11-17T00:00:00Z", suggestions: [] };
    if (path === "/ai/chat") return { message: "現在の条件です", revision, action: null };
    throw Error("unexpected request");
  });
  const apply = vi.fn(async () => {
    if (first) {
      first = false;
      painted = "old";
      await new Promise<void>((done) => {
        finishApply = done;
      });
      return rollback;
    }
    painted = "new";
    return async () => {
      painted = "baseline";
    };
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply,
  });
  await flush();
  const pending = chat.applyDefinition({
    type: "filter",
    expression: { op: "text", query1: "old" },
  });
  const failure = expect(pending).rejects.toThrow();
  await flush();
  expect(painted).toBe("old");
  revision = "r2";
  await chat.refreshCapabilities();
  const nextDefinition = { type: "filter" as const, expression: { op: "text", query1: "new" } };
  await expect(chat.applyDefinition(nextDefinition)).rejects.toThrow("現在のAI処理");
  chat.open();
  await flush();
  submit("新しい表示を実行");
  await flush();
  expect(transport.mock.calls.filter(([path]) => path === "/ai/chat")).toHaveLength(0);
  finishApply();
  await flush();
  expect(rollback).toHaveBeenCalledOnce();
  await expect(chat.applyDefinition(nextDefinition)).rejects.toThrow("現在のAI処理");
  finishRollback();
  await failure;
  expect(painted).toBe("baseline");
  await chat.applyDefinition(nextDefinition);
  expect(painted).toBe("new");
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "元に戻す")!
    .click();
  await flush();
  expect(painted).toBe("baseline");
  submit("現在の条件を確認");
  await flush();
  expect(transport.mock.calls.find(([path]) => path === "/ai/chat")![1].state).toEqual({
    filter: null,
    color: null,
  });
});

it("自然言語で明示した保存条件の適用は従来どおり直接実行する", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return modernCapabilities;
    if (path === "/ai/suggestions")
      return { revision: "r1", as_of: "2026-11-17T00:00:00Z", suggestions: [] };
    if (path === "/ai/chat")
      return {
        message: "適用します",
        revision: "r1",
        outcome: "action",
        action: { type: "apply_preset", preset_id: "saved-one" },
      };
    if (path === "/ai/assist/execute")
      return { type: "filter", targets: [], target_count: 0, definition: filterDefinition };
    throw Error("unexpected request");
  });
  const recall = vi.fn(),
    apply = vi.fn();
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "owner",
    apply,
    onRecallPreset: recall,
  });
  chat.open();
  await flush();
  submit("保存条件を適用して");
  await flush();
  expect(apply).toHaveBeenCalledOnce();
  expect(recall).not.toHaveBeenCalled();
});

it("shows escaped answers, executes a sent instruction, and supports undo after map acknowledgement", async () => {
  const undo = vi.fn().mockResolvedValue(undefined);
  const apply = vi.fn().mockResolvedValue(undo);
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/chat")
      return {
        message: "<img src=x onerror=alert(1)>条件を適用します",
        action: { type: "filter" },
        revision: "r1",
      };
    return { type: "filter", targets: ["marker:m1"], target_count: 1 };
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: ["l1"] }),
    getContextKey: () => "account:l1",
    apply,
  });
  chat.open();
  await flush();
  submit();
  await flush();
  expect(transport).toHaveBeenCalledWith(
    "/ai/execute",
    { action: { type: "filter" }, context: { layer_ids: ["l1"] }, revision: "r1" },
    expect.any(AbortSignal),
  );
  expect(apply).toHaveBeenCalledOnce();
  expect(document.querySelector(".ai-log img")).toBeNull();
  expect(document.querySelector(".ai-log")!.textContent).toContain("<img");
  expect(document.querySelector(".ai-reply-status")!.textContent).toContain("1件");
  const undoButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "元に戻す",
  )!;
  undoButton.click();
  await flush();
  expect(undo).toHaveBeenCalledOnce();
});

it("does not execute an action after administrator settings change", async () => {
  let revision = "r1";
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return { ...capabilities, revision };
    if (path === "/ai/chat") {
      revision = "r2";
      return { message: "適用します", action: {}, revision: "r1" };
    }
    throw Error("unexpected execution");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  submit();
  await flush();
  expect(transport.mock.calls.some(([path]) => path === "/ai/execute")).toBe(false);
  expect(document.querySelector(".ai-reply-status")!.textContent).toContain("設定が変更");
});

it("discards a reply when the selected layer changes or the chat closes", async () => {
  let finish!: (value: unknown) => void;
  let key = "a";
  const apply = vi.fn();
  const transport = vi.fn(async (path: string) =>
    path === "/ai/capabilities"
      ? capabilities
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: [key] }),
    getContextKey: () => key,
    apply,
  });
  chat.open();
  await flush();
  submit();
  await flush();
  key = "b";
  finish({ message: "古い応答", action: {}, revision: "r1" });
  await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector(".ai-log")!.textContent).not.toContain("古い応答");
  expect(document.querySelector(".ai-reply-status")!.textContent).toContain("対象が変わりました");
});

it("releases a microphone acquired after the chat was closed", async () => {
  let acquire!: (value: unknown) => void;
  const stop = vi.fn();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "MediaRecorder",
    class {
      static isTypeSupported() {
        return true;
      }
    },
  );
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            acquire = resolve;
          }),
      ),
    },
  });
  chat = createAiChat({
    transport: vi.fn().mockResolvedValue({ ...capabilities, voice_enabled: true }),
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  (document.querySelector(".ai-record") as HTMLButtonElement).click();
  await flush();
  chat.close();
  acquire({ getTracks: () => [{ stop }] });
  await flush();
  expect(stop).toHaveBeenCalledOnce();
});

it("puts transcription into an editable draft without sending a chat request", async () => {
  const stop = vi.fn();
  class Recorder {
    static isTypeSupported(type: string) {
      return type === "audio/mp4";
    }
    state = "inactive";
    mimeType = "audio/mp4";
    ondataavailable?: (value: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
  });
  const transport = vi.fn(async (path: string) =>
    path === "/ai/capabilities"
      ? { ...capabilities, voice_enabled: true }
      : { text: "耐用年数を色分け" },
  );
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  const record = document.querySelector(".ai-record") as HTMLButtonElement;
  record.click();
  await flush();
  record.click();
  await flush();
  expect(stop).toHaveBeenCalled();
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
    "耐用年数を色分け",
  );
  expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  expect(transport.mock.calls.some(([path]) => path === "/ai/chat")).toBe(false);
  expect(transport.mock.calls.some(([path]) => path === "/ai/transcribe")).toBe(true);
});

it("keeps action receipts in history without exposing JSON in the conversation", async () => {
  let count = 0;
  const calls: { path: string; body: any }[] = [];
  const action = { type: "filter", conditions: [{ op: "lte", value: "2010-12-31" }] };
  const transport = vi.fn(async (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/chat")
      return ++count === 1
        ? { message: "抽出します", action, revision: "r1" }
        : { message: "追加条件を確認します", revision: "r1" };
    return { type: "filter", targets: [], target_count: 0 };
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn().mockResolvedValue(undefined),
  });
  chat.open();
  await flush();
  submit();
  await flush();
  submit("さらに絞り込んで");
  await flush();
  const second = calls.filter((call) => call.path === "/ai/chat")[1]!;
  expect(second.body.history.at(-1).content).toContain(JSON.stringify(action));
  expect(second.body.history.at(-1).content).toContain("適用成功");
  expect(document.querySelector(".ai-log")!.textContent).not.toContain('"conditions"');
});

it("aborts an in-flight request when the administrator disables AI", async () => {
  let enabled = true;
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const apply = vi.fn();
  const transport = vi.fn(async (path: string, _body: unknown, currentSignal: AbortSignal) => {
    if (path === "/ai/capabilities") return { ...capabilities, enabled };
    signal = currentSignal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply,
  });
  chat.open();
  await flush();
  submit();
  await flush();
  enabled = false;
  await chat.refreshCapabilities();
  expect(signal.aborted).toBe(true);
  resolve({ message: "古い指示", action: {}, revision: "r1" });
  await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector(".ai-reply-status")!.textContent).toContain("無効");
});

it("does not stop an inactive recorder again while waiting for its stop event", async () => {
  let active!: Recorder;
  let stops = 0;
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable?: (value: { data: Blob }) => void;
    onstop?: () => void;
    constructor() {
      active = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") throw new DOMException("inactive", "InvalidStateError");
      ++stops;
      this.state = "inactive";
    }
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    },
  });
  chat = createAiChat({
    transport: vi.fn().mockResolvedValue({ ...capabilities, voice_enabled: true }),
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn(),
  });
  chat.open();
  await flush();
  const button = document.querySelector(".ai-record") as HTMLButtonElement;
  button.click();
  await flush();
  button.click();
  button.click();
  expect(button.disabled).toBe(true);
  expect(stops).toBe(1);
  active.onstop?.();
  await flush();
});

it("discards private conversation and undo after a server account conflict and requires reload", async () => {
  const changed = vi.fn();
  let count = 0;
  const transport = vi.fn(async (path: string) => {
    if (path === "/ai/capabilities") return capabilities;
    if (path === "/ai/suggestions")
      return { revision: "r1", as_of: "2026-11-16T00:00:00Z", suggestions: [] };
    if (++count === 1) return { message: "以前のアカウントの回答", revision: "r1" };
    throw Error("ai_account_changed");
  });
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "old-account",
    apply: vi.fn(),
    onAccountChanged: changed,
  });
  chat.open();
  await flush();
  submit("以前の非公開の相談");
  await flush();
  expect(document.querySelector(".ai-log")!.textContent).toContain("非公開");
  submit("次の相談");
  await flush();
  expect(changed).toHaveBeenCalledOnce();
  expect(document.querySelector(".ai-log")!.textContent).toBe("");
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect(document.querySelector(".ai-status")!.textContent).toContain("再読み込み");
  await chat.refreshCapabilities();
  submit("送ってはいけない");
  await flush();
  expect(count).toBe(2);
  expect((document.querySelector(".ai-send") as HTMLButtonElement).disabled).toBe(true);
});

it("restarts capability loading when initial account or layer initialization clears the conversation", async () => {
  let resolve!: (value: unknown) => void;
  const enabled = vi.fn();
  const transport = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(capabilities);
  chat = createAiChat({
    transport,
    getContext: () => ({ layer_ids: null }),
    getContextKey: () => "a",
    apply: vi.fn(),
    onEnabledChange: enabled,
  });
  chat.clear();
  await flush();
  expect(enabled).toHaveBeenLastCalledWith(true);
  resolve({ ...capabilities, enabled: false });
  await flush();
  expect(enabled).toHaveBeenLastCalledWith(true);
});
