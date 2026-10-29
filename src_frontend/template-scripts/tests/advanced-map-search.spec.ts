import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
afterEach(() => {
  modal?.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("advanced map search", () => {
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
    click("検索");
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
    expect(document.querySelector('[role="status"]')?.textContent).toBe("検索結果：0件");
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
    click("検索");
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
    click("検索");
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
    click("検索");
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
    click("検索");
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
        ];
      });
    const fullScreenStyles = styles();
    const pageStyle = document.createElement("style");
    try {
      // Load the actual top page's global CSS, which is absent on the full-screen page.
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
      // Match the full-screen page, including Markdown's !important first/last-child margins.
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
      // Appended dialogs are the last body child. Zero bottom margin must not anchor them below.
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
    "shows retired %s choices and requires explicitly removing them",
    async (type) => {
      const transport = vi.fn(async (_path: string, body: unknown) =>
        body === undefined
          ? [
              {
                id: "form",
                version: 2,
                form_title: "設備",
                form_schema: {
                  fields: [{ id: "status", label: "区分", type, choices: ["新しい値"] }],
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
      const retiredLabel = [...document.querySelectorAll<HTMLLabelElement>("dialog label")].find(
        (label) => label.textContent?.includes("古い値（現在の選択肢にありません）"),
      );
      expect(retiredLabel).toBeDefined();
      const retired = retiredLabel!.querySelector<HTMLInputElement>("input")!;
      expect(retired.checked).toBe(true);
      const current = [...document.querySelectorAll<HTMLLabelElement>("dialog label")]
        .find((label) => label.textContent === "新しい値")!
        .querySelector<HTMLInputElement>("input")!;
      current.checked = true;
      current.dispatchEvent(new Event("change"));
      click("検索");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
      expect(document.querySelector('[role="status"]')?.textContent).toContain("選択肢にない値");
      retired.checked = false;
      retired.dispatchEvent(new Event("change"));
      click("検索");
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
      expect(transport.mock.calls[1]![1]).toMatchObject({
        definition_version: 2,
        conditions: [{ value: ["新しい値"] }],
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
    expect(document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')?.checked).toBe(
      true,
    );
    click("検索");
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
        // A token-refresh interceptor can outlive the original signal's abort.
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
    click("検索");
    await vi.advanceTimersByTimeAsync(30000);
    click("閉じる");
    expect(searches[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await modal.open();
    click("検索");
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
    click("検索");
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
    click("検索");
    expect(vi.getTimerCount()).toBe(1);
    modal.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(apply).not.toHaveBeenCalled();
  });
});
