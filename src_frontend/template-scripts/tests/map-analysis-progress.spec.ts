import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdvancedMapSearchModal } from "../src/map/common/advanced-map-search";
import { awaitWithAbort } from "../src/map/common/progress-spinner";

let modal: ReturnType<typeof createAdvancedMapSearchModal>;
const fields = [{ id: "n", label: "年数", field_type: "number", choices: [] }];
const specification = {
  common_form_id: "form",
  rules: [
    {
      id: "r",
      label: "分類",
      color: "#123456",
      conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "1", upper: null }],
    },
  ],
};
const result = {
  forms: [{ id: "form", label: "設備" }],
  fields,
  as_of: "2026-11-02T00:00:00Z",
  targets: ["marker:one"],
  target_count: 1,
  answer_count: 1,
};
const pending = () => {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const click = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!
    .click();
const spinner = () => document.querySelector<HTMLDialogElement>(".map-progress-dialog")!.open;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  modal?.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});
type Options = Parameters<typeof createAdvancedMapSearchModal>[0];
function create(
  onApply: Options["onApply"] = vi.fn(),
  colorApply: NonNullable<Options["analysis"]>["apply"] = vi.fn(),
  transport: Options["transport"] = vi.fn(async (path: string) =>
    path === "/common-forms"
      ? [{ id: "form", version: 1, form_title: "設備", form_schema: { fields: [] } }]
      : result,
  ),
) {
  modal = createAdvancedMapSearchModal({
    transport,
    getApplied: () => ({
      common_form_id: "form",
      definition_version: 1,
      layer_ids: null,
      conditions: [],
    }),
    getLayerIds: () => null,
    getContext: () => "same",
    onApply,
    analysis: { getSpecification: () => specification, getColoring: () => null, apply: colorApply },
  });
}
it("地図への反映が完了するまで既存のスピナーを表示し、色分けの見出しを常に表示する", async () => {
  const search = pending(),
    color = pending(),
    apply = vi.fn(() => search.promise),
    colorApply = vi.fn(() => color.promise);
  create(apply, colorApply);
  await modal.open();
  expect(document.querySelector(".advanced-map-search")?.getAttribute("aria-label")).toBe(
    "詳しい検索と色分け",
  );
  expect(document.querySelector(".attribute-color-pane details")).toBeNull();
  expect(document.querySelector(".attribute-color-pane h3")?.textContent).toBe("地図で色分け");
  click("絞り込み実行");
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(spinner()).toBe(true);
  expect(document.querySelector(".map-progress-dialog svg circle")?.getAttribute("stroke")).toBe(
    "#76c7c0",
  );
  click("絞り込み実行");
  expect(apply).toHaveBeenCalledTimes(1);
  search.resolve();
  await vi.waitFor(() => expect(spinner()).toBe(false));
  const notice = document.querySelector<HTMLDialogElement>('[aria-label="絞り込み完了"]')!;
  expect(notice.open).toBe(true);
  expect(notice.textContent).toContain("絞り込みが完了しました。");
  expect(document.activeElement).toBe(notice.querySelector("button"));
  const print = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
  window.dispatchEvent(print);
  expect(print.defaultPrevented).toBe(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(notice.open).toBe(false);
  expect(document.querySelector<HTMLDialogElement>(".advanced-map-search")!.open).toBe(true);
  expect(document.activeElement?.textContent).toBe("絞り込み実行");
  click("色分け実行");
  await vi.waitFor(() => expect(colorApply).toHaveBeenCalledOnce());
  expect(spinner()).toBe(true);
  color.reject(Error("反映できませんでした"));
  await vi.waitFor(() => expect(spinner()).toBe(false));
  expect(document.querySelector(".color-error")?.textContent).toContain("反映できませんでした");
  expect(document.querySelector<HTMLDialogElement>('[aria-label="色分け完了"]')).toBeNull();
});
it("通信処理が中断に対応していなくてもタイムアウト時にスピナーを閉じる", async () => {
  vi.useFakeTimers();
  const apply = vi.fn();
  const transport = vi.fn(async (path: string, body: unknown) => {
    if (path === "/common-forms")
      return [{ id: "form", version: 1, form_title: "設備", form_schema: { fields: [] } }];
    if ((body as { options_only?: boolean }).options_only) return result;
    return new Promise(() => {});
  });
  create(apply, vi.fn(), transport);
  await modal.open();
  click("絞り込み実行");
  expect(spinner()).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(spinner()).toBe(false);
  expect(document.querySelector(".attribute-error")?.textContent).toContain("再試行");
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector(".map-message-dialog[open]")).toBeNull();
  const canceled = new AbortController();
  canceled.abort();
  await expect(
    awaitWithAbort(Promise.reject(Error("late failure")), canceled.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("色分けの地図反映が完了してから通知し、閉じた後に届いた完了通知は表示しない", async () => {
  const color = pending(),
    apply = vi.fn(() => color.promise);
  create(vi.fn(), apply);
  await modal.open();
  click("色分け実行");
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(spinner()).toBe(true);
  expect(document.querySelector(".map-message-dialog[open]")).toBeNull();
  color.resolve();
  await vi.waitFor(() => expect(spinner()).toBe(false));
  const notice = document.querySelector<HTMLDialogElement>('[aria-label="色分け完了"]')!;
  expect(notice.open).toBe(true);
  expect(notice.textContent).toContain("色分けが完了しました。");
  notice.querySelector<HTMLButtonElement>("button")!.click();
  expect(document.activeElement?.textContent).toBe("色分け実行");
  modal.dispose();
  const late = pending(),
    lateApply = vi.fn(() => late.promise);
  create(vi.fn(), lateApply);
  await modal.open();
  click("色分け実行");
  await vi.waitFor(() => expect(lateApply).toHaveBeenCalledOnce());
  modal.close();
  late.resolve();
  await new Promise((done) => setTimeout(done, 0));
  expect(document.querySelector(".map-message-dialog[open]")).toBeNull();
});
