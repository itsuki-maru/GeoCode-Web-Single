import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMapPresetDialogs } from "../src/map/common/map-preset-dialog";

let dialogs: ReturnType<typeof createMapPresetDialogs>;
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
    },
  });
});
afterEach(() => {
  dialogs.dispose();
  document.body.replaceChildren();
});
const manualDraft = {
  kind: "filter" as const,
  definition: {
    common_form_id: "form",
    conditions: [
      { field_id: "photo", field_type: "image", op: "filled", value: null, upper: null },
    ],
  },
};
const preset = {
  id: "saved",
  kind: "filter" as const,
  schema_version: 2 as const,
  name: "画像あり",
  definition: {
    type: "filter" as const,
    expression: { op: "attribute", ...manualDraft.definition },
  },
  display: { form_label: "設備", fields: [{ id: "photo", field_type: "image", label: "写真" }] },
  create_at: "2026-10-30T00:00:00Z",
};
const click = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === text)!
    .click();

it("一覧の先頭に閉じる操作を維持し、開き直すたびに最新の条件を取得する", async () => {
  const updated = { ...preset, name: "更新後の名前" };
  const transport = vi
    .fn()
    .mockRejectedValueOnce(Error("通信に失敗しました。"))
    .mockResolvedValueOnce({ items: [preset], total: 1 })
    .mockResolvedValueOnce({ items: [updated], total: 1 });
  const preparePage = vi
    .fn()
    .mockRejectedValueOnce(Error("先読み失敗"))
    .mockResolvedValue(undefined);
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  dialogs = createMapPresetDialogs(transport, vi.fn(), { preparePage });
  dialogs.list();

  const list = document.querySelector<HTMLDialogElement>('dialog[aria-label="保存した検索条件"]')!;
  await vi.waitFor(() =>
    expect(list.querySelector('[role="alert"]')?.textContent).toContain(
      "一覧を閉じて開き直してください。",
    ),
  );
  list.querySelector<HTMLButtonElement>("header button")!.click();
  dialogs.list();

  const header = list.querySelector("header")!;
  const close = header.querySelector("button")!;
  expect(header.querySelector("h2")?.textContent).toBe("保存した検索条件");
  expect(close.textContent).toBe("閉じる");
  close.focus();
  await vi.waitFor(() =>
    expect(list.querySelector("tbody tr")?.textContent).toContain(preset.name),
  );
  expect(document.activeElement).toBe(close);
  expect(list.querySelector(".preset-count")).toBeNull();
  expect([...list.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "閉じる",
    "呼び出し",
    "削除",
  ]);
  expect(list.querySelector('[role="alert"]')?.textContent).toContain(
    "一覧を閉じて開き直してください。",
  );

  close.click();
  expect(list.open).toBe(false);
  expect(document.activeElement).toBe(opener);
  dialogs.list();
  await vi.waitFor(() =>
    expect(list.querySelector("tbody tr")?.textContent).toContain(updated.name),
  );
  expect(transport.mock.calls.map(([path]) => path)).toEqual([
    "/form-answers/map-presets?page=1&page_size=20&versions=2",
    "/form-answers/map-presets?page=1&page_size=20&versions=2",
    "/form-answers/map-presets?page=1&page_size=20&versions=2",
  ]);
  expect(list.querySelector('[role="alert"]')).toBeNull();
});

it("絞り込み専用画面では色分けの呼び出しと適用を無効にする", async () => {
  const coloring = {
    ...preset,
    id: "colors",
    kind: "coloring",
    name: "写真による色分け",
    definition: {
      type: "color",
      common_form_id: "form",
      rules: [
        {
          id: "r",
          label: "写真あり",
          color: "#2166ac",
          conditions: manualDraft.definition.conditions,
        },
      ],
    },
  };
  const restore = vi.fn();
  const apply = vi.fn();
  const preparePage = vi.fn(
    async (_items: unknown[], signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const next = { ...preset, id: "next", name: "次の条件" };
  dialogs = createMapPresetDialogs(
    vi
      .fn()
      .mockResolvedValueOnce({ items: [preset, coloring], total: 21 })
      .mockResolvedValueOnce({ items: [next, coloring], total: 21 }),
    restore,
    { filterOnly: true, preparePage, apply },
  );
  dialogs.list();
  await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(2));
  const buttons = () => [
    ...document.querySelectorAll<HTMLButtonElement>("tbody tr button:first-child"),
  ];
  expect(buttons()[0]!.disabled).toBe(false);
  expect(buttons()[1]!.disabled).toBe(true);
  expect(buttons()[1]!.title).toContain("色分け条件を呼び出せません");
  buttons()[1]!.click();
  const applyButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>("[data-preset-apply-id]"),
  ];
  expect(applyButtons().map((button) => button.disabled)).toEqual([false, true]);
  expect(applyButtons()[1]!.title).toContain("色分け条件を適用できません");
  applyButtons()[1]!.click();
  expect(apply).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(preparePage).toHaveBeenCalledExactlyOnceWith([preset], expect.any(AbortSignal));
  click("次へ");
  await vi.waitFor(() => expect(document.querySelector("nav")?.textContent).toContain("2 / 2"));
  expect(buttons()[0]!.disabled).toBe(false);
  expect(buttons()[1]!.disabled).toBe(true);
  expect(applyButtons().map((button) => button.disabled)).toEqual([false, true]);
  expect(preparePage.mock.calls[0]![1].aborted).toBe(true);
  expect(preparePage).toHaveBeenLastCalledWith([next], expect.any(AbortSignal));
});

it("既存の再利用可能な定義を保存し、地図に適用せずに呼び出す", async () => {
  const transport = vi
      .fn()
      .mockResolvedValueOnce(preset)
      .mockResolvedValueOnce({ items: [preset], total: 1 }),
    restore = vi.fn();
  dialogs = createMapPresetDialogs(transport, restore);
  dialogs.save(manualDraft);
  document.querySelector<HTMLInputElement>("input")!.value = "画像あり";
  click("保存");
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(false),
  );
  expect(transport.mock.calls[0]![1]).toEqual({
    name: "画像あり",
    kind: "filter",
    schema_version: 2 as const,
    definition: preset.definition,
  });
  dialogs.list();
  await vi.waitFor(() => expect(document.body.textContent).toContain("写真 入力あり"));
  const key = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
  window.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  expect([...document.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
    "種別",
    "名前",
    "共通フォーム",
    "条件概要",
    "保存日時",
    "操作",
  ]);
  click("呼び出し");
  await vi.waitFor(() => expect(restore).toHaveBeenCalledWith(preset, expect.any(AbortSignal)));
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>('[aria-label="呼び出し完了"]')!.open).toBe(
      true,
    ),
  );
  expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(true);
  expect(document.querySelector<HTMLDialogElement>(".map-progress-dialog")!.open).toBe(false);
  expect(document.querySelector('[aria-label="呼び出し完了"]')?.textContent).toContain(
    "呼び出しが完了しました。",
  );
});

it("手動条件とAI複合条件を同じ呼び出し操作に揃え、AI定義を改変せず編集へ渡す", async () => {
  const ai = {
    ...preset,
    id: "ai-saved",
    name: "<img src=x onerror=alert(1)>",
    schema_version: 2,
    definition: {
      type: "filter",
      expression: {
        op: "or",
        children: [
          { op: "text", query1: "点検" },
          { op: "text", query1: "修繕" },
        ],
      },
    },
  };
  const transport = vi.fn().mockResolvedValue({ items: [preset, ai], total: 2 });
  const restore = vi.fn();
  dialogs = createMapPresetDialogs(transport, restore);
  dialogs.list();
  await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(2));
  expect(transport.mock.calls[0]![0]).toContain("versions=2");
  expect(document.querySelectorAll("tbody tr")[1]!.textContent).toContain("点検");
  expect(document.querySelectorAll("tbody tr")[1]!.textContent).toContain(" または ");
  expect(document.querySelector("tbody img")).toBeNull();
  const row = document.querySelectorAll("tbody tr")[1]!;
  const recall = row.querySelector<HTMLButtonElement>("button")!;
  expect(recall.textContent).toBe("呼び出し");
  expect(document.querySelectorAll("tbody tr")[0]!.querySelector("button")!.textContent).toBe(
    "呼び出し",
  );
  recall.click();
  await vi.waitFor(() => expect(restore).toHaveBeenCalledWith(ai, expect.any(AbortSignal)));
  expect(restore.mock.calls[0]![0]).not.toBe(ai);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("実行ボタンで地図に反映します。"),
  );
});

it("復元待ちや復元失敗時も一覧と入力中の内容を維持し、再試行できる", async () => {
  let fail!: (error: Error) => void;
  const restore = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_yes, no) => {
          fail = no;
        }),
    )
    .mockResolvedValue(undefined);
  dialogs = createMapPresetDialogs(
    vi.fn().mockResolvedValue({ items: [preset], total: 1 }),
    restore,
  );
  dialogs.list();
  await vi.waitFor(() => expect(document.querySelector("tbody tr")).not.toBeNull());
  click("呼び出し");
  expect(document.querySelector<HTMLDialogElement>(".map-progress-dialog")!.open).toBe(true);
  expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(true);
  fail(Error("復元できませんでした"));
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>(".map-progress-dialog")!.open).toBe(false),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("復元できませんでした");
  expect(document.querySelector("tbody tr")?.textContent).toContain("画像あり");
  click("呼び出し");
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>('[aria-label="呼び出し完了"]')!.open).toBe(
      true,
    ),
  );
  document.querySelector<HTMLButtonElement>('[aria-label="呼び出し完了"] button')!.click();
  expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("tbody button")!.disabled).toBe(false);
});
it("開き直す前の古い一覧応答を反映せず、現在のダイアログを維持する", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const transport = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ items: [], total: 0 });
  dialogs = createMapPresetDialogs(transport, vi.fn());
  dialogs.list();
  dialogs.close();
  dialogs.list();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存した検索条件はありません"),
  );
  resolve({ items: [preset], total: 1 });
  await new Promise((done) => setTimeout(done, 0));
  expect(document.body.textContent).not.toContain("画像あり");
});

it("Escapeでは削除確認だけを閉じ、削除失敗後に再試行できる", async () => {
  let reject!: (error: Error) => void;
  const transport = vi.fn(
    async (_path: string, _body: unknown, _signal: AbortSignal, method?: string) => {
      if (method === "DELETE")
        return new Promise((_resolve, no) => {
          reject = no;
        });
      return { items: [preset], total: 1 };
    },
  );
  dialogs = createMapPresetDialogs(transport, vi.fn());
  dialogs.list();
  await vi.waitFor(() => expect(document.querySelector("tbody tr")).not.toBeNull());
  click("削除");
  const confirmation = document.querySelector<HTMLDialogElement>(".is-confirm")!;
  expect(confirmation.open).toBe(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(confirmation.open).toBe(false);
  expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);

  click("削除");
  confirmation.querySelector<HTMLButtonElement>('[aria-label="削除"]')!.click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(confirmation.open).toBe(true);
  expect([...confirmation.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  reject(Error("削除できませんでした"));
  await vi.waitFor(() => expect(confirmation.open).toBe(false));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("削除できませんでした");
  expect(document.querySelector("tbody tr")?.textContent).toContain("画像あり");
  expect(document.querySelector<HTMLButtonElement>("tbody button")!.disabled).toBe(false);
});
