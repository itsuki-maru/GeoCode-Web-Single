import css from "./coloring-editor.css?inline";
import {
  answerConditionOperations,
  type AnswerField,
  type AnswerColorSpecification,
} from "./answer-coloring";
import { validatePresetDraft } from "./answer-map-presets";

export const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
export const action = (text: string, run: () => void) => {
  const el = node("button", text);
  el.type = "button";
  el.setAttribute("aria-label", text);
  el.onclick = run;
  return el;
};
const select = (items: [string, string][], value: string, change: (v: string) => void) => {
  const el = node("select");
  for (const [id, label] of items) {
    const o = node("option", label);
    o.value = id;
    el.append(o);
  }
  el.value = value;
  el.onchange = () => change(el.value);
  return el;
};
export function createColoringEditor(
  host: HTMLElement,
  options: {
    forms(): { id: string; label: string }[];
    requiredForm(): string;
    loadFields(id: string, signal: AbortSignal): Promise<AnswerField[]>;
    apply(value: AnswerColorSpecification | null): Promise<void> | void;
    save(value: AnswerColorSpecification): Promise<void> | void;
    active(): boolean;
    disabled?(): boolean;
    lazy?: boolean;
    collapsible?: boolean;
  },
) {
  if (!document.getElementById("map-coloring-editor-style")) {
    const style = node("style");
    style.id = "map-coloring-editor-style";
    style.textContent = css;
    document.head.append(style);
  }
  let draft: AnswerColorSpecification = { common_form_id: "", rules: [] },
    fields: AnswerField[] = [];
  let seq = 0,
    nextId = 0,
    busy = false,
    disposed = false,
    controller: AbortController | undefined;
  let error = "",
    started = !options.lazy;
  draft.common_form_id = options.requiredForm();
  const panel =
    options.collapsible === false
      ? node("section")
      : host instanceof HTMLDetailsElement
        ? host
        : node("details");
  if (panel instanceof HTMLDetailsElement) panel.open = true;
  panel.classList.add("color-panel", "map-coloring-editor");
  if (panel !== host) host.append(panel);
  const palette = [
    "#d73027",
    "#2166ac",
    "#1a9850",
    "#984ea3",
    "#e08214",
    "#008b8b",
    "#a65628",
    "#e7298a",
    "#666666",
    "#7570b3",
  ];
  const condition = (field: AnswerField) => ({
    field_id: field.id,
    field_type: field.field_type,
    op: answerConditionOperations(field.field_type)[0]!.value,
    value:
      field.field_type === "checkbox"
        ? true
        : ["select", "radio"].includes(field.field_type)
          ? []
          : "",
    upper: "",
  });
  const run = async (fn: () => Promise<void> | void) => {
    if (busy || disposed) return;
    const current = ++seq;
    busy = true;
    error = "";
    render();
    try {
      await fn();
    } catch (e) {
      if (current === seq) error = e instanceof Error ? e.message : "処理に失敗しました。";
    } finally {
      if (current === seq && !disposed) {
        busy = false;
        render();
      }
    }
  };
  const load = (id: string) =>
    void run(async () => {
      controller?.abort();
      controller = new AbortController();
      const current = seq;
      const next = id ? await options.loadFields(id, controller.signal) : [];
      if (current !== seq || disposed) return;
      draft = { common_form_id: id, rules: [] };
      fields = next;
    });
  function render() {
    if (disposed) return;
    const focused =
      document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
        ? document.activeElement.dataset.coloringFocus
        : undefined;
    panel.replaceChildren(node(options.collapsible === false ? "h3" : "summary", "地図で色分け"));
    const controls = node("fieldset");
    controls.disabled = busy || !!options.disabled?.();
    const label = node("label", "共通フォーム");
    label.className = "color-form";
    const form = select(
      [
        ["", "選択してください"],
        ...options
          .forms()
          .filter((f) => !options.requiredForm() || f.id === options.requiredForm())
          .map((f) => [f.id, f.label] as [string, string]),
      ],
      draft.common_form_id,
      load,
    );
    form.setAttribute("aria-label", "色分けの共通フォーム");
    label.append(form);
    controls.append(label);
    const add = action("分類を追加", () => {
      const f = fields[0];
      if (!f || draft.rules.length >= 10) return;
      let id: string;
      do {
        id = `color-${++nextId}`;
      } while (draft.rules.some((rule) => rule.id === id));
      draft.rules.push({
        id,
        label: `分類${draft.rules.length + 1}`,
        color: palette[draft.rules.length]!,
        conditions: [condition(f)],
      });
      render();
    });
    add.disabled = !fields.length || draft.rules.length >= 10;
    const clear = action("色分け解除", () => void run(() => options.apply(null)));
    clear.disabled = !options.active();
    const panelActions = node("div");
    panelActions.className = "color-actions";
    panelActions.append(add, clear);
    controls.append(panelActions);
    const addCondition = (rule: AnswerColorSpecification["rules"][number]) => {
      const button = action("分類条件を追加", () => {
        if (fields[0]) rule.conditions.push(condition(fields[0]));
        render();
      });
      button.disabled = rule.conditions.length >= 10;
      return button;
    };
    draft.rules.forEach((rule, index) => {
      const section = node("section");
      section.className = "color-rule";
      for (const [text, type, key] of [
        ["分類名", "text", "label"],
        ["分類の色", "color", "color"],
      ] as const) {
        const l = node("label", key === "color" ? "色" : text),
          input = node("input");
        input.type = type;
        input.value = rule[key];
        input.maxLength = 100;
        input.setAttribute("aria-label", text);
        input.oninput = () => {
          rule[key] = input.value;
        };
        if (key === "color") l.className = "color-picker";
        l.append(input);
        section.append(l);
      }
      const ruleActions = node("div");
      ruleActions.className = "color-actions";
      for (const direction of [-1, 1]) {
        const b = action(direction < 0 ? "分類を上へ" : "分類を下へ", () => {
          const [r] = draft.rules.splice(index, 1);
          draft.rules.splice(index + direction, 0, r!);
          render();
        });
        b.textContent = direction < 0 ? "↑" : "↓";
        b.disabled = index + direction < 0 || index + direction >= draft.rules.length;
        ruleActions.append(b);
      }
      ruleActions.append(
        action("分類を削除", () => {
          draft.rules.splice(index, 1);
          render();
        }),
      );
      section.append(ruleActions);
      rule.conditions.forEach((c, ci) => {
        const row = node("div");
        row.className = "color-condition";
        const field = fields.find((f) => f.id === c.field_id && f.field_type === c.field_type);
        const fieldSelect = select(
          fields.map((f) => [`${f.id}:${f.field_type}`, f.label]),
          `${c.field_id}:${c.field_type}`,
          (value) => {
            const f = fields.find((f) => `${f.id}:${f.field_type}` === value);
            if (f) rule.conditions[ci] = condition(f);
            render();
          },
        );
        fieldSelect.setAttribute("aria-label", "色分けの入力項目");
        const op = select(
          answerConditionOperations(String(c.field_type)).map((o) => [o.value, o.label]),
          String(c.op),
          (value) => {
            c.op = value;
            render();
          },
        );
        op.setAttribute("aria-label", "色分けの比較方法");
        row.append(fieldSelect, op);
        const valueControls = node("div");
        valueControls.className = "color-condition-values";
        if (!["empty", "filled", "missing"].includes(String(c.op))) {
          if (["select", "radio"].includes(String(c.field_type))) {
            const values = node("select");
            values.multiple = true;
            values.setAttribute("aria-label", "色分けの選択値");
            for (const choice of field?.choices || []) {
              const o = node("option", choice);
              o.value = choice;
              o.selected = Array.isArray(c.value) && c.value.includes(choice);
              values.append(o);
            }
            values.onchange = () => {
              c.value = [...values.selectedOptions].map((o) => o.value);
            };
            valueControls.append(values);
          } else if (c.field_type === "checkbox") {
            const value = select(
              [
                ["true", "はい"],
                ["false", "いいえ"],
              ],
              String(c.value),
              (v) => {
                c.value = v === "true";
              },
            );
            value.setAttribute("aria-label", "色分けの登録値");
            valueControls.append(value);
          } else
            for (const key of c.op === "between" ? ["value", "upper"] : ["value"]) {
              const input = node("input");
              input.type = c.field_type === "date" ? "date" : "text";
              if (c.field_type === "number") input.inputMode = "decimal";
              input.value = String(c[key] ?? "");
              input.setAttribute(
                "aria-label",
                key === "upper" ? "色分けの範囲終了値" : "色分けの条件値",
              );
              input.oninput = () => {
                c[key] = input.value;
              };
              if (key === "upper") valueControls.append(node("span", "〜"));
              valueControls.append(input);
            }
        }
        row.append(valueControls);
        const rowActions = node("div");
        rowActions.className = "color-condition-actions";
        rowActions.append(
          action("分類条件を削除", () => {
            rule.conditions.splice(ci, 1);
            render();
          }),
        );
        if (ci === rule.conditions.length - 1) rowActions.append(addCondition(rule));
        row.append(rowActions);
        section.append(row);
      });
      if (!rule.conditions.length) section.append(addCondition(rule));
      controls.append(section);
    });
    const specification = () => {
      validatePresetDraft({ kind: "coloring", definition: draft });
      return structuredClone(draft);
    };
    const apply = action("色分け実行", () => void run(() => options.apply(specification()))),
      save = action("検索条件を保存", () => void run(() => options.save(specification())));
    apply.className = "color-submit";
    save.className = "color-save";
    apply.disabled = save.disabled = !draft.rules.length;
    controls.append(apply, save);
    const help = node(
      "p",
      "分類は最大10件、各分類は最大10件のAND条件です。一覧・絞り込み・各分類の条件は合計20件までです。重複時は上の分類を優先し、未分類は元の色を維持します。",
    );
    help.className = "color-help";
    const status = node(
      "p",
      busy
        ? "入力項目を取得中…"
        : options.active()
          ? "色分けを反映済みです。編集後は「色分け実行」で反映します。"
          : "色分けは未適用です。",
    );
    status.className = "color-help";
    panel.append(controls, help, status);
    if (error) {
      const message = node("p", error);
      message.setAttribute("role", "alert");
      message.className = "color-error";
      panel.append(message);
    }
    const counts = new Map<string, number>();
    for (const el of panel.querySelectorAll<HTMLElement>("input,select,button,summary")) {
      const label = el.getAttribute("aria-label") || el.textContent || el.tagName;
      const index = counts.get(label) || 0;
      counts.set(label, index + 1);
      el.dataset.coloringFocus = `${label}:${index}`;
      if (el.dataset.coloringFocus === focused && !el.matches(":disabled"))
        el.focus({ preventScroll: true });
    }
  }
  const refresh = () => {
    const required = options.requiredForm();
    if (
      started &&
      !busy &&
      !options.disabled?.() &&
      required &&
      (required !== draft.common_form_id || (!fields.length && !error))
    )
      load(required);
    else render();
  };
  if (panel instanceof HTMLDetailsElement)
    panel.ontoggle = () => {
      if (panel.open) {
        started = true;
        refresh();
      }
    };
  render();
  return {
    refresh,
    restore(value: AnswerColorSpecification, candidates: AnswerField[]) {
      validatePresetDraft({ kind: "coloring", definition: value });
      if (options.requiredForm() && value.common_form_id !== options.requiredForm())
        throw Error("現在の絞り込みと共通フォームが異なるため呼び出せません。");
      for (const rule of value.rules)
        for (const c of rule.conditions) {
          const f = candidates.find((f) => f.id === c.field_id && f.field_type === c.field_type);
          if (!f || (Array.isArray(c.value) && c.value.some((v) => !f.choices.includes(v))))
            throw Error("保存した条件の項目が見つかりません。項目と選択肢を確認してください。");
        }
      ++seq;
      controller?.abort();
      busy = false;
      draft = structuredClone(value);
      fields = candidates;
      if (panel instanceof HTMLDetailsElement) panel.open = true;
      render();
    },
    dispose() {
      disposed = true;
      ++seq;
      controller?.abort();
      panel.remove();
    },
  };
}
