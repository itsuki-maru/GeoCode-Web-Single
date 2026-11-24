import css from "./ai-condition-editor.css?inline";
import { action, node } from "./coloring-editor";
import { answerConditionOperations, type AnswerField } from "./answer-coloring";
import type { SavedMapPreset } from "./answer-map-presets";
import type { AiDefinition } from "../../ai/types";
import type { AttributeTransport } from "./advanced-map-search";

import {
  noValue,
  validateAiEditorDefinition,
  type Condition,
  type Definition,
  type Expression,
} from "./preset-definition";

interface FormMetadata {
  fields: AnswerField[];
  error?: string;
}
type EditorOptions = {
  definition: AiDefinition;
  display?: SavedMapPreset["display"];
  onChange?(draft: AiDefinition): void;
  onClear?(): void;
} & (
  | { transport: AttributeTransport; getLayerIds(): string[] | null }
  | {
      getForms(signal: AbortSignal): Promise<{ id: string; form_title: string }[]>;
      getFields(id: string, signal: AbortSignal): Promise<{ fields: AnswerField[] }>;
    }
);
export { validateAiEditorDefinition } from "./preset-definition";
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "項目情報を読み込めませんでした。";

const savedFieldLabel = (
  display: SavedMapPreset["display"] | undefined,
  form: string,
  condition: Condition,
) =>
  display?.fields.find(
    (field) =>
      field.id === condition.field_id &&
      field.field_type === condition.field_type &&
      (!field.form_id || field.form_id === form),
  )?.label || condition.field_id;

function checkDefinitionFields(
  definition: Definition,
  fields: (formId: string) => readonly AnswerField[],
  display?: SavedMapPreset["display"],
) {
  const check = (form: string, conditions: Condition[]) => {
    const candidates = fields(form);
    for (const condition of conditions) {
      const field = candidates.find(
        (field) => field.id === condition.field_id && field.field_type === condition.field_type,
      );
      if (!field)
        throw Error(
          `「${savedFieldLabel(display, form, condition)}」の項目または型が見つかりません。条件を修正してください。`,
        );
      if (
        !noValue.has(condition.op) &&
        (condition.field_type === "select" || condition.field_type === "radio") &&
        Array.isArray(condition.value) &&
        condition.value.some((value) => !field.choices.includes(String(value)))
      )
        throw Error(`「${field.label}」に現在使えない選択値があります。条件を修正してください。`);
    }
  };
  const visit = (expression: Expression): void => {
    if (expression.op === "attribute") check(expression.common_form_id, expression.conditions);
    else if (expression.op === "not") visit(expression.child);
    else if (expression.op === "and" || expression.op === "or") expression.children.forEach(visit);
  };
  if (definition.type === "filter") visit(definition.expression);
  else definition.rules.forEach((rule) => check(definition.common_form_id, rule.conditions));
}

export function validateAiDefinitionFields(
  value: AiDefinition,
  fields: (formId: string) => readonly AnswerField[],
  display?: SavedMapPreset["display"],
): AiDefinition {
  const definition = validateAiEditorDefinition(value);
  checkDefinitionFields(definition, fields, display);
  return definition;
}

/** 下書きだけを編集する。実行・保存・ブラウザーへの永続化は呼出側の責務。 */
export function createAiConditionEditor(host: HTMLElement, options: EditorOptions) {
  if (!document.getElementById("ai-condition-editor-style")) {
    const style = node("style");
    style.id = "ai-condition-editor-style";
    style.textContent = css;
    document.head.append(style);
  }
  // 不明な式を一部だけ読み込んで、意味が変わった下書きを作らない。
  const draft = validateAiEditorDefinition(options.definition);
  const panel = node("section");
  panel.className =
    draft.type === "color" ? "ai-condition-editor map-coloring-editor" : "ai-condition-editor";
  panel.setAttribute("aria-label", "保存条件の編集");
  host.append(panel);
  const metadata = new Map<string, FormMetadata>();
  let forms: { id: string; label: string }[] = [];
  let disabled = false;
  let loading = false;
  let ready = false;
  let disposed = false;
  let sequence = 0;
  let controller: AbortController | undefined;
  let pendingMetadata: Promise<void> = Promise.resolve();
  let metadataError = "";
  let metadataFailed = false;
  let feedback: HTMLParagraphElement;
  let nextKey = 0;
  const keys = new WeakMap<object, number>();
  const key = (value: object, name: string) => {
    let id = keys.get(value);
    if (!id) keys.set(value, (id = ++nextKey));
    return `${id}:${name}`;
  };
  const focus = <T extends HTMLElement>(element: T, value: object, name: string) => {
    element.dataset.aiConditionFocus = key(value, name);
    return element;
  };
  const formIds = () => {
    const ids = new Set<string>();
    const visit = (expression: Expression): void => {
      if (expression.op === "attribute") ids.add(expression.common_form_id);
      else if (expression.op === "not") visit(expression.child);
      else if (expression.op === "and" || expression.op === "or")
        expression.children.forEach(visit);
    };
    if (draft.type === "filter") visit(draft.expression);
    else ids.add(draft.common_form_id);
    return [...ids].filter(Boolean);
  };
  const fields = (form: string) => metadata.get(form)?.fields ?? [];
  const getDefinition = (): AiDefinition => {
    if (disposed) throw Error("条件編集画面は閉じられています。");
    const definition = validateAiEditorDefinition(draft);
    if (metadataError) throw Error(metadataError);
    if (!ready || loading) throw Error("項目情報の読み込み完了後に実行してください。");
    for (const id of formIds()) {
      const data = metadata.get(id);
      if (!data || data.error)
        throw Error(data?.error || "共通フォームの項目情報を読み直してください。");
    }
    checkDefinitionFields(definition, fields, options.display);
    return definition;
  };
  function updateFeedback() {
    if (!feedback) return;
    let text = "";
    try {
      getDefinition();
    } catch (error) {
      text = message(error);
    }
    feedback.textContent = loading ? "項目情報を読み込んでいます…" : text;
    feedback.classList.toggle("is-error", !!text && !loading);
    panel.setAttribute("aria-busy", String(loading));
  }
  const changed = (redraw = false) => {
    options.onChange?.(clone(draft) as unknown as AiDefinition);
    if (redraw) render();
    else updateFeedback();
  };
  const label = (name: string, element: HTMLElement) => {
    const wrapper = node("label", name);
    element.setAttribute("aria-label", name);
    wrapper.append(element);
    return wrapper;
  };
  const select = (items: [string, string][], value: string, change: (value: string) => void) => {
    const element = node("select");
    for (const [id, title] of items) {
      const option = node("option", title);
      option.value = id;
      element.append(option);
    }
    element.value = value;
    element.addEventListener("change", () => change(element.value));
    return element;
  };
  const input = (value: string, update: (value: string) => void, max = 5000) => {
    const element = node("input");
    element.type = "text";
    element.value = value;
    element.maxLength = max;
    element.addEventListener("input", () => {
      update(element.value);
      changed();
    });
    return element;
  };
  const dateInput = (element: HTMLInputElement) => {
    const saved = element.value;
    element.type = "date";
    // HTMLの日付欄で表せない保存値も、空欄へ変換して隠さない。
    if (element.value !== saved) {
      element.type = "text";
      element.value = saved;
      element.placeholder = "YYYY-MM-DD";
    }
  };
  const buttons = () => {
    const row = node("div");
    row.className = "ai-editor-actions";
    return row;
  };
  function defaultCondition(field: AnswerField): Condition {
    return {
      field_id: field.id,
      field_type: field.field_type,
      op: answerConditionOperations(field.field_type)[0]!.value,
      value:
        field.field_type === "checkbox"
          ? true
          : field.field_type === "select" || field.field_type === "radio"
            ? []
            : "",
    };
  }
  function formPicker(form: string, owner: object, update: (value: string) => void) {
    const items: [string, string][] = [
      ["", "選択してください"],
      ...forms.map((f) => [f.id, f.label] as [string, string]),
    ];
    if (form && !items.some(([id]) => id === form))
      items.push([form, `${options.display?.form_label || form}（保存時のフォーム）`]);
    const control = focus(
      select(items, form, (value) => {
        update(value);
        changed(true);
        // フォームを変えても既存条件を消さず、新しい定義との不整合を示す。
        void refreshMetadata();
      }),
      owner,
      "form",
    );
    return label("共通フォーム", control);
  }
  function renderConditions(
    form: string,
    conditions: Condition[],
    parent: HTMLElement,
    coloring = false,
  ) {
    const list = coloring ? parent : node("div");
    if (!coloring) {
      list.className = "attribute-conditions";
      parent.append(list);
    }
    const add = action(coloring ? "分類条件を追加" : "条件を追加", () => {
      const field = fields(form)[0];
      if (field && conditions.length < 10) {
        conditions.push(defaultCondition(field));
        changed(true);
      }
    });
    add.disabled = conditions.length >= 10 || !fields(form).length;
    const namedControl = (name: string, control: HTMLElement) => {
      if (!coloring) return label(name, control);
      control.setAttribute("aria-label", name);
      return control;
    };
    for (const [index, condition] of conditions.entries()) {
      const row = node("div");
      row.className = coloring
        ? "ai-editor-condition color-condition"
        : "ai-editor-condition attribute-row";
      const available = fields(form);
      const current = available.find(
        (field) => field.id === condition.field_id && field.field_type === condition.field_type,
      );
      const fieldKey = (field: Pick<AnswerField, "id" | "field_type">) =>
        `${field.id}:${field.field_type}`;
      const choices = available.map((field) => [fieldKey(field), field.label] as [string, string]);
      if (!current)
        choices.unshift([
          fieldKey({ id: condition.field_id, field_type: condition.field_type }),
          `${savedFieldLabel(options.display, form, condition)}（項目・型を確認）`,
        ]);
      row.append(
        namedControl(
          coloring ? "色分けの入力項目" : "属性",
          focus(
            select(
              choices,
              fieldKey({ id: condition.field_id, field_type: condition.field_type }),
              (value) => {
                const field = available.find((field) => fieldKey(field) === value);
                if (!field) return;
                const replacement = defaultCondition(field);
                condition.field_id = replacement.field_id;
                condition.field_type = replacement.field_type;
                condition.op = replacement.op;
                condition.value = replacement.value;
                delete condition.upper;
                changed(true);
              },
            ),
            condition,
            "field",
          ),
        ),
      );
      const operations = answerConditionOperations(condition.field_type).map((item) => {
        const title = coloring
          ? item.label
          : item.value === "between"
            ? "範囲"
            : item.value === "in"
              ? "選択値のいずれか"
              : item.value === "eq"
                ? ["number", "date", "checkbox"].includes(condition.field_type)
                  ? "等しい"
                  : "完全一致"
                : item.label;
        return [item.value, title] as [string, string];
      });
      row.append(
        namedControl(
          coloring ? "色分けの比較方法" : "比較方法",
          focus(
            select(operations, condition.op, (value) => {
              condition.op = value;
              changed(true);
            }),
            condition,
            "operation",
          ),
        ),
      );
      const values = node("div");
      values.className = coloring ? "color-condition-values" : "attribute-values";
      if (!noValue.has(condition.op)) {
        if (condition.field_type === "select" || condition.field_type === "radio") {
          const selected = Array.isArray(condition.value) ? condition.value.map(String) : [];
          const choices = [...new Set([...(current?.choices ?? []), ...selected])];
          const picker = node("select");
          picker.multiple = true;
          for (const value of choices) {
            const option = node(
              "option",
              `${value}${current?.choices.includes(value) ? "" : "（現在使えない値）"}`,
            );
            option.value = value;
            option.selected = selected.includes(value);
            picker.append(option);
          }
          picker.addEventListener("change", () => {
            condition.value = [...picker.selectedOptions].map((option) => option.value);
            changed();
          });
          values.append(
            namedControl(
              coloring ? "色分けの選択値" : "値（複数選択可）",
              focus(picker, condition, "value"),
            ),
          );
        } else if (condition.field_type === "checkbox") {
          values.append(
            namedControl(
              coloring ? "色分けの登録値" : "値",
              focus(
                select(
                  [
                    ["true", "はい"],
                    ["false", "いいえ"],
                  ],
                  String(condition.value),
                  (value) => {
                    condition.value = value === "true";
                    changed();
                  },
                ),
                condition,
                "value",
              ),
            ),
          );
        } else {
          const value = input(String(condition.value ?? ""), (value) => (condition.value = value));
          if (condition.field_type === "number") value.inputMode = "decimal";
          if (condition.field_type === "date") dateInput(value);
          values.append(
            namedControl(
              coloring ? "色分けの条件値" : condition.op === "between" ? "開始値" : "値",
              focus(value, condition, "value"),
            ),
          );
          if (condition.op === "between") {
            const upper = input(
              String(condition.upper ?? ""),
              (value) => (condition.upper = value),
            );
            if (condition.field_type === "number") upper.inputMode = "decimal";
            if (condition.field_type === "date") dateInput(upper);
            if (coloring) values.append(node("span", "〜"));
            values.append(
              namedControl(
                coloring ? "色分けの範囲終了値" : "終了値",
                focus(upper, condition, "upper"),
              ),
            );
          }
        }
      }
      const remove = focus(
        action(coloring ? "分類条件を削除" : "削除", () => {
          conditions.splice(conditions.indexOf(condition), 1);
          changed(true);
        }),
        condition,
        "delete",
      );
      row.append(values);
      if (coloring) {
        const actions = node("div");
        actions.className = "color-condition-actions";
        actions.append(remove);
        if (index === conditions.length - 1) actions.append(add);
        row.append(actions);
      } else row.append(remove);
      list.append(row);
    }
    if (!coloring || !conditions.length) list.append(add);
  }
  function renderExpression(
    value: Expression,
    replace: (next: Expression) => void,
    depth = 0,
  ): HTMLElement {
    const section = node("fieldset");
    section.className = "ai-editor-expression";
    if (depth === 0) section.classList.add("is-root");
    section.dataset.operation = value.op;
    const title =
      value.op === "not"
        ? "当てはまらない（NOT）"
        : value.op === "and"
          ? "すべて満たす（AND）"
          : value.op === "or"
            ? "いずれかを満たす（OR）"
            : "条件";
    if (depth > 0 || ["and", "or", "not"].includes(value.op)) section.append(node("legend", title));
    else section.setAttribute("aria-label", title);
    if (value.op === "and" || value.op === "or") {
      section.append(
        label(
          "条件の組合せ",
          focus(
            select(
              [
                ["and", "すべて満たす（AND）"],
                ["or", "いずれかを満たす（OR）"],
              ],
              value.op,
              (op) => {
                value.op = op as "and" | "or";
                changed(true);
              },
            ),
            value,
            "combination",
          ),
        ),
      );
      value.children.forEach((child) => {
        const part = renderExpression(
          child,
          (next) => {
            value.children[value.children.indexOf(child)] = next;
          },
          depth + 1,
        );
        const remove = action("この条件を削除", () => {
          value.children.splice(value.children.indexOf(child), 1);
          changed(true);
        });
        remove.disabled = value.children.length <= 1;
        part.append(remove);
        section.append(part);
      });
      if (value.children.length === 1)
        section.append(
          action("組合せを解除", () => {
            replace(value.children[0]!);
            changed(true);
          }),
        );
    } else if (value.op === "not") {
      section.append(node("p", "対象レイヤー全体から、この条件に当てはまる地物を除外します。"));
      section.append(renderExpression(value.child, (next) => (value.child = next), depth + 1));
      section.append(
        focus(
          action("除外を解除", () => {
            replace(value.child);
            changed(true);
          }),
          value,
          "unwrap",
        ),
      );
    } else {
      if (value.op === "text") {
        section.append(
          label(
            "検索語1",
            focus(
              input(value.query1, (text) => (value.query1 = text), 200),
              value,
              "query1",
            ),
          ),
        );
        section.append(
          label(
            "検索語2",
            focus(
              input(value.query2 ?? "", (text) => (value.query2 = text), 200),
              value,
              "query2",
            ),
          ),
        );
      } else if (value.op === "attribute") {
        if (depth === 0)
          section.append(
            node(
              "p",
              "対象・共通フォームごとの最新登録データを検索します。複数条件はすべて一致する登録が対象です。",
            ),
          );
        section.append(
          formPicker(value.common_form_id, value, (form) => (value.common_form_id = form)),
        );
        if (depth > 0)
          section.append(
            node("p", "このフォーム内の属性条件は、同じ登録に対してすべて満たす場合に一致します。"),
          );
        renderConditions(value.common_form_id, value.conditions, section);
      } else section.append(node("p", "対象レイヤーの全件を対象にします。"));
    }
    return section;
  }
  function render() {
    if (disposed) return;
    const active = panel.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.aiConditionFocus
      : undefined;
    const controls = node("fieldset");
    controls.className = "ai-editor-controls";
    controls.setAttribute(
      "aria-label",
      draft.type === "filter" ? "検索条件の編集" : "色分け条件の編集",
    );
    controls.disabled = disabled || loading;
    if (draft.type === "filter")
      controls.append(renderExpression(draft.expression, (value) => (draft.expression = value)));
    else {
      const form = formPicker(
        draft.common_form_id,
        draft,
        (value) => (draft.common_form_id = value),
      );
      form.className = "color-form";
      controls.append(form);
      const add = action("分類を追加", () => {
        let index = draft.rules.length + 1;
        while (draft.rules.some((rule) => rule.id === `edited-${index}`)) index++;
        draft.rules.push({
          id: `edited-${index}`,
          label: `分類${draft.rules.length + 1}`,
          color: "#2165bb",
          conditions: [],
        });
        changed(true);
      });
      add.disabled = draft.rules.length >= 10 || !fields(draft.common_form_id).length;
      const panelActions = node("div");
      panelActions.className = "color-actions";
      panelActions.append(add);
      if (options.onClear) panelActions.append(action("色分け解除", options.onClear));
      controls.append(panelActions);
      draft.rules.forEach((rule, index) => {
        const section = node("section");
        section.className = "ai-editor-rule color-rule";
        section.setAttribute("aria-label", `分類${index + 1}`);
        section.append(
          label(
            "分類名",
            focus(
              input(rule.label, (value) => (rule.label = value), 200),
              rule,
              "label",
            ),
          ),
        );
        const color = input(rule.color, (value) => (rule.color = value), 7);
        color.type = "color";
        const colorLabel = label("色", focus(color, rule, "color"));
        color.setAttribute("aria-label", "分類の色");
        colorLabel.className = "color-picker";
        section.append(colorLabel);
        const order = buttons();
        order.classList.add("color-actions");
        for (const [title, target] of [
          ["分類を上へ", index - 1],
          ["分類を下へ", index + 1],
        ] as const) {
          const move = focus(
            action(title, () => {
              [draft.rules[index], draft.rules[target]] = [
                draft.rules[target]!,
                draft.rules[index]!,
              ];
              changed(true);
            }),
            rule,
            title,
          );
          move.textContent = target < index ? "↑" : "↓";
          move.disabled = target < 0 || target >= draft.rules.length;
          order.append(move);
        }
        const remove = action("分類を削除", () => {
          draft.rules.splice(draft.rules.indexOf(rule), 1);
          changed(true);
        });
        remove.disabled = draft.rules.length <= 1;
        order.append(remove);
        section.append(order);
        renderConditions(draft.common_form_id, rule.conditions, section, true);
        controls.append(section);
      });
      const help = node("p", "複数の分類に一致する場合は、上にある分類を優先します。");
      help.className = "color-help";
      controls.append(help);
    }
    feedback = node("p");
    feedback.className = "ai-editor-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    panel.replaceChildren(controls, feedback);
    // 取得の失敗と、取得済み定義に対する入力エラーを区別して再試行を表示する。
    if (
      metadataFailed &&
      !loading &&
      (metadataError || formIds().some((id) => metadata.get(id)?.error))
    ) {
      const retry = action("再試行", () => {
        if (disabled || loading || disposed) return;
        void refreshMetadata();
      });
      retry.className = "ai-editor-retry";
      retry.disabled = disabled;
      panel.append(retry);
    }
    updateFeedback();
    if (active)
      [...panel.querySelectorAll<HTMLElement>("[data-ai-condition-focus]")]
        .find((element) => element.dataset.aiConditionFocus === active)
        ?.focus();
  }
  function refreshMetadata(signal?: AbortSignal): Promise<void> {
    pendingMetadata = loadMetadata(signal);
    return pendingMetadata;
  }
  async function loadMetadata(signal?: AbortSignal): Promise<void> {
    if (disposed) return;
    controller?.abort();
    const current = ++sequence;
    const request = new AbortController();
    controller = request;
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) request.abort();
    const timer = setTimeout(() => request.abort(), 60000);
    const scopeKey = () => ("getLayerIds" in options ? JSON.stringify(options.getLayerIds()) : "");
    const scope = scopeKey();
    const active = () =>
      !disposed && current === sequence && !request.signal.aborted && scope === scopeKey();
    loading = true;
    ready = false;
    metadataError = "";
    metadataFailed = false;
    render();
    try {
      const response =
        "getForms" in options
          ? await options.getForms(request.signal)
          : await options.transport("/common-forms", undefined, request.signal);
      if (!active()) return;
      if (
        !Array.isArray(response) ||
        response.some(
          (value) =>
            !record(value) || typeof value.id !== "string" || typeof value.form_title !== "string",
        )
      )
        throw Error("共通フォームの一覧を確認できませんでした。");
      forms = response.map((value) => ({ id: String(value.id), label: String(value.form_title) }));
      const next = new Map<string, FormMetadata>();
      for (const id of formIds()) {
        try {
          const data =
            "getFields" in options
              ? await options.getFields(id, request.signal)
              : await options.transport(
                  "/form-answers/map-filter",
                  {
                    query: { mode: "latest" },
                    scope: { kind: "layers", layer_ids: options.getLayerIds() },
                    common_form_id: id,
                    conditions: [],
                    options_only: true,
                  },
                  request.signal,
                );
          if (!active()) return;
          if (
            !record(data) ||
            !Array.isArray(data.fields) ||
            data.fields.some(
              (field) =>
                !record(field) ||
                typeof field.id !== "string" ||
                typeof field.field_type !== "string" ||
                typeof field.label !== "string" ||
                !Array.isArray(field.choices) ||
                field.choices.some((choice) => typeof choice !== "string"),
            )
          )
            throw Error("入力項目を確認できませんでした。");
          next.set(id, { fields: clone(data.fields as unknown as AnswerField[]) });
        } catch (error) {
          if (!active()) return;
          metadataFailed = true;
          next.set(id, {
            fields: [],
            error: `共通フォームの項目情報を取得できませんでした。${message(error)}`,
          });
        }
      }
      if (!active()) return;
      metadata.clear();
      next.forEach((value, id) => metadata.set(id, value));
      ready = true;
    } catch (error) {
      if (active()) {
        metadataError = message(error);
        metadataFailed = true;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (current === sequence && !disposed) {
        loading = false;
        if (request.signal.aborted || scope !== scopeKey()) {
          ready = false;
          metadataFailed = true;
          metadataError = "項目情報の取得を中止しました。現在の対象で読み直してください。";
        }
        render();
      }
    }
  }
  render();
  return {
    getDefinition,
    getDraftDefinition: () => clone(draft) as unknown as AiDefinition,
    setDisabled(value: boolean) {
      disabled = value;
      const controls = panel.querySelector<HTMLFieldSetElement>(".ai-editor-controls");
      if (controls) controls.disabled = disabled || loading;
      const retry = panel.querySelector<HTMLButtonElement>(".ai-editor-retry");
      if (retry) retry.disabled = disabled || loading;
    },
    refreshMetadata,
    whenMetadataReady: () => pendingMetadata,
    dispose() {
      disposed = true;
      ++sequence;
      controller?.abort();
      metadata.clear();
      forms = [];
      panel.remove();
    },
  };
}
