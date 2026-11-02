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
const preset = {
  id: "saved",
  kind: "filter" as const,
  schema_version: 1,
  name: "画像あり",
  definition: {
    common_form_id: "form",
    conditions: [
      { field_id: "photo", field_type: "image", op: "filled", value: null, upper: null },
    ],
  },
  display: { form_label: "設備", fields: [{ id: "photo", field_type: "image", label: "写真" }] },
  create_at: "2026-10-30T00:00:00Z",
};
const click = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === text)!
    .click();
it("既存の再利用可能な定義を保存し、地図に適用せずに呼び出す", async () => {
  const transport = vi
      .fn()
      .mockResolvedValueOnce(preset)
      .mockResolvedValueOnce({ items: [preset], total: 1 }),
    restore = vi.fn();
  dialogs = createMapPresetDialogs(transport, restore);
  dialogs.save(preset);
  document.querySelector<HTMLInputElement>("input")!.value = "画像あり";
  click("保存");
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>(".form-settings")!.open).toBe(false),
  );
  expect(transport.mock.calls[0]![1]).toEqual({
    name: "画像あり",
    kind: "filter",
    schema_version: 1,
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
