import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdvancedMapSearchModal,
  type AttributeTransport,
} from "../src/map/common/advanced-map-search";
import type { AiDefinition } from "../src/ai/types";
import type { AnySavedMapPreset, SavedAiMapPreset } from "../src/map/common/answer-map-presets";

const forms = [
  {
    id: "first",
    version: 2,
    form_title: "施設台帳",
    form_schema: { fields: [{ id: "n", label: "金額", type: "number" }] },
  },
  {
    id: "second",
    version: 3,
    form_title: "点検",
    form_schema: { fields: [{ id: "done", label: "完了", type: "checkbox" }] },
  },
];
const fields = {
  first: [{ id: "n", label: "金額", field_type: "number", choices: [] }],
  second: [{ id: "done", label: "完了", field_type: "checkbox", choices: [] }],
};
function filter(name = "複合条件の原本"): SavedAiMapPreset {
  return {
    id: "ai-filter",
    kind: "filter",
    schema_version: 2,
    name,
    create_at: "2026-11-17T00:00:00Z",
    display: { form_label: "施設台帳 / 点検", fields: [] },
    definition: {
      type: "filter",
      expression: {
        op: "or",
        children: [
          { op: "text", query1: "学校" },
          {
            op: "and",
            children: [
              {
                op: "attribute",
                common_form_id: "first",
                conditions: [
                  {
                    field_id: "n",
                    field_type: "number",
                    op: "gte",
                    value: "9007199254740993.0000000000001",
                  },
                ],
              },
              {
                op: "not",
                child: {
                  op: "attribute",
                  common_form_id: "second",
                  conditions: [
                    { field_id: "done", field_type: "checkbox", op: "eq", value: false },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  };
}
function coloring(): SavedAiMapPreset {
  return {
    id: "ai-coloring",
    kind: "coloring",
    schema_version: 2,
    name: "分類の原本",
    create_at: "2026-11-17T00:00:00Z",
    display: { form_label: "施設台帳", fields: [] },
    definition: {
      type: "color",
      common_form_id: "first",
      rules: [
        {
          id: "high",
          label: "高額",
          color: "#223344",
          conditions: [
            { field_id: "n", field_type: "number", op: "gte", value: "12345678901234567890.12345" },
          ],
        },
        { id: "other", label: "その他", color: "#aabbcc", conditions: [] },
      ],
    },
  };
}
const fixtures: ReturnType<typeof createAdvancedMapSearchModal>[] = [];
const main = () => document.querySelector<HTMLDialogElement>(".advanced-map-search")!;
function button(text: string, host: ParentNode = main()) {
  const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (control) => control.textContent === text || control.getAttribute("aria-label") === text,
  );
  expect(value, `「${text}」ボタンが存在する`).toBeDefined();
  return value!;
}
function change(text: string) {
  const control = main().querySelector<HTMLInputElement>('input[aria-label="検索語1"]')!;
  control.value = text;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function mount(
  options: {
    analysis?: boolean;
    transport?: AttributeTransport;
    getContext?: () => string;
    getAiContextKey?: () => string;
    apply?: (definition: AiDefinition, signal: AbortSignal) => Promise<void>;
    clear?: (kind: "filter" | "color", signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const defaultTransport: AttributeTransport = async (path, body) => {
    if (path === "/common-forms") return forms;
    if (path === "/form-answers/map-filter") {
      const id = (body as { common_form_id: keyof typeof fields | null }).common_form_id;
      return {
        forms: forms.map((form) => ({ id: form.id, label: form.form_title })),
        fields: id ? (fields[id] ?? []) : [],
      };
    }
    if (path === "/map-objects/search/attributes") {
      const request = body as { common_form_id: string; definition_version: number };
      return {
        common_form_id: request.common_form_id,
        definition_version: request.definition_version,
        as_of: "2026-11-17T00:00:00Z",
        marker_ids: ["marker-one"],
        shape_ids: [],
        target_count: 1,
      };
    }
    if (path === "/form-answers/map-presets" && body) {
      const request = body as Record<string, unknown>;
      return {
        id: "new-saved-condition",
        create_at: "2026-11-17T00:00:00Z",
        display: { form_label: "施設台帳", fields: [] },
        ...request,
      };
    }
    throw Error(`想定しない通信: ${path}`);
  };
  const transport = vi.fn(options.transport ?? defaultTransport);
  const apply = vi.fn(options.apply ?? (async () => undefined));
  const clear = vi.fn(options.clear ?? (async () => undefined));
  const onApply = vi.fn();
  const analysisApply = vi.fn(async () => undefined);
  const modal = createAdvancedMapSearchModal({
    transport,
    getApplied: () => null,
    getLayerIds: () => ["current-layer"],
    getContext: options.getContext ?? (() => "account:layer:generation"),
    getAiContextKey: options.getAiContextKey,
    savedFilters: true,
    applyAiDefinition: apply,
    clearAiDefinition: clear,
    onApply,
    ...(options.analysis
      ? {
          analysis: { getSpecification: () => null, getColoring: () => null, apply: analysisApply },
        }
      : {}),
  });
  fixtures.push(modal);
  return { modal, transport, apply, clear, onApply, analysisApply, defaultTransport };
}
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
  fixtures.splice(0).forEach((modal) => modal.dispose());
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("保存したAI条件の呼び出しと明示実行", () => {
  it("取得失敗時だけ再試行を表示し、復旧・実行前の再検証でも複合条件と編集を保持する", async () => {
    let fail = true;
    const base = mount();
    base.modal.dispose();
    const { modal, transport, apply } = mount({
      transport: async (...args) => {
        if (fail && args[0] === "/form-answers/map-filter") throw Error("項目情報の取得失敗");
        return base.defaultTransport(...args);
      },
    });
    const source = filter();
    const original = structuredClone(source);
    await modal.recallPreset(source);
    expect(main().textContent).not.toContain("条件の種類・組合せを変更");
    expect(main().textContent).not.toContain("組合せに条件を追加");
    expect(main().textContent).not.toContain("項目情報を再読み込み");
    expect(button("再試行").disabled).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    change("再試行後も保持する編集");
    fail = false;
    button("再試行").click();
    await vi.waitFor(() =>
      expect(
        [...main().querySelectorAll("button")].some((control) => control.textContent === "再試行"),
      ).toBe(false),
    );
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty(
      "value",
      "再試行後も保持する編集",
    );
    expect(apply).not.toHaveBeenCalled();
    const beforeExecution = transport.mock.calls.filter(
      ([path]) => path === "/form-answers/map-filter",
    ).length;
    button("絞り込み実行").click();
    const expected = structuredClone(source.definition) as Record<string, any>;
    expected.expression.children[0].query1 = "再試行後も保持する編集";
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(expected, expect.any(AbortSignal)));
    expect(
      transport.mock.calls.filter(([path]) => path === "/form-answers/map-filter").length,
    ).toBeGreaterThan(beforeExecution);
    expect(source).toEqual(original);
  });

  it("手動設定と同じ配置の実行・解除・保存を表示し、切替操作は折り畳む", async () => {
    const { modal } = mount({ analysis: true });
    await modal.recallPreset(filter());
    await modal.recallPreset(coloring());
    const filterActions = main().querySelector(
      ".attribute-filter-pane > .attribute-filter-actions",
    )!;
    expect([...filterActions.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "絞り込み実行",
      "属性条件を解除",
      "検索条件を保存",
    ]);
    const colorActions = main().querySelector(".attribute-color-pane .ai-color-actions")!;
    expect([...colorActions.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "色分け実行",
      "検索条件を保存",
    ]);
    expect(colorActions.closest(".map-coloring-editor")).not.toBeNull();
    expect(colorActions.querySelector(".color-submit")).not.toBeNull();
    expect(colorActions.querySelector(".color-save")).not.toBeNull();
    for (const extra of main().querySelectorAll<HTMLDetailsElement>(".ai-editor-extra"))
      expect(extra.open).toBe(false);
    expect(button("色分け解除").closest(".ai-condition-editor")).not.toBeNull();
  });

  it.each(["filter", "color"] as const)(
    "%sの解除は専用経路を一度だけ呼び、元の定義と編集下書きを保持する",
    async (kind) => {
      const pending = deferred<void>();
      const { modal, clear, apply, onApply, analysisApply } = mount({
        analysis: true,
        clear: () => pending.promise,
      });
      const sources = [filter(), coloring()];
      const original = structuredClone(sources);
      for (const source of sources) await modal.recallPreset(source);
      change("解除後も残す編集");
      const control = button(kind === "filter" ? "属性条件を解除" : "色分け解除");
      control.click();
      control.click();
      await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
      expect(clear).toHaveBeenCalledWith(kind, expect.any(AbortSignal));
      expect(modal.isBusy()).toBe(true);
      expect(main().querySelector('input[aria-label="検索語1"]')!.matches(":disabled")).toBe(true);
      pending.resolve();
      await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
      expect(main().textContent).toContain("適用を解除しました");
      expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty(
        "value",
        "解除後も残す編集",
      );
      expect(main().querySelector('input[aria-label="分類名"]')).toHaveProperty("value", "高額");
      expect(apply).not.toHaveBeenCalled();
      expect(onApply).not.toHaveBeenCalled();
      expect(analysisApply).not.toHaveBeenCalled();
      expect(sources).toEqual(original);
    },
  );

  it("解除に失敗しても複合条件と編集を保持し、閉じた画面の解除を中止する", async () => {
    let fail = true;
    let clearSignal: AbortSignal | undefined;
    const pending = deferred<void>();
    const { modal, clear } = mount({
      clear: async (_kind, signal) => {
        clearSignal = signal;
        if (fail) throw Error("解除を確認できませんでした。");
        await pending.promise;
      },
    });
    await modal.recallPreset(filter());
    change("解除失敗でも保持");
    button("属性条件を解除").click();
    await vi.waitFor(() => expect(main().textContent).toContain("解除を確認できませんでした"));
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty(
      "value",
      "解除失敗でも保持",
    );
    fail = false;
    button("属性条件を解除").click();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(2));
    modal.close();
    expect(clearSignal?.aborted).toBe(true);
    pending.resolve();
    await Promise.resolve();
    expect(main().open).toBe(false);
  });

  it("OR・NOT・複数フォームを下書きに呼び出し、一つの値を編集してから実行する", async () => {
    const source = filter();
    const original = structuredClone(source);
    const { modal, apply, onApply, transport } = mount();
    await modal.recallPreset(source);
    expect(main().open).toBe(true);
    expect(main().textContent).toContain("呼び出した条件は未反映");
    expect(main().querySelectorAll('[data-operation="or"]')).toHaveLength(1);
    expect(main().querySelectorAll('[data-operation="not"]')).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(transport.mock.calls.every(([path]) => !path.startsWith("/ai/"))).toBe(true);
    change("教育施設");
    expect(apply).not.toHaveBeenCalled();
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const expected = structuredClone(source.definition) as Record<string, any>;
    expected.expression.children[0].query1 = "教育施設";
    expect(apply).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
    await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
    expect(onApply).not.toHaveBeenCalled();
    expect(source).toEqual(original);
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty("value", "教育施設");
  });

  it("色分けの分類順を編集して実行し、その定義をversion2で名前を付けて保存する", async () => {
    const source = coloring();
    const original = structuredClone(source);
    const { modal, apply, analysisApply, transport } = mount({ analysis: true });
    await modal.recallPreset(source);
    expect(apply).not.toHaveBeenCalled();
    expect(analysisApply).not.toHaveBeenCalled();
    button("分類を下へ").click();
    const expected = {
      ...source.definition,
      rules: [...(source.definition.rules as object[])].reverse(),
    };
    button("色分け実行").click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(expected, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
    const completed = document.querySelector<HTMLDialogElement>('dialog[aria-label="色分け完了"]');
    if (completed?.open) button("閉じる", completed).click();
    button("検索条件を保存", main().querySelector(".attribute-color-pane")!).click();
    const save = document.querySelector<HTMLDialogElement>('dialog[aria-label="検索条件を保存"]')!;
    save.querySelector<HTMLInputElement>('input[aria-label="条件名"]')!.value = "編集した分類";
    button("保存", save).click();
    await vi.waitFor(() =>
      expect(
        transport.mock.calls.some(([path, body]) => path === "/form-answers/map-presets" && !!body),
      ).toBe(true),
    );
    const saved = transport.mock.calls.find(
      ([path, body]) => path === "/form-answers/map-presets" && !!body,
    )![1];
    expect(saved).toEqual({
      schema_version: 2,
      kind: "coloring",
      name: "編集した分類",
      definition: expected,
    });
    expect(source).toEqual(original);
  });

  it.each(["filter", "color"] as const)(
    "%sの実行中は両下書きを保護し、完了後にもう一方を編集・実行できる",
    async (firstKind) => {
      const pending = deferred<void>();
      let count = 0;
      const { modal, apply } = mount({
        analysis: true,
        apply: async () => {
          if (++count === 1) await pending.promise;
        },
      });
      const savedFilter = filter();
      const savedColor = coloring();
      const originals = structuredClone([savedFilter, savedColor]);
      await modal.recallPreset(savedFilter);
      await modal.recallPreset(savedColor);
      const inputFor = (kind: "filter" | "color") =>
        main().querySelector<HTMLInputElement>(
          kind === "filter"
            ? '.ai-condition-editor input[aria-label="検索語1"]'
            : '.ai-condition-editor input[aria-label="分類名"]',
        )!;
      for (const kind of ["filter", "color"] as const) {
        expect(inputFor(kind).disabled).toBe(false);
        expect(inputFor(kind).matches(":disabled")).toBe(false);
      }
      const secondKind = firstKind === "filter" ? "color" : "filter";
      const execute = (kind: "filter" | "color") =>
        button(kind === "filter" ? "絞り込み実行" : "色分け実行").click();
      execute(firstKind);
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
      expect(modal.isBusy()).toBe(true);
      expect(inputFor(secondKind).matches(":disabled")).toBe(true);
      pending.resolve();
      await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
      const completed = document.querySelector<HTMLDialogElement>(
        `dialog[aria-label="${firstKind === "filter" ? "絞り込み完了" : "色分け完了"}"]`,
      );
      if (completed?.open) button("閉じる", completed).click();
      for (const kind of ["filter", "color"] as const) {
        // fieldsetの解除だけでなく、子inputへ残留するdisabled属性も検出する。
        expect(inputFor(kind).disabled).toBe(false);
        expect(inputFor(kind).matches(":disabled")).toBe(false);
      }
      const input = inputFor(secondKind);
      input.value = "完了後に編集した内容";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      execute(secondKind);
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
      expect(apply.mock.calls[0]![0]).toEqual(
        firstKind === "filter" ? savedFilter.definition : savedColor.definition,
      );
      const expected = structuredClone(
        secondKind === "filter" ? savedFilter.definition : savedColor.definition,
      ) as Record<string, any>;
      if (secondKind === "filter") expected.expression.children[0].query1 = "完了後に編集した内容";
      else expected.rules[0].label = "完了後に編集した内容";
      expect(apply.mock.calls[1]![0]).toEqual(expected);
      expect([savedFilter, savedColor]).toEqual(originals);
    },
  );

  it("欠落した項目を消さずに示し、実行ボタンからも部分的に適用しない", async () => {
    const source = filter();
    const base = mount();
    const missing = mount({
      transport: async (path, body, signal, method) =>
        path === "/form-answers/map-filter"
          ? { fields: [], forms: [] }
          : base.defaultTransport(path, body, signal, method),
    });
    // 同じ文書に複数モーダルを置かず、対象の描画を一意にする。
    base.modal.dispose();
    await missing.modal.recallPreset(source);
    expect(main().querySelector('input[aria-label="値"]')).toHaveProperty(
      "value",
      "9007199254740993.0000000000001",
    );
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(main().textContent).toContain("項目または型が見つかりません"));
    expect(missing.apply).not.toHaveBeenCalled();
    expect(missing.onApply).not.toHaveBeenCalled();
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty("value", "学校");
  });

  it("実行に失敗しても編集内容を残し、再試行で同じ条件を渡す", async () => {
    let fail = true;
    const { modal, apply } = mount({
      apply: async () => {
        if (fail) throw Error("反映を確認できませんでした。");
      },
    });
    await modal.recallPreset(filter());
    change("再試行用の編集");
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(main().textContent).toContain("反映を確認できませんでした"));
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty(
      "value",
      "再試行用の編集",
    );
    expect(modal.isBusy()).toBe(false);
    fail = false;
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]![0]).toEqual(apply.mock.calls[0]![0]);
  });

  it("連続クリックを一つの実行にまとめ、閉じた画面の要求を中止する", async () => {
    const pending = deferred<void>();
    let executionSignal: AbortSignal | undefined;
    const { modal, apply } = mount({
      apply: async (_definition, signal) => {
        executionSignal = signal;
        await pending.promise;
      },
    });
    await modal.recallPreset(filter());
    const submit = button("絞り込み実行");
    submit.click();
    submit.click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    modal.close();
    expect(executionSignal?.aborted).toBe(true);
    pending.resolve();
    await Promise.resolve();
    expect(main().open).toBe(false);
    expect(
      document.querySelector<HTMLDialogElement>('dialog[aria-label="絞り込み完了"]')?.open,
    ).not.toBe(true);
  });

  it("反映の期限切れ後も下書きを残し、完了として扱わない", async () => {
    const { modal, apply } = mount({ apply: () => new Promise<void>(() => undefined) });
    await modal.recallPreset(filter());
    change("期限切れでも残る編集");
    vi.useFakeTimers();
    button("絞り込み実行").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180001);
    expect(modal.isBusy()).toBe(false);
    expect(main().textContent).toContain("編集内容は保持");
    expect(main().querySelector('input[aria-label="検索語1"]')).toHaveProperty(
      "value",
      "期限切れでも残る編集",
    );
    expect(
      document.querySelector<HTMLDialogElement>('dialog[aria-label="絞り込み完了"]')?.open,
    ).not.toBe(true);
  });

  it.each(["account", "layer"])("open待機中の%s切替後に古い条件を呼び出さない", async (kind) => {
    const first = deferred<unknown>();
    let context = "old-account:old-layer";
    let wait = true;
    const base = mount();
    base.modal.dispose();
    const { modal, apply } = mount({
      getContext: () => context,
      transport: async (...args) => {
        if (args[0] === "/common-forms" && wait) {
          wait = false;
          return first.promise;
        }
        return base.defaultTransport(...args);
      },
    });
    const recall = modal.recallPreset(filter("旧対象だけの保存名"));
    await Promise.resolve();
    context = kind === "account" ? "new-account:old-layer" : "old-account:new-layer";
    await modal.open();
    first.resolve(forms);
    await recall;
    expect(main().textContent).not.toContain("旧対象だけの保存名");
    expect(main().querySelector(".ai-condition-editor")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("同じ対象で閉じて開き直しても、以前のopen待機応答を採用しない", async () => {
    const first = deferred<unknown>();
    let wait = true;
    const base = mount();
    base.modal.dispose();
    const { modal } = mount({
      transport: async (...args) => {
        if (args[0] === "/common-forms" && wait) {
          wait = false;
          return first.promise;
        }
        return base.defaultTransport(...args);
      },
    });
    const recall = modal.recallPreset(filter("閉じる前だけの保存名"));
    await Promise.resolve();
    modal.close();
    await modal.open();
    first.resolve(forms);
    await recall;
    expect(main().textContent).not.toContain("閉じる前だけの保存名");
    expect(main().querySelector(".ai-condition-editor")).toBeNull();
  });

  it("項目情報の待機中に対象が変わった場合も旧下書きを破棄する", async () => {
    const delayed = deferred<unknown>();
    let context = "old-account:same-layer";
    let wait = false;
    const base = mount();
    base.modal.dispose();
    const { modal, apply } = mount({
      getContext: () => context,
      transport: async (...args) => {
        if (wait && args[0] === "/form-answers/map-filter") {
          wait = false;
          return delayed.promise;
        }
        return base.defaultTransport(...args);
      },
    });
    await modal.open();
    wait = true;
    const recall = modal.recallPreset(filter("対象変更前だけの保存名"));
    // 拒否を先に監視し、遅延要求の検証自体で未処理rejectを作らない。
    const failure = recall.catch((error: unknown) => error);
    await vi.waitFor(() => expect(main().querySelector(".ai-condition-editor")).not.toBeNull());
    context = "new-account:same-layer";
    delayed.resolve({ fields: fields.first });
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(main().open).toBe(false);
    expect(main().querySelector(".ai-condition-editor")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    await modal.open();
    expect(main().textContent).not.toContain("対象変更前だけの保存名");
    expect(main().querySelector(".ai-condition-editor")).toBeNull();
  });

  it("同じ対象の手動再評価世代が進んでもAIの編集内容と成功した反映を保持する", async () => {
    let revision = 0;
    const { modal, apply } = mount({
      getContext: () => `manual:${revision}`,
      getAiContextKey: () => "same-account:layer:generation",
      apply: async () => {
        ++revision;
      },
    });
    await modal.recallPreset(filter());
    change("編集した条件");
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(main().textContent).toContain("条件を地図へ反映しました。"));
    expect(main().open).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(main().querySelector<HTMLInputElement>('input[aria-label="検索語1"]')!.value).toBe(
      "編集した条件",
    );
    expect(main().textContent).toContain("複合条件の原本");
  });

  it("version1は従来の編集欄へ復元し、通常の実行ボタンで反映する", async () => {
    const source: AnySavedMapPreset = {
      id: "legacy",
      kind: "filter",
      name: "以前の保存条件",
      schema_version: 1,
      create_at: "2026-11-17T00:00:00Z",
      display: { form_label: "施設台帳", fields: [] },
      definition: {
        common_form_id: "first",
        conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "9" }],
      },
    };
    const { modal, onApply, apply } = mount();
    await modal.recallPreset(source);
    expect(main().querySelector(".ai-condition-editor")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    button("絞り込み実行").click();
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      common_form_id: "first",
      conditions: source.definition.conditions,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
