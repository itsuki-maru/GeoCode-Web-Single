import { expect, it, vi } from "vitest";
import { createColoringEditor } from "../src/map/common/coloring-editor";
it("保存した分類の復元後に別の分類を追加でき、条件の変更後もフォーカスを維持する", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const apply = vi.fn(),
    fields = [{ id: "n", label: "年数", field_type: "number", choices: [] }];
  const editor = createColoringEditor(host, {
    forms: () => [{ id: "form", label: "設備" }],
    requiredForm: () => "",
    loadFields: async () => fields,
    apply,
    save: vi.fn(),
    active: () => false,
  });
  try {
    editor.restore(
      {
        common_form_id: "form",
        rules: [
          {
            id: "color-1",
            label: "保存条件",
            color: "#123456",
            conditions: [
              { field_id: "n", field_type: "number", op: "gte", value: "20", upper: null },
            ],
          },
        ],
      },
      fields,
    );
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "分類を追加")!
      .click();
    const input = host.querySelectorAll<HTMLInputElement>('[aria-label="色分けの条件値"]')[1]!;
    input.value = "10";
    input.dispatchEvent(new Event("input"));
    const op = host.querySelector<HTMLSelectElement>('[aria-label="色分けの比較方法"]')!;
    op.focus();
    op.value = "filled";
    op.dispatchEvent(new Event("change"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("色分けの比較方法");
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "色分け実行")!
      .click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(apply.mock.calls[0]![0].rules.map((r: { id: string }) => r.id)).toEqual([
      "color-1",
      "color-2",
    ]);
  } finally {
    editor.dispose();
    host.remove();
  }
});
