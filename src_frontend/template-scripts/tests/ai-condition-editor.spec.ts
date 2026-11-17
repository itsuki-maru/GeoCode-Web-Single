import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAiConditionEditor,
  validateAiEditorDefinition,
} from "../src/map/common/ai-condition-editor";
import type { AiDefinition } from "../src/ai/types";
import type { AttributeTransport } from "../src/map/common/advanced-map-search";

const firstFields = [
  { id: "n", field_type: "number", label: "精密な数値", choices: [] },
  { id: "choice", field_type: "select", label: "分類", choices: ["学校", "病院"] },
];
const secondFields = [{ id: "flag", field_type: "checkbox", label: "点検済み", choices: [] }];
const definition = (): AiDefinition => ({
  type: "filter",
  expression: {
    op: "and",
    children: [
      {
        op: "or",
        children: [
          { op: "text", query1: "学校" },
          {
            op: "attribute",
            common_form_id: "first",
            conditions: [
              {
                field_id: "n",
                field_type: "number",
                op: "gte",
                value: "9007199254740993.1234567890123456789",
              },
            ],
          },
        ],
      },
      {
        op: "not",
        child: {
          op: "attribute",
          common_form_id: "second",
          conditions: [{ field_id: "flag", field_type: "checkbox", op: "eq", value: false }],
        },
      },
    ],
  },
});
const forms = [
  { id: "first", form_title: "施設台帳" },
  { id: "second", form_title: "点検記録" },
];
const defaultTransport: AttributeTransport = async (path, body) => {
  if (path === "/common-forms") return forms;
  if (path === "/form-answers/map-filter") {
    const form = (body as { common_form_id: string }).common_form_id;
    return { fields: form === "first" ? firstFields : secondFields };
  }
  throw Error("想定しない通信");
};
const editors: ReturnType<typeof createAiConditionEditor>[] = [];
function mount(
  value = definition(),
  transport = defaultTransport,
  getLayerIds = () => null as string[] | null,
) {
  const host = document.createElement("section");
  document.body.append(host);
  const editor = createAiConditionEditor(host, { definition: value, transport, getLayerIds });
  editors.push(editor);
  return { host, editor };
}
function input(host: HTMLElement, name: string, value: string) {
  const control = host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  return control;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.dispose());
  document.body.replaceChildren();
});

describe("AI保存条件の構造を保つ編集", () => {
  it("OR・NOT・複数フォーム・精密数値・falseを無編集で往復し、保存元を変更しない", async () => {
    const source = definition();
    const expected = structuredClone(source);
    const transport = vi.fn(defaultTransport);
    const { host, editor } = mount(source, transport);
    expect(() => editor.getDefinition()).toThrow("読み込み");
    await editor.refreshMetadata();
    expect(editor.getDefinition()).toEqual(expected);
    const first = editor.getDefinition();
    (first.expression as { op: string }).op = "all";
    expect(editor.getDefinition()).toEqual(expected);
    expect(source).toEqual(expected);
    expect(host.querySelectorAll('[data-operation="not"]')).toHaveLength(1);
    expect(host.querySelector("summary,details")).toBeNull();
    expect(host.querySelector('select[aria-label="条件の種類"]')).toBeNull();
    expect(host.querySelector('button[aria-label="組合せに条件を追加"]')).toBeNull();
    for (const name of ["ANDでまとめる", "ORでまとめる", "NOTで除外"])
      expect(host.querySelector(`button[aria-label="${name}"]`)).toBeNull();
    expect(transport.mock.calls.map(([path]) => path)).toEqual([
      "/common-forms",
      "/form-answers/map-filter",
      "/form-answers/map-filter",
    ]);
    expect(transport.mock.calls.every(([path]) => !path.startsWith("/ai/"))).toBe(true);
  });

  it("入力中の要素とフォーカスを保持し、編集した葉だけを変更する", async () => {
    const source = definition();
    const { host, editor } = mount(source);
    await editor.refreshMetadata();
    const control = host.querySelector<HTMLInputElement>('input[aria-label="検索語1"]')!;
    control.focus();
    input(host, "検索語1", "教育施設");
    const expected = definition() as Record<string, any>;
    expected.expression.children[0].children[0].query1 = "教育施設";
    expect(editor.getDefinition()).toEqual(expected);
    expect(host.querySelector('input[aria-label="検索語1"]')).toBe(control);
    expect(document.activeElement).toBe(control);
    expect(source).toEqual(definition());
  });

  it("保存済みNOTを明示的に解除しても他の組合せとフォームを変更しない", async () => {
    const { host, editor } = mount();
    await editor.refreshMetadata();
    const expected = definition() as Record<string, any>;
    const wrapper = host.querySelector<HTMLElement>('[data-operation="not"]')!;
    wrapper.querySelector<HTMLButtonElement>(':scope > button[aria-label="除外を解除"]')!.click();
    expected.expression.children[1] = expected.expression.children[1].child;
    expect(editor.getDefinition()).toEqual(expected);
  });

  it("AND・ORの切替で既存の子とフォームを保持する", async () => {
    const { host, editor } = mount();
    await editor.refreshMetadata();
    const control = host.querySelector<HTMLSelectElement>('select[aria-label="条件の組合せ"]')!;
    control.value = "or";
    control.dispatchEvent(new Event("change"));
    expect(editor.getDefinition()).toEqual({
      type: "filter",
      expression: { ...(definition().expression as object), op: "or" },
    });
  });

  it("分類のID・精密な境界値を保持し、上下操作で優先順だけを変更する", async () => {
    const rules = [
      {
        id: "unchanged-a",
        label: "高額",
        color: "#112233",
        conditions: [
          {
            field_id: "n",
            field_type: "number",
            op: "gte",
            value: "12345678901234567890.123456789",
          },
        ],
      },
      { id: "unchanged-b", label: "その他", color: "#aabbcc", conditions: [] },
    ];
    const source = { type: "color", common_form_id: "first", rules } as AiDefinition;
    const { host, editor } = mount(source);
    await editor.refreshMetadata();
    expect(editor.getDefinition()).toEqual(source);
    host
      .querySelector<HTMLButtonElement>('.ai-editor-rule button[aria-label="分類を下へ"]')!
      .click();
    expect(editor.getDefinition()).toEqual({ ...source, rules: [rules[1], rules[0]] });
    expect(source.rules).toEqual(rules);
  });

  it("削除された項目と選択肢を省略せず、修正するまで実行を拒否する", async () => {
    const source: AiDefinition = {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "first",
        conditions: [
          { field_id: "choice", field_type: "select", op: "in", value: ["学校", "保存時だけ存在"] },
        ],
      },
    };
    const { host, editor } = mount(source);
    await editor.refreshMetadata();
    expect(() => editor.getDefinition()).toThrow("現在使えない選択値");
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="値（複数選択可）"]')!;
    expect([...picker.selectedOptions].map((option) => option.value)).toEqual([
      "学校",
      "保存時だけ存在",
    ]);
    const missing = [...picker.options].find((option) => option.value === "保存時だけ存在")!;
    missing.selected = false;
    picker.dispatchEvent(new Event("change"));
    expect(editor.getDefinition()).toEqual({
      ...source,
      expression: {
        ...(source.expression as object),
        conditions: [{ field_id: "choice", field_type: "select", op: "in", value: ["学校"] }],
      },
    });
    expect((source.expression as Record<string, any>).conditions[0].value).toEqual([
      "学校",
      "保存時だけ存在",
    ]);
  });

  it.each(["一覧取得", "フォーム取得", "不正な応答"])(
    "%sの失敗時だけ再試行を表示し、復旧後は編集下書きと複合条件を保持して消す",
    async (failure) => {
      let fail = true;
      const source = definition();
      const original = structuredClone(source);
      const { host, editor } = mount(source, async (...args) => {
        if (
          fail &&
          args[0] === (failure === "一覧取得" ? "/common-forms" : "/form-answers/map-filter")
        ) {
          if (failure === "不正な応答") return { fields: "invalid" };
          throw Error("取得失敗");
        }
        return defaultTransport(...args);
      });
      expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
      input(host, "検索語1", "復旧しても残る編集");
      await editor.refreshMetadata();
      expect(() => editor.getDefinition()).toThrow();
      expect(host.querySelectorAll('button[aria-label="再試行"]')).toHaveLength(1);
      expect(host.querySelector("summary")).toBeNull();
      fail = false;
      host.querySelector<HTMLButtonElement>('button[aria-label="再試行"]')!.click();
      expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
      const expected = definition() as Record<string, any>;
      expected.expression.children[0].children[0].query1 = "復旧しても残る編集";
      await vi.waitFor(() => expect(editor.getDefinition()).toEqual(expected));
      expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
      expect(source).toEqual(original);
    },
  );

  it("再試行が再び失敗しても下書きと再試行を残し、無効化中や重複クリックでは取得しない", async () => {
    let fail = true;
    let release!: (value: unknown) => void;
    let wait = false;
    const transport = vi.fn(async (...args: Parameters<AttributeTransport>) => {
      if (args[0] === "/common-forms") {
        if (fail) throw Error("一覧の取得失敗");
        if (wait) return new Promise<unknown>((resolve) => (release = resolve));
      }
      return defaultTransport(...args);
    });
    const { host, editor } = mount(definition(), transport);
    await editor.refreshMetadata();
    input(host, "検索語1", "再試行前の編集");
    const retry = host.querySelector<HTMLButtonElement>('button[aria-label="再試行"]')!;
    editor.setDisabled(true);
    retry.click();
    expect(transport).toHaveBeenCalledTimes(1);
    editor.setDisabled(false);
    retry.click();
    await vi.waitFor(() =>
      expect(host.querySelector('button[aria-label="再試行"]')).not.toBeNull(),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(host.querySelector('input[aria-label="検索語1"]')).toHaveProperty(
      "value",
      "再試行前の編集",
    );
    fail = false;
    wait = true;
    const secondRetry = host.querySelector<HTMLButtonElement>('button[aria-label="再試行"]')!;
    secondRetry.click();
    secondRetry.click();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
    release(forms);
    const expected = definition() as Record<string, any>;
    expected.expression.children[0].children[0].query1 = "再試行前の編集";
    await vi.waitFor(() => expect(editor.getDefinition()).toEqual(expected));
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it("取得が成功した後の項目欠落と値の検証エラーでは再試行を表示しない", async () => {
    const { host, editor } = mount(definition(), async (path) =>
      path === "/common-forms" ? forms : { fields: [] },
    );
    await editor.refreshMetadata();
    expect(() => editor.getDefinition()).toThrow("項目または型が見つかりません");
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
    expect(host.querySelector('input[aria-label="値"]')).toHaveProperty(
      "value",
      "9007199254740993.1234567890123456789",
    );
  });

  it("取得できないフォームの条件を明示的に削除して修復した後は再試行を残さない", async () => {
    const { host, editor } = mount(definition(), async (...args) => {
      if (
        args[0] === "/form-answers/map-filter" &&
        (args[1] as { common_form_id: string }).common_form_id === "second"
      )
        throw Error("取得できないフォーム");
      return defaultTransport(...args);
    });
    await editor.refreshMetadata();
    expect(host.querySelector('button[aria-label="再試行"]')).not.toBeNull();
    const failed = host.querySelector<HTMLElement>('[data-operation="not"]')!;
    failed
      .querySelector<HTMLButtonElement>(':scope > button[aria-label="この条件を削除"]')!
      .click();
    const expected = definition() as Record<string, any>;
    expected.expression.children.splice(1, 1);
    expect(editor.getDefinition()).toEqual(expected);
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
  });

  it("取得を中止した場合だけ再試行を表示し、破棄後に古い応答を描画しない", async () => {
    const abort = new AbortController();
    let stop = true;
    let release!: (value: unknown) => void;
    const { host, editor } = mount(definition(), async (...args) => {
      if (args[0] === "/common-forms" && stop) {
        return new Promise<unknown>((resolve, reject) => {
          release = resolve;
          args[2]!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return defaultTransport(...args);
    });
    const pending = editor.refreshMetadata(abort.signal);
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
    abort.abort();
    await pending;
    expect(host.querySelector('button[aria-label="再試行"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="検索語1"]')).toHaveProperty("value", "学校");
    stop = false;
    await editor.refreshMetadata();
    expect(editor.getDefinition()).toEqual(definition());
    expect(host.querySelector('button[aria-label="再試行"]')).toBeNull();
    stop = true;
    const late = editor.refreshMetadata();
    editor.dispose();
    release(forms);
    await late;
    expect(host.childElementCount).toBe(0);
  });

  it("古いメタデータ応答と破棄後の応答を反映しない", async () => {
    const source: AiDefinition = {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "first",
        conditions: [{ field_id: "n", field_type: "number", op: "eq", value: "0" }],
      },
    };
    let release!: (value: unknown) => void;
    let first = true;
    let layerIds = ["old-layer"];
    const transport = vi.fn(async (...args: Parameters<AttributeTransport>) => {
      if (args[0] === "/form-answers/map-filter" && first) {
        first = false;
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      }
      return defaultTransport(...args);
    });
    const { host, editor } = mount(source, transport, () => layerIds);
    const old = editor.refreshMetadata();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    layerIds = ["new-layer"];
    await editor.refreshMetadata();
    release({ fields: [] });
    await old;
    expect(editor.getDefinition()).toEqual(source);
    editor.dispose();
    expect(host.childElementCount).toBe(0);
    expect(() => editor.getDefinition()).toThrow("閉じられています");
  });

  it("フォーム名・項目名・値をHTMLとして解釈しない", async () => {
    const unsafe = '<img src=x onerror="window.evil=true">';
    const source: AiDefinition = {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "first",
        conditions: [{ field_id: "choice", field_type: "select", op: "in", value: [unsafe] }],
      },
    };
    const { host, editor } = mount(source, async (path) =>
      path === "/common-forms"
        ? [{ id: "first", form_title: unsafe }]
        : { fields: [{ id: "choice", field_type: "select", label: unsafe, choices: [unsafe] }] },
    );
    await editor.refreshMetadata();
    expect(editor.getDefinition()).toEqual(source);
    expect(host.textContent).toContain(unsafe);
    expect(host.querySelector("img,script")).toBeNull();
  });

  it("busy中の操作を無効にし、モバイルの深い入れ子も幅を制限する", async () => {
    const { host, editor } = mount();
    await editor.refreshMetadata();
    editor.setDisabled(true);
    expect(host.querySelector<HTMLFieldSetElement>(".ai-editor-controls")!.disabled).toBe(true);
    const before = editor.getDefinition();
    host.querySelector<HTMLButtonElement>('button[aria-label="除外を解除"]')!.click();
    expect(editor.getDefinition()).toEqual(before);
    editor.setDisabled(false);
    expect(host.querySelector<HTMLFieldSetElement>(".ai-editor-controls")!.disabled).toBe(false);
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/map/common/ai-condition-editor.css"),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 650px)");
    expect(css).toContain("min-width: 0");
  });

  it("単純な属性条件は手動と同じ行・値・追加削除の配置を使い、構造の追加操作を表示しない", async () => {
    const source: AiDefinition = {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "first",
        conditions: [
          {
            field_id: "n",
            field_type: "number",
            op: "between",
            value: "9007199254740993.123456789",
            upper: "9007199254740994.123456789",
          },
        ],
      },
    };
    const { host, editor } = mount(source);
    await editor.refreshMetadata();
    const root = host.querySelector<HTMLElement>(".ai-editor-expression.is-root")!;
    expect(root.querySelector(":scope > legend")).toBeNull();
    const row = root.querySelector<HTMLElement>(".attribute-conditions > .attribute-row")!;
    expect(row.querySelector(':scope > label select[aria-label="属性"]')).not.toBeNull();
    expect(row.querySelector(':scope > label select[aria-label="比較方法"]')).not.toBeNull();
    expect(row.querySelectorAll(":scope > .attribute-values > label")).toHaveLength(2);
    expect(row.querySelector(':scope > button[aria-label="削除"]')).not.toBeNull();
    expect(
      root.querySelector('.attribute-conditions > button[aria-label="条件を追加"]'),
    ).not.toBeNull();
    expect(root.querySelector("summary,details")).toBeNull();
    expect(root.querySelector('select[aria-label="条件の種類"]')).toBeNull();
    expect(editor.getDefinition()).toEqual(source);
    root.querySelector<HTMLButtonElement>('button[aria-label="条件を追加"]')!.click();
    const values = host.querySelectorAll<HTMLInputElement>('input[aria-label="値"]');
    values[0]!.value = "0";
    values[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(editor.getDefinition()).toEqual({
      ...source,
      expression: {
        ...(source.expression as Record<string, unknown>),
        conditions: [
          ...(source.expression as Record<string, any>).conditions,
          { field_id: "n", field_type: "number", op: "eq", value: "0" },
        ],
      },
    });
  });

  it("色分けの共通フォーム直下に追加と解除を置き、分類カードと上下矢印を手動設定に揃える", async () => {
    const source: AiDefinition = {
      type: "color",
      common_form_id: "first",
      rules: [
        {
          id: "unchanged-a",
          label: "分類A",
          color: "#112233",
          conditions: [
            { field_id: "n", field_type: "number", op: "eq", value: "12345678901234567890.1" },
          ],
        },
        { id: "unchanged-b", label: "分類B", color: "#aabbcc", conditions: [] },
      ],
    };
    const host = document.createElement("section");
    document.body.append(host);
    const clear = vi.fn();
    const editor = createAiConditionEditor(host, {
      definition: source,
      transport: defaultTransport,
      getLayerIds: () => null,
      onClear: clear,
    });
    editors.push(editor);
    await editor.refreshMetadata();
    const controls = host.querySelector<HTMLElement>(".map-coloring-editor > .ai-editor-controls")!;
    expect(controls.children[0]!.className).toBe("color-form");
    const actions = controls.children[1] as HTMLElement;
    expect(actions.className).toBe("color-actions");
    expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "分類を追加",
      "色分け解除",
    ]);
    const rule = controls.querySelector<HTMLElement>(":scope > .color-rule")!;
    expect(rule.querySelector(':scope > label input[aria-label="分類名"]')).not.toBeNull();
    expect(
      rule.querySelector(':scope > .color-picker input[aria-label="分類の色"]'),
    ).not.toBeNull();
    expect(rule.querySelector('button[aria-label="分類を上へ"]')!.textContent).toBe("↑");
    expect(rule.querySelector('button[aria-label="分類を下へ"]')!.textContent).toBe("↓");
    expect(
      rule.querySelector(
        '.color-condition > .color-condition-values input[aria-label="色分けの条件値"]',
      ),
    ).not.toBeNull();
    expect(
      [...rule.querySelectorAll(".color-condition-actions button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["分類条件を削除", "分類条件を追加"]);
    actions.querySelector<HTMLButtonElement>('button[aria-label="色分け解除"]')!.click();
    expect(clear).toHaveBeenCalledOnce();
    expect(editor.getDefinition()).toEqual(source);
    editor.setDisabled(true);
    actions.querySelector<HTMLButtonElement>('button[aria-label="色分け解除"]')!.click();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("日付欄を手動と揃えてもブラウザーの日付入力で表せない保存値を空欄にしない", async () => {
    const source: AiDefinition = {
      type: "filter",
      expression: {
        op: "attribute",
        common_form_id: "first",
        conditions: [
          {
            field_id: "date",
            field_type: "date",
            op: "between",
            value: "0000-01-01",
            upper: "2010-12-31",
          },
        ],
      },
    };
    const { host, editor } = mount(source, async (path) =>
      path === "/common-forms"
        ? forms
        : { fields: [{ id: "date", field_type: "date", label: "建設日", choices: [] }] },
    );
    await editor.refreshMetadata();
    const start = host.querySelector<HTMLInputElement>('input[aria-label="開始値"]')!;
    const end = host.querySelector<HTMLInputElement>('input[aria-label="終了値"]')!;
    expect(start.value).toBe("0000-01-01");
    expect(start.type).toBe("text");
    expect(end.type).toBe("date");
    expect(end.value).toBe("2010-12-31");
    expect(editor.getDefinition()).toEqual(source);
  });
});

describe("AI条件編集の入力検証", () => {
  it.each([
    { type: "filter", expression: { op: "sql", query: "private" } },
    { type: "filter", expression: { op: "all", ignored: "private" } },
    { type: "filter", expression: { op: "and", children: [] } },
    { type: "color", common_form_id: "first", rules: [] },
    { type: "focus", latitude: 0, longitude: 0, zoom: 1 },
  ])("未知の操作や省略できない構造を部分的に読み込まない: %j", (value) => {
    expect(() => validateAiEditorDefinition(value)).toThrow();
  });

  it("深さ・葉数・UTF8容量の上限を維持する", () => {
    let nested: Record<string, unknown> = { op: "all" };
    for (let i = 0; i < 6; i++) nested = { op: "not", child: nested };
    expect(() => validateAiEditorDefinition({ type: "filter", expression: nested })).toThrow();
    const leaves = Array.from({ length: 3 }, () => ({
      op: "and",
      children: Array.from({ length: 9 }, () => ({ op: "all" })),
    }));
    expect(() =>
      validateAiEditorDefinition({ type: "filter", expression: { op: "or", children: leaves } }),
    ).toThrow();
    expect(() =>
      validateAiEditorDefinition({
        type: "filter",
        expression: { op: "text", query1: "あ".repeat(50000) },
      }),
    ).toThrow("128KiB");
  });
});
