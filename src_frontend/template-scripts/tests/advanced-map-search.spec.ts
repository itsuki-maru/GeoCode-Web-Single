import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SavedMapPreset } from "../src/map/common/answer-map-presets";
import { LocalPresetData } from "../src/map/common/local-preset";
import {
  attributeOperations,
  createAdvancedMapSearchModal,
  validateAttributeResult,
} from "../src/map/common/advanced-map-search";

const forms = [
  {
    id: "form",
    version: 2,
    form_title: "設備",
    form_schema: {
      fields: [
        { id: "n", label: "年数", type: "number" },
        { id: "flag", label: "確認", type: "checkbox" },
        { id: "image", label: "写真", type: "image" },
      ],
    },
  },
];
const request = { common_form_id: "form", definition_version: 2, layer_ids: null, conditions: [] };
const result = {
  common_form_id: "form",
  definition_version: 2,
  as_of: "2026-10-30T00:00:00Z",
  marker_ids: [],
  shape_ids: [],
  target_count: 0,
};
const click = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === text)!
    .click();
let modal: ReturnType<typeof createAdvancedMapSearchModal>;
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

describe("AI保存条件の呼び出しと明示実行", () => {
  const preset = {
    id: "saved-ai",
    kind: "filter",
    name: "関連語",
    schema_version: 2,
    definition: {
      type: "filter",
      expression: {
        op: "or",
        children: [
          { op: "text", query1: "学校" },
          { op: "text", query1: "教育" },
        ],
      },
    },
    display: { form_label: null, fields: [] },
    create_at: "2026-11-16T00:00:00Z",
  };
  it.each([false, true])(
    "手動の下書きを保持し、呼び出し後の実行ボタンから反映する（実行失敗=%s）",
    async (fails) => {
      const apply = vi.fn();
      const applyAiDefinition = vi.fn(async () => {
        if (fails) throw Error("検索結果を取得できませんでした。");
      });
      const transport = vi.fn(async (path: string) => {
        if (path === "/common-forms") return forms;
        if (path.startsWith("/form-answers/map-presets")) return { items: [preset], total: 1 };
        throw Error("unexpected request: " + path);
      });
      modal = createAdvancedMapSearchModal({
        transport,
        savedFilters: true,
        getApplied: () => ({
          ...request,
          conditions: [{ field_id: "n", field_type: "number", op: "eq", value: "7" }],
        }),
        getLayerIds: () => null,
        getContext: () => "account",
        onApply: apply,
        applyAiDefinition,
      });
      await modal.open();
      click("保存した検索条件");
      await vi.waitFor(() => expect(document.querySelector("tbody tr")).not.toBeNull());
      click("呼び出し");
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLDialogElement>('[aria-label="呼び出し完了"]')?.open).toBe(
          true,
        ),
      );
      expect(applyAiDefinition).not.toHaveBeenCalled();
      expect(transport.mock.calls.some(([path]) => path === "/ai/capabilities")).toBe(false);
      document.querySelector<HTMLButtonElement>('[aria-label="呼び出し完了"] button')!.click();
      [...document.querySelectorAll<HTMLButtonElement>(".map-preset-dialog.form-settings button")]
        .find((button) => button.textContent === "閉じる")!
        .click();
      click("絞り込み実行");
      if (!fails) {
        await vi.waitFor(() =>
          expect(applyAiDefinition).toHaveBeenCalledWith(
            preset.definition,
            expect.any(AbortSignal),
          ),
        );
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("条件を地図へ反映しました。"),
        );
      } else {
        await vi.waitFor(() =>
          expect(document.querySelector('[role="alert"]')?.textContent).toContain(
            "検索結果を取得できませんでした。",
          ),
        );
      }
      expect(apply).not.toHaveBeenCalled();
      click("手動の絞り込み条件を編集");
      expect(document.querySelector<HTMLInputElement>(".advanced-map-search input")!.value).toBe(
        "7",
      );
    },
  );

  it("項目情報の取得中に対象が変わった場合は古い保存条件を表示・適用しない", async () => {
    let context = "old";
    let resolve!: (value: unknown) => void;
    const applyAiDefinition = vi.fn();
    const transport = vi.fn(async (path: string) => {
      if (path === "/common-forms") return forms;
      if (path === "/form-answers/map-filter")
        return new Promise((done) => {
          resolve = done;
        });
      return {
        items: [
          {
            ...preset,
            definition: {
              type: "filter",
              expression: {
                op: "attribute",
                common_form_id: "form",
                conditions: [],
              },
            },
          },
        ],
        total: 1,
      };
    });
    modal = createAdvancedMapSearchModal({
      transport,
      savedFilters: true,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => context,
      onApply: vi.fn(),
      applyAiDefinition,
    });
    await modal.open();
    click("保存した検索条件");
    await vi.waitFor(() => expect(document.querySelector("tbody tr")).not.toBeNull());
    click("呼び出し");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    context = "new";
    resolve({ fields: [] });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>(".advanced-map-search")!.open).toBe(false),
    );
    expect(document.querySelector(".ai-condition-editor")).toBeNull();
    expect(applyAiDefinition).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  modal?.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("advanced map search", () => {
  const savedFilter: SavedMapPreset = {
    id: "saved",
    kind: "filter",
    schema_version: 2,
    name: "年数50年以上",
    definition: {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "form",
        conditions: [{ field_id: "n", field_type: "number", op: "gte", value: "50" }],
      },
    },
    display: { form_label: "設備", fields: [{ id: "n", field_type: "number", label: "年数" }] },
    create_at: "2026-11-05T00:00:00Z",
  };
  const savedList = () =>
    document.querySelector<HTMLDialogElement>(".map-preset-dialog.form-settings")!;
  const openSavedFilter = async () => {
    click("保存した検索条件");
    await vi.waitFor(() => expect(savedList().querySelector("tbody tr")).not.toBeNull());
    savedList().querySelector<HTMLButtonElement>("tbody button")!.click();
  };
  const closeSavedFilter = () => {
    document.querySelector<HTMLButtonElement>('[aria-label="呼び出し完了"] button')!.click();
    [...savedList().querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "閉じる")!
      .click();
  };

  const metadata = { fields: [{ id: "n", field_type: "number", label: "年数", choices: [] }] };
  const waitForRecall = async () =>
    vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[aria-label="呼び出し完了"]')?.open).toBe(
        true,
      ),
    );

  it.each(["success", "retry", "changed", "closed"])(
    "直接適用は先読みを再利用し、結果が現在の地図に対応する場合だけ反映する (%s)",
    async (outcome) => {
      let context = "account";
      let resolveData!: (value: unknown) => void;
      let rejectData!: (reason: Error) => void;
      let dataReads = 0;
      const response = { as_of: "2026-11-06T00:00:00Z", next_cursor: null, rows: [] };
      const pending = new Promise((resolve, reject) => {
        resolveData = resolve;
        rejectData = reject;
      });
      const transport = vi.fn(async (path: string) => {
        if (path === "/common-forms") return forms;
        if (path === "/form-answers/map-filter") return metadata;
        if (path === "/form-answers/map-presets/data")
          return ++dataReads === 1 ? pending : response;
        if (path.startsWith("/form-answers/map-presets?"))
          return { items: [savedFilter], total: 1 };
        throw Error(`unexpected request: ${path}`);
      });
      const data = new LocalPresetData(transport, { layer_ids: null }, [
        { key: "marker:m", name: "設備", detail: "" },
      ]);
      const apply = vi.fn();
      modal = createAdvancedMapSearchModal({
        transport,
        getApplied: () => ({
          ...request,
          conditions: [{ field_id: "n", field_type: "number", op: "eq", value: "7" }],
        }),
        getLayerIds: () => null,
        getContext: () => context,
        getPresetData: () => data,
        savedFilters: true,
        applyAiDefinition: apply,
        onApply: vi.fn(),
      });
      await modal.open();
      click("保存した検索条件");
      await vi.waitFor(() =>
        expect(savedList().querySelector("[data-preset-apply-id]")).not.toBeNull(),
      );
      click("適用");
      expect(modal.isBusy()).toBe(true);
      expect(apply).not.toHaveBeenCalled();
      if (outcome === "changed") context = "next-account";
      if (outcome === "closed") modal.close();
      if (outcome === "retry") rejectData(Error("先読み失敗"));
      else resolveData(response);
      await vi.waitFor(() => expect(modal.isBusy()).toBe(false));
      if (outcome === "success" || outcome === "retry") {
        expect(apply).toHaveBeenCalledExactlyOnceWith(
          savedFilter.definition,
          expect.any(AbortSignal),
        );
        expect(document.querySelector('[aria-label="絞り込み完了"][open]')).not.toBeNull();
        expect(document.querySelector(".ai-condition-editor")).toBeNull();
        expect(document.querySelector<HTMLInputElement>(".advanced-map-search input")?.value).toBe(
          "7",
        );
      } else {
        expect(apply).not.toHaveBeenCalled();
        expect(document.querySelector('[aria-label="絞り込み完了"][open]')).toBeNull();
      }
      expect(dataReads).toBe(outcome === "retry" ? 2 : 1);
    },
  );

  it("廃止された保存条件の項目を一覧に通知し、地図への直接適用を止める", async () => {
    const apply = vi.fn();
    const transport = vi.fn(async (path: string) => {
      if (path === "/common-forms") return forms;
      if (path === "/form-answers/map-filter") return { fields: [] };
      return { items: [savedFilter], total: 1 };
    });
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => "account",
      savedFilters: true,
      applyAiDefinition: apply,
      onApply: vi.fn(),
    });
    await modal.open();
    click("保存した検索条件");
    await vi.waitFor(() => expect(savedList().querySelector("tbody tr")).not.toBeNull());
    click("適用");
    await vi.waitFor(() =>
      expect(savedList().querySelector(".preset-error")?.textContent).toContain(
        "「年数」の項目または型が見つかりません。",
      ),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(savedList().open).toBe(true);
    expect(document.activeElement).toBe(savedList().querySelector("[data-preset-apply-id]"));
    expect(document.querySelector('[aria-label="絞り込み完了"][open]')).toBeNull();
  });

  it("次ページの取得に失敗したら、表示を維持した前ページの先読みを再開して呼び出せる", async () => {
    let first: AbortSignal | undefined;
    const transport = vi.fn(async (path: string, _body: unknown, signal: AbortSignal) => {
      if (path === "/common-forms") return forms;
      if (path.includes("page=1&")) return { items: [savedFilter], total: 21 };
      if (path.includes("page=2&")) throw Error("ページの取得失敗");
      if (path === "/form-answers/map-filter") {
        if (!first) {
          first = signal;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return metadata;
      }
      throw Error("予期しない通信 " + path);
    });
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => "account",
      savedFilters: true,
      applyAiDefinition: apply,
      onApply: vi.fn(),
    });
    await modal.open();
    click("保存した検索条件");
    await vi.waitFor(() => expect(first?.aborted).toBe(false));
    click("次へ");
    await vi.waitFor(() => {
      expect(savedList().textContent).toContain("ページの取得失敗");
      expect(savedList().querySelector(".preset-preparation")).toBeNull();
    });
    expect(first!.aborted).toBe(true);
    expect(
      transport.mock.calls.filter(([path]) => path === "/form-answers/map-filter"),
    ).toHaveLength(2);
    expect(savedList().querySelector("nav")?.textContent).toContain("1 / 2");
    transport.mockClear();
    savedList().querySelector<HTMLButtonElement>("tbody button")!.click();
    await waitForRecall();
    closeSavedFilter();
    click("絞り込み実行");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("AI一覧の先読み中に条件を開き、一覧を閉じても同じ取得で編集と適用が可能になる", async () => {
    let complete!: (value: typeof metadata) => void;
    const pending = new Promise<typeof metadata>((resolve) => {
      complete = resolve;
    });
    const transport = vi.fn(async (path: string, body: any) => {
      if (path === "/common-forms") return forms;
      if (path === "/form-answers/map-filter" && body.common_form_id === null) return { forms: [] };
      if (path === "/form-answers/map-filter" && body.common_form_id === "form") return pending;
      throw Error("予期しない通信 " + path);
    });
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => "account",
      analysis: { getSpecification: () => null, getColoring: () => null, apply: vi.fn() },
      applyAiDefinition: apply,
      onApply: vi.fn(),
    });
    const page = new AbortController();
    const preparation = modal.preparePresetPage(
      [savedFilter, { ...savedFilter, id: "second" }],
      page.signal,
    );
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    transport.mockClear();
    await modal.recallPreset(savedFilter);
    page.abort();
    const submit = () =>
      document.querySelector<HTMLButtonElement>('[data-focus-key="ai-filter-submit"]')!;
    expect(document.querySelector(".advanced-map-search")?.textContent).toContain(savedFilter.name);
    expect(submit().disabled).toBe(true);
    expect(transport).not.toHaveBeenCalled();
    const nextPage = modal.preparePresetPage(
      [{ ...savedFilter, id: "next" }],
      new AbortController().signal,
    );
    complete(metadata);
    await Promise.all([preparation, nextPage]);
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    submit().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("地図データが更新されたら、閉じた詳しい検索画面でも表示中のAI一覧を再準備する", async () => {
    let context = "初回";
    const transport = vi.fn(async (path: string) => (path === "/common-forms" ? forms : metadata));
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => context,
      savedFilters: true,
      applyAiDefinition: apply,
      onApply: vi.fn(),
    });
    await modal.preparePresetPage([savedFilter], new AbortController().signal);
    expect(transport).toHaveBeenCalledTimes(2);
    context = "対象変更後";
    modal.refreshPresetData();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
    transport.mockClear();
    await modal.recallPreset(savedFilter);
    const submit = () =>
      document.querySelector<HTMLButtonElement>('[data-focus-key="ai-filter-submit"]')!;
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    submit().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("先読みに失敗した回答値は呼び出しで再取得せず、選択した条件から再試行できる", async () => {
    let fail = true;
    const transport = vi.fn(async (path: string) => {
      if (path === "/common-forms") return forms;
      if (path === "/form-answers/map-filter") return metadata;
      if (path === "/form-answers/map-presets/data" && !fail)
        return { as_of: "2026-11-06T00:00:00Z", next_cursor: null, rows: [] };
      throw Error("回答値の取得失敗");
    });
    const data = new LocalPresetData(transport, { layer_ids: null }, [
      { key: "marker:m", name: "設備", detail: "" },
    ]);
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => "account",
      savedFilters: true,
      getPresetData: () => data,
      applyAiDefinition: apply,
      onApply: vi.fn(),
    });
    await expect(
      modal.preparePresetPage([savedFilter], new AbortController().signal),
    ).rejects.toThrow("回答値の取得失敗");
    transport.mockClear();
    await modal.recallPreset(savedFilter);
    await vi.waitFor(() => expect(document.body.textContent).toContain("登録データの取得を再試行"));
    expect(transport).not.toHaveBeenCalled();
    fail = false;
    click("登録データの取得を再試行");
    const submit = () =>
      document.querySelector<HTMLButtonElement>('[data-focus-key="ai-filter-submit"]')!;
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/form-answers/map-presets/data",
      expect.any(Object),
      expect.any(AbortSignal),
    );
    transport.mockClear();
    submit().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("一覧と項目変更で必要な属性を取得し、呼び出し・実行・再実行・解除は通信せずに行う", async () => {
    const transport = vi.fn(async (path: string, body?: any) => {
      if (path === "/common-forms") return forms;
      if (path === "/form-answers/map-presets/data") {
        const id = body.forms.form[0];
        return {
          as_of: "2026-11-06T00:00:00Z",
          next_cursor: null,
          rows: [
            {
              target: "marker:m",
              id: "answer",
              revision: 1,
              form_id: "form",
              fields: { [id]: { type: "number", value: "65" } },
            },
          ],
        };
      }
      if (path.startsWith("/form-answers/map-presets")) return { items: [savedFilter], total: 1 };
      return {
        fields: [...metadata.fields, { ...metadata.fields[0], id: "other", label: "別項目" }],
      };
    });
    const data = new LocalPresetData(transport, { layer_ids: ["selected"] }, [
      { key: "marker:m", name: "設備", detail: "" },
    ]);
    const applyAiDefinition = vi.fn(async (definition) => {
      expect(data.evaluate(definition).targets).toEqual(["marker:m"]);
    });
    const clearAiDefinition = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      savedFilters: true,
      getApplied: () => null,
      getLayerIds: () => ["selected"],
      getContext: () => "account",
      onApply: vi.fn(),
      applyAiDefinition,
      clearAiDefinition,
      getPresetData: () => data,
    });
    await modal.open();
    expect(document.body.textContent).not.toContain("検索条件を保存");
    click("保存した検索条件");
    await vi.waitFor(() =>
      expect(transport).toHaveBeenCalledWith(
        "/form-answers/map-presets/data",
        {
          targets: ["marker:m"],
          layer_ids: ["selected"],
          forms: { form: ["n"] },
        },
        expect.any(AbortSignal),
      ),
    );
    transport.mockClear();
    savedList().querySelector<HTMLButtonElement>("tbody button")!.click();
    await waitForRecall();
    expect(applyAiDefinition).not.toHaveBeenCalled();
    closeSavedFilter();
    expect(transport).not.toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>(".ai-condition-editor input")!;
    expect(input.value).toBe("50");
    input.value = "60";
    input.dispatchEvent(new Event("input"));
    click("絞り込み実行");
    await vi.waitFor(() => expect(applyAiDefinition).toHaveBeenCalledOnce());
    expect(applyAiDefinition.mock.calls[0]![0]).toMatchObject({
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "form",
        conditions: [{ field_id: "n", op: "gte", value: "60" }],
      },
    });
    expect(transport).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="絞り込み完了"][open]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[aria-label="絞り込み完了"] button')!.click();
    const field = document.querySelector<HTMLSelectElement>(
      '.ai-condition-editor [aria-label="属性"]',
    )!;
    field.value = "other:number";
    field.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect(transport).toHaveBeenCalledWith(
      "/form-answers/map-presets/data",
      expect.objectContaining({ forms: { form: ["other"] } }),
      expect.any(AbortSignal),
    );
    const value = document.querySelector<HTMLInputElement>(".ai-condition-editor input")!;
    value.value = "65";
    value.dispatchEvent(new Event("input"));
    transport.mockClear();
    click("絞り込み実行");
    await vi.waitFor(() => expect(applyAiDefinition).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="絞り込み完了"][open]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[aria-label="絞り込み完了"] button')!.click();
    click("属性条件を解除");
    await vi.waitFor(() => expect(clearAiDefinition).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("保存条件の失われた項目を明示し、実行せず手動の編集中条件も保つ", async () => {
    const applyAiDefinition = vi.fn();
    const transport = vi.fn(async (path: string) => {
      if (path === "/common-forms") return forms;
      if (path.startsWith("/form-answers/map-presets")) return { items: [savedFilter], total: 1 };
      return { fields: [] };
    });
    modal = createAdvancedMapSearchModal({
      transport,
      savedFilters: true,
      getApplied: () => ({
        ...request,
        conditions: [{ field_id: "n", field_type: "number", op: "eq", value: "7" }],
      }),
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
      applyAiDefinition,
    });
    await modal.open();
    await openSavedFilter();
    await waitForRecall();
    closeSavedFilter();
    click("絞り込み実行");
    await vi.waitFor(() =>
      expect(document.querySelector(".advanced-map-search [role=alert]")?.textContent).toContain(
        "項目",
      ),
    );
    expect(applyAiDefinition).not.toHaveBeenCalled();
    click("手動の絞り込み条件を編集");
    expect(document.querySelector<HTMLInputElement>(".advanced-map-search input")!.value).toBe("7");
  });

  it("全件の保存条件を実行すると全件表示の定義を反映する", async () => {
    const applyAiDefinition = vi.fn();
    const definition = { type: "filter", expression: { op: "all" } };
    const transport = vi.fn(async (path: string) =>
      path === "/common-forms" ? forms : { items: [{ ...savedFilter, definition }], total: 1 },
    );
    modal = createAdvancedMapSearchModal({
      transport,
      savedFilters: true,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
      applyAiDefinition,
    });
    await modal.open();
    await openSavedFilter();
    await waitForRecall();
    expect(applyAiDefinition).not.toHaveBeenCalled();
    closeSavedFilter();
    click("絞り込み実行");
    await vi.waitFor(() =>
      expect(applyAiDefinition).toHaveBeenCalledWith(definition, expect.any(AbortSignal)),
    );
  });

  it("復元中に閉じた古い応答を開き直したモーダルに反映しない", async () => {
    let complete!: (value: unknown) => void;
    const transport = vi.fn(async (path: string) => {
      if (path === "/form-answers/map-filter")
        return new Promise((done) => {
          complete = done;
        });
      if (path === "/common-forms") return forms;
      return { items: [savedFilter], total: 1 };
    });
    modal = createAdvancedMapSearchModal({
      transport,
      savedFilters: true,
      getApplied: () => null,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
    });
    await modal.open();
    await openSavedFilter();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    modal.close();
    await modal.open();
    complete(metadata);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector<HTMLSelectElement>(".advanced-map-search select")!.value).toBe(
      "",
    );
    expect(
      document.querySelector<HTMLDialogElement>('[aria-label="呼び出し完了"]')?.open,
    ).toBeFalsy();
  });

  it("keeps exact decimal values, applies zero matches, and clears explicitly", async () => {
    const apply = vi.fn(),
      transport = vi.fn(async (_path: string, body: unknown) =>
        body === undefined ? forms : result,
      );
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => null,
      getLayerIds: () => ["layer"],
      getContext: () => "account",
      onApply: apply,
    });
    await modal.open();
    const select = document.querySelector("select")!;
    select.value = "form";
    select.dispatchEvent(new Event("change"));
    click("条件を追加");
    const input = document.querySelector("input")!;
    input.value = "9007199254740993.0001";
    input.dispatchEvent(new Event("input"));
    click("絞り込み実行");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport.mock.calls[1]![1]).toMatchObject({
      layer_ids: ["layer"],
      conditions: [{ field_id: "n", field_type: "number", value: "9007199254740993.0001" }],
    });
    expect(apply.mock.calls[0]![1]).toMatchObject({
      marker_ids: [],
      shape_ids: [],
      target_count: 0,
    });
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "属性条件のみの一致件数：0件",
    );
    expect(document.querySelector<HTMLInputElement>("dialog input")?.value).toBe(
      "9007199254740993.0001",
    );
    expect(document.querySelector<HTMLButtonElement>(".attribute-submit")?.disabled).toBe(false);
    click("属性条件を解除");
    expect(apply).toHaveBeenLastCalledWith(null, null);
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("dialog select")?.value).toBe("");
    expect(document.querySelectorAll(".attribute-row")).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("属性条件を解除しました。");
    expect(document.activeElement?.textContent).toBe("属性条件を解除");
  });
  it("discards a response after closing and preserves applied conditions on error", async () => {
    let resolve!: (value: unknown) => void;
    const transport = vi.fn((_path: string, body: unknown) =>
      body === undefined ? Promise.resolve(forms) : new Promise((yes) => (resolve = yes)),
    );
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: apply,
    });
    await modal.open();
    click("絞り込み実行");
    click("閉じる");
    resolve(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    transport.mockImplementation(async (_path: string, body: unknown) => {
      if (body === undefined) return forms;
      throw Error("network failed");
    });
    await modal.open();
    click("絞り込み実行");
    await vi.waitFor(() => expect(document.body.textContent).toContain("network failed"));
    expect(apply).not.toHaveBeenCalled();
  });
  it("rejects a stale context and a removed or individual field", async () => {
    let context = "before";
    const apply = vi.fn(),
      transport = vi.fn(async (_path: string, body: unknown) => {
        if (body === undefined) return forms;
        context = "after";
        return result;
      });
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => context,
      onApply: apply,
    });
    await modal.open();
    click("絞り込み実行");
    await vi.waitFor(() => expect(document.body.textContent).toContain("地図データが更新"));
    expect(apply).not.toHaveBeenCalled();
    modal.dispose();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => ({
        ...request,
        conditions: [{ field_id: "individual", field_type: "text", op: "filled" }],
      }),
      getLayerIds: () => null,
      getContext: () => context,
      onApply: apply,
    });
    await modal.open();
    click("絞り込み実行");
    expect(document.body.textContent).toContain("条件を選び直してください");
    expect(apply).not.toHaveBeenCalled();
  });
  it("offers presence only for images and validates response identity/counts", () => {
    expect(attributeOperations("image").map(([id]) => id)).toEqual(["filled", "empty", "missing"]);
    expect(() => validateAttributeResult({ ...result, target_count: 1 }, request)).toThrow();
    expect(() => validateAttributeResult({ ...result, definition_version: 1 }, request)).toThrow();
    expect(() =>
      validateAttributeResult({ ...result, marker_ids: ["a", "a"], target_count: 2 }, request),
    ).toThrow();
  });

  it("keeps full-screen and top-page controls consistent, with spaced and top-aligned conditions", async () => {
    const map = document.createElement("div");
    map.id = "map";
    document.body.append(map);
    modal = createAdvancedMapSearchModal({
      transport: async () => forms,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
    });
    await modal.open();
    click("条件を追加");
    const styles = () =>
      [...document.querySelectorAll("dialog button, dialog select, dialog input")].map((node) => {
        const style = getComputedStyle(node);
        return [
          style.backgroundColor,
          style.color,
          style.borderRadius,
          style.boxShadow,
          style.padding,
          style.fontWeight === "normal" ? "400" : style.fontWeight,
        ];
      });
    const fullScreenStyles = styles();
    const pageStyle = document.createElement("style");
    try {
      // 全画面ページにはない、実際のトップページの全体用 CSS を読み込む。
      pageStyle.textContent = readFileSync(resolve("../frontend/src/views/MapView.vue"), "utf8")
        .split("<style>")[1]!
        .split("</style>")[0]!;
      document.head.append(pageStyle);
      expect(styles()).toEqual(fullScreenStyles);
      const heading = document.querySelector("dialog h2")!;
      const headingBorder = () => {
        const style = getComputedStyle(heading);
        return [style.borderBottomWidth, style.borderBottomStyle];
      };
      const topHeadingBorder = headingBorder();
      const typography = () =>
        [...document.querySelectorAll("dialog label, dialog select, dialog input")].map((node) => {
          const weight = getComputedStyle(node).fontWeight;
          return weight === "normal" ? "400" : weight;
        });
      const topTypography = typography();
      expect(topTypography.every((weight) => weight === "normal" || weight === "400")).toBe(true);
      const buttons = [...document.querySelectorAll("dialog button")];
      expect(new Set(buttons.map((b) => getComputedStyle(b).borderRadius))).toEqual(
        new Set(["8px"]),
      );
      const conditions = getComputedStyle(document.querySelector(".attribute-conditions")!);
      expect(parseFloat(conditions.gap)).toBeGreaterThan(0);
      expect(parseFloat(conditions.marginTop)).toBeGreaterThan(0);
      expect(getComputedStyle(document.querySelector(".attribute-row")!).alignItems).toBe("start");
      expect(getComputedStyle(document.querySelector(".attribute-row > button")!).alignSelf).toBe(
        "end",
      );
      // Markdown の最初と最後の子要素に適用する !important の余白指定も含め、全画面ページに合わせる。
      const template = new DOMParser().parseFromString(
        readFileSync(resolve("../../src/templates/map-anather.html"), "utf8"),
        "text/html",
      );
      pageStyle.textContent = [
        ...["map-compat.css", "map-controls.css", "github.css"].map((name) =>
          readFileSync(resolve("../frontend/public", name), "utf8"),
        ),
        ...[...template.querySelectorAll("head style")].map((style) => style.textContent),
      ].join("\n");
      expect(typography()).toEqual(topTypography);
      expect(styles()).toEqual(fullScreenStyles);
      const mapLabel = document.createElement("label");
      mapLabel.textContent = "既存の地図コントロール";
      map.append(mapLabel);
      expect(getComputedStyle(mapLabel).fontWeight).toBe("bold");
      expect(headingBorder()).toEqual(topHeadingBorder);
      const markdownHeading = document.createElement("h2");
      markdownHeading.textContent = "Markdownの見出し";
      map.append(markdownHeading);
      const markdownStyle = getComputedStyle(markdownHeading);
      expect([markdownStyle.borderBottomWidth, markdownStyle.borderBottomStyle]).toEqual([
        "1px",
        "solid",
      ]);
      const dialog = getComputedStyle(document.querySelector("dialog")!);
      // 追加したダイアログは body の最後の子要素になる。下余白がゼロでも、画面下に固定されないことを確認する。
      expect(dialog.position).toBe("fixed");
      expect(dialog.top).toBe("50%");
      expect(dialog.left).toBe("50%");
      expect(dialog.bottom).toBe("auto");
      expect(dialog.right).toBe("auto");
      expect(dialog.transform).toBe("translate(-50%, -50%)");
      expect(dialog.height).toBe("fit-content");
      expect(dialog.marginBottom).toBe("0px");
    } finally {
      pageStyle.remove();
    }
  });

  it.each(["select", "radio"])(
    "廃止済みの%sの選択肢を表示し、明示的に選択を解除するまで実行を止める",
    async (type) => {
      const transport = vi.fn(async (_path: string, body: unknown) =>
        body === undefined
          ? [
              {
                id: "form",
                version: 2,
                form_title: "設備",
                form_schema: {
                  fields: [{ id: "status", label: "区分", type, choices: ["新しい値", "別の値"] }],
                },
              },
            ]
          : result,
      );
      const apply = vi.fn();
      modal = createAdvancedMapSearchModal({
        transport,
        getApplied: () => ({
          ...request,
          definition_version: 1,
          conditions: [{ field_id: "status", field_type: type, op: "in", value: ["古い値"] }],
        }),
        getLayerIds: () => null,
        getContext: () => "account",
        onApply: apply,
      });
      await modal.open();
      const choices = document.querySelector<HTMLSelectElement>(
        ".attribute-values select[multiple]",
      )!;
      expect(document.querySelector('.attribute-values input[type="checkbox"]')).toBeNull();
      const retired = [...choices.options].find((option) => option.value === "古い値")!;
      expect(retired.textContent).toBe("古い値（現在の選択肢にありません）");
      expect(retired.selected).toBe(true);
      expect(choices.getAttribute("aria-invalid")).toBe("true");
      choices.options[0]!.selected = true;
      choices.options[1]!.selected = true;
      choices.dispatchEvent(new Event("change"));
      click("絞り込み実行");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
      expect(document.querySelector('[role="status"]')?.textContent).toContain("選択肢にない値");
      retired.selected = false;
      choices.dispatchEvent(new Event("change"));
      expect(choices.getAttribute("aria-invalid")).toBe("false");
      click("絞り込み実行");
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
      expect(transport.mock.calls[1]![1]).toMatchObject({
        definition_version: 2,
        conditions: [{ value: ["新しい値", "別の値"] }],
      });
    },
  );

  it("keeps focus on form, attribute, and comparison selectors after redrawing", async () => {
    modal = createAdvancedMapSearchModal({
      transport: async () => forms,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
    });
    await modal.open();
    const form = document.querySelector<HTMLSelectElement>("dialog select")!;
    form.focus();
    form.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(document.querySelector("dialog select"));
    click("条件を追加");
    const field = document.querySelectorAll<HTMLSelectElement>("dialog select")[1]!;
    expect(document.activeElement).toBe(field);
    field.value = "flag:checkbox";
    field.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(document.querySelectorAll("dialog select")[1]);
    const currentField = document.querySelectorAll<HTMLSelectElement>("dialog select")[1]!;
    currentField.value = "n:number";
    currentField.dispatchEvent(new Event("change"));
    const comparison = document.querySelectorAll<HTMLSelectElement>("dialog select")[2]!;
    comparison.focus();
    comparison.value = "between";
    comparison.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(document.querySelectorAll("dialog select")[2]);
    click("削除");
    expect(document.activeElement?.textContent).toBe("条件を追加");
    click("条件を追加");
    click("条件を追加");
    const secondComparison = document.querySelectorAll<HTMLSelectElement>("dialog select")[4]!;
    secondComparison.focus();
    secondComparison.value = "gte";
    secondComparison.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(document.querySelectorAll("dialog select")[4]);
  });

  it("preserves saved choices that are still valid after a definition update", async () => {
    const transport = vi.fn(async (_path: string, body: unknown) =>
      body === undefined
        ? [
            {
              id: "form",
              version: 2,
              form_title: "設備",
              form_schema: {
                fields: [
                  { id: "status", label: "区分", type: "select", choices: ["継続", "追加"] },
                ],
              },
            },
          ]
        : result,
    );
    const apply = vi.fn();
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => ({
        ...request,
        definition_version: 1,
        conditions: [{ field_id: "status", field_type: "select", op: "in", value: ["継続"] }],
      }),
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: apply,
    });
    await modal.open();
    const choices = document.querySelector<HTMLSelectElement>(
      ".attribute-values select[multiple]",
    )!;
    expect([...choices.selectedOptions].map((option) => option.value)).toEqual(["継続"]);
    click("絞り込み実行");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(transport.mock.calls[1]![1]).toMatchObject({
      definition_version: 2,
      conditions: [{ value: ["継続"] }],
    });
  });

  it("cancels old deadlines on close, and late completions cannot cancel a newer deadline", async () => {
    vi.useFakeTimers();
    const searches: { signal: AbortSignal; complete: (value: unknown) => void }[] = [];
    const transport = vi.fn(
      (_path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        if (body === undefined) return Promise.resolve(forms);
        // トークン更新インターセプターの処理は、元のシグナルが中断された後も続く場合がある。
        return new Promise((complete) => searches.push({ signal, complete }));
      },
    );
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
    });
    await modal.open();
    click("絞り込み実行");
    await vi.advanceTimersByTimeAsync(30000);
    click("閉じる");
    expect(searches[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await modal.open();
    click("絞り込み実行");
    await vi.advanceTimersByTimeAsync(30000);
    expect(searches[1]!.signal.aborted).toBe(false);
    searches[0]!.complete(result);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29999);
    expect(searches[1]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(searches[1]!.signal.aborted).toBe(true);
  });

  it("a closed search cannot abort a reopened form load, and dispose removes its deadline", async () => {
    vi.useFakeTimers();
    let reads = 0,
      reopenedSignal: AbortSignal | undefined;
    const transport = vi.fn(
      (_path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        if (body !== undefined) return new Promise(() => {});
        if (++reads === 1) return Promise.resolve(forms);
        reopenedSignal = signal;
        return new Promise(() => {});
      },
    );
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: vi.fn(),
    });
    await modal.open();
    click("絞り込み実行");
    click("閉じる");
    void modal.open();
    await vi.advanceTimersByTimeAsync(60000);
    expect(reopenedSignal?.aborted).toBe(false);
    modal.dispose();
    expect(reopenedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose cancels an outstanding search deadline even if abort does not settle the transport", async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const transport = async (_path: string, body: unknown): Promise<unknown> =>
      body === undefined ? forms : new Promise(() => {});
    modal = createAdvancedMapSearchModal({
      transport,
      getApplied: () => request,
      getLayerIds: () => null,
      getContext: () => "account",
      onApply: apply,
    });
    await modal.open();
    click("絞り込み実行");
    expect(vi.getTimerCount()).toBe(1);
    modal.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(apply).not.toHaveBeenCalled();
  });
});
