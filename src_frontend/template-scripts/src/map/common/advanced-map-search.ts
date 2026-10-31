/** Vue の地図ページと、単独で開く全画面の地図で共有する。 */
export interface AttributeCondition {
  field_id: string;
  field_type: string;
  op: string;
  value?: unknown;
  upper?: unknown;
}
export interface AttributeSearchRequest {
  common_form_id: string;
  definition_version: number;
  layer_ids: string[] | null;
  conditions: AttributeCondition[];
  targets?: { target_type: "marker" | "shape"; id: string }[];
}
export interface AttributeSearchResult {
  common_form_id: string;
  definition_version: number;
  as_of: string;
  marker_ids: string[];
  shape_ids: string[];
  target_count: number;
}
interface Field {
  id: string;
  label: string;
  type: string;
  choices?: string[];
}
interface CommonForm {
  id: string;
  version: number;
  form_title: string;
  form_schema: { fields: Field[] };
}
export type AttributeTransport = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
) => Promise<unknown>;
export const attributeSearchPath = "/map-objects/search/attributes";
const supported = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "image",
]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function attributeOperations(type: string): [string, string][] {
  const common: [string, string][] = [
    ["filled", "入力あり"],
    ["empty", "未入力"],
    ["missing", "項目なし"],
  ];
  if (type === "number" || type === "date")
    return [
      ["eq", "等しい"],
      ["gte", type === "date" ? "以降" : "以上"],
      ["lte", type === "date" ? "以前" : "以下"],
      ["between", "範囲"],
      ...common,
    ];
  if (type === "select" || type === "radio") return [["in", "選択値のいずれか"], ...common];
  if (type === "checkbox") return [["eq", "等しい"], ...common];
  if (type === "image") return common;
  return [["contains", "含む"], ["eq", "完全一致"], ...common];
}

export function validateAttributeResult(
  value: unknown,
  request: AttributeSearchRequest,
): AttributeSearchResult {
  const r = value as AttributeSearchResult;
  if (
    !r ||
    r.common_form_id !== request.common_form_id ||
    r.definition_version !== request.definition_version ||
    typeof r.as_of !== "string" ||
    !Array.isArray(r.marker_ids) ||
    !Array.isArray(r.shape_ids) ||
    [...r.marker_ids, ...r.shape_ids].some((id) => typeof id !== "string" || !id) ||
    new Set(r.marker_ids).size !== r.marker_ids.length ||
    new Set(r.shape_ids).size !== r.shape_ids.length ||
    r.target_count !== r.marker_ids.length + r.shape_ids.length
  )
    throw Error("検索結果を確認できませんでした。");
  return r;
}

/** テンプレートページには Cookie 認証を使い、Vue 側からは既存の Axios アダプターを渡す。 */
export const attributeTransport: AttributeTransport = async (path, body, signal) => {
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response = await fetch(path, init);
  if (response.status === 401) {
    const renewed = await fetch("/account/refresh", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (renewed.ok) response = await fetch(path, init);
  }
  if (!response.ok) {
    if (response.status === 409)
      throw Error("共通フォームが変更されました。開き直して条件を確認してください。");
    if (response.status === 404)
      throw Error("共通フォームまたはレイヤーが見つかりません。開き直してください。");
    if (response.status === 401) throw Error("再ログインしてください。");
    const data = await response.json().catch(() => null);
    throw Error(
      data?.error?.replace(/^validation error:\s*/, "") || "検索結果を取得できませんでした。",
    );
  }
  return response.json();
};

interface ModalOptions {
  transport: AttributeTransport;
  getApplied(): AttributeSearchRequest | null;
  getLayerIds(): string[] | null;
  getContext(): string;
  onApply(request: AttributeSearchRequest | null, result: AttributeSearchResult | null): void;
}

export function createAdvancedMapSearchModal(options: ModalOptions) {
  const dialog = document.createElement("dialog");
  dialog.className = "advanced-map-search";
  dialog.setAttribute("aria-label", "詳しい検索");
  const styleId = "advanced-map-search-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    // テンプレートページでは Vue の全体用 CSS を読み込まないため、ここでも操作部品を定義する。
    // github.css が body の最後の子要素の余白を上書きするため、auto の余白を使わず中央に配置する。
    style.textContent = `
      .advanced-map-search {
        box-sizing: border-box;
        position: fixed;
        top: 50%;
        left: 50%;
        right: auto;
        bottom: auto;
        transform: translate(-50%, -50%);
        width: min(920px, calc(100% - 32px));
        height: fit-content;
        max-height: calc(100dvh - 32px);
        overflow: auto;
        margin: 0;
        border: 1px solid #aaa;
        border-radius: 10px;
        padding: 20px;
        background: whitesmoke;
        color: #222;
        font: 16px/1.4 sans-serif;
        text-align: left;
      }
      .advanced-map-search::backdrop { background: #0008; }
      .advanced-map-search *, .advanced-map-search *::before, .advanced-map-search *::after {
        box-sizing: border-box;
      }
      .advanced-map-search header, .advanced-map-search footer {
        display: flex;
        align-items: center;
        gap: 12px;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .advanced-map-search h2 { margin: 0; border-bottom: 0; font-size: 24px; font-weight: 700; }
      .advanced-map-search p { margin: 16px 0; }
      .advanced-map-search label {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
        margin: 0;
        font-weight: 400;
      }
      .advanced-map-search select, .advanced-map-search input, .advanced-map-search button {
        font: inherit;
        padding: 8px;
        margin: 0;
        max-width: 100%;
      }
      .advanced-map-search select, .advanced-map-search input {
        font-weight: 400;
        min-width: 0;
        border: 1px solid #767676;
        border-radius: 6px;
        background: white;
        color: #222;
      }
      .advanced-map-search input[type="checkbox"] { padding: 0; flex-shrink: 0; }
      .advanced-map-search button {
        border: 1px solid transparent;
        border-radius: 8px;
        background: #5f5f5f;
        color: white;
        font-weight: 500;
        box-shadow: 0 2px 2px #0003;
        transition: border-color 0.25s;
        cursor: pointer;
      }
      .advanced-map-search button:hover { border-color: #396cd8; }
      .advanced-map-search button:active { background: #e8e8e8; color: #222; }
      .advanced-map-search .attribute-conditions {
        display: grid;
        gap: 16px;
        margin: 16px 0;
      }
      .advanced-map-search .attribute-conditions > button { justify-self: start; }
      .advanced-map-search .attribute-row {
        display: grid;
        grid-template-columns: 2fr 1.4fr 2fr auto;
        gap: 10px;
        padding: 12px 0;
        border-bottom: 1px solid #ccc;
        align-items: start;
      }
      .advanced-map-search .attribute-row select,
      .advanced-map-search .attribute-row input:not([type="checkbox"]) {
        height: calc(1.4em + 18px);
        line-height: 1.4;
      }
      .advanced-map-search .attribute-row > button {
        align-self: end;
        margin: 0;
        box-shadow: none;
      }
      .advanced-map-search .attribute-values { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .advanced-map-search .attribute-choice { flex-direction: row; align-items: center; overflow-wrap: anywhere; }
      .advanced-map-search footer { margin-top: 18px; }
      .advanced-map-search .attribute-error { color: #b42318; white-space: pre-wrap; }
      .advanced-map-search .attribute-submit { background: #2165bb; border-color: #2165bb; }
      .advanced-map-search button:disabled { cursor: wait; opacity: .6; }
      @media (max-width: 650px) {
        .advanced-map-search .attribute-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        .advanced-map-search .attribute-values { grid-column: 1 / -1; }
      }
    `;
    document.head.append(style);
  }
  document.body.append(dialog);
  let forms: CommonForm[] = [],
    formId = "",
    conditions: AttributeCondition[] = [];
  let sequence = 0,
    controller: AbortController | undefined,
    searchTimer: ReturnType<typeof setTimeout> | undefined,
    trigger: HTMLElement | null = null,
    busy = false,
    disposed = false;
  let status: HTMLParagraphElement;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, click: () => void, focusKey = text) => {
    const b = element("button", text);
    b.type = "button";
    b.dataset.focusKey = focusKey;
    b.addEventListener("click", click);
    return b;
  };
  const fieldList = () =>
    forms.find((f) => f.id === formId)?.form_schema.fields.filter((f) => supported.has(f.type)) ||
    [];
  const cancel = () => {
    ++sequence;
    clearTimeout(searchTimer);
    searchTimer = undefined;
    controller?.abort();
    busy = false;
  };
  const close = () => {
    cancel();
    if (dialog.open) {
      dialog.close();
      trigger?.focus();
    }
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const error = (message: string) => {
    status.textContent = message;
    status.className = "attribute-error";
  };
  const select = (
    choices: [string, string][],
    value: string,
    change: (value: string) => void,
    focusKey?: string,
  ) => {
    const s = element("select");
    if (focusKey) s.dataset.focusKey = focusKey;
    for (const [id, text] of choices) {
      const option = element("option", text);
      option.value = id;
      s.append(option);
    }
    s.value = value;
    s.addEventListener("change", () => change(s.value));
    return s;
  };
  const label = (text: string, control: HTMLElement) => {
    const l = element("label", text);
    l.append(control);
    return l;
  };
  const reset = (c: AttributeCondition, field: Field) => {
    c.field_id = field.id;
    c.field_type = field.type;
    c.op = attributeOperations(field.type)[0]![0];
    c.value =
      field.type === "checkbox"
        ? true
        : field.type === "select" || field.type === "radio"
          ? []
          : "";
    delete c.upper;
  };
  const search = async () => {
    if (busy) return;
    const form = forms.find((f) => f.id === formId);
    if (!form) {
      error("共通フォームを選択してください。");
      return;
    }
    for (const c of conditions) {
      const f = fieldList().find((f) => f.id === c.field_id && f.type === c.field_type);
      if (!f || !attributeOperations(f.type).some(([op]) => op === c.op)) {
        error("共通フォームが変更されています。条件を選び直してください。");
        return;
      }
      if (
        c.op === "in" &&
        (!Array.isArray(c.value) ||
          c.value.some((value) => typeof value !== "string" || !f.choices?.includes(value)))
      ) {
        error("現在の選択肢にない値があります。該当するチェックを外して選び直してください。");
        return;
      }
      if (
        !["filled", "empty", "missing"].includes(c.op) &&
        (c.value === "" ||
          c.value == null ||
          (Array.isArray(c.value) && !c.value.length) ||
          (c.op === "between" && !String(c.upper ?? "").trim()))
      ) {
        error("検索する値を入力してください。");
        return;
      }
    }
    const request: AttributeSearchRequest = {
      common_form_id: form.id,
      definition_version: form.version,
      layer_ids: options.getLayerIds(),
      conditions: clone(conditions),
    };
    const seq = ++sequence,
      context = options.getContext();
    clearTimeout(searchTimer);
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    busy = true;
    render();
    status.textContent = "検索中…";
    const timer = setTimeout(() => requestController.abort(), 60000);
    searchTimer = timer;
    try {
      const result = validateAttributeResult(
        await options.transport(attributeSearchPath, request, requestController.signal),
        request,
      );
      if (disposed || seq !== sequence || !dialog.open) return;
      if (context !== options.getContext()) {
        error("地図データが更新されました。もう一度検索してください。");
        return;
      }
      options.onApply(request, result);
      status.textContent = `属性条件のみの一致件数：${result.target_count}件`;
    } catch (e) {
      if (!disposed && seq === sequence && dialog.open)
        error(e instanceof Error ? e.message : "検索に失敗しました。");
    } finally {
      clearTimeout(timer);
      if (searchTimer === timer) searchTimer = undefined;
      if (seq === sequence) {
        busy = false;
        dialog.setAttribute("aria-busy", "false");
        dialog
          .querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("[data-busy]")
          .forEach((b) => (b.disabled = b.dataset.busy === "true"));
      }
    }
  };
  function render(focusKey?: string) {
    const active = document.activeElement;
    if (!focusKey && active instanceof HTMLElement && dialog.contains(active))
      focusKey = active.dataset.focusKey;
    dialog.setAttribute("aria-busy", String(busy));
    dialog.replaceChildren();
    const header = element("header");
    header.append(element("h2", "詳しい検索"), button("閉じる", close));
    dialog.append(header);
    dialog.append(
      element(
        "p",
        "対象・共通フォームごとの最新回答を検索します。複数条件はすべて一致する回答が対象です。",
      ),
    );
    const formSelect = select(
      [["", "共通フォームを選択"], ...forms.map((f) => [f.id, f.form_title] as [string, string])],
      formId,
      (value) => {
        formId = value;
        conditions = [];
        render();
      },
      "form",
    );
    dialog.append(label("共通フォーム", formSelect));
    if (!forms.length && !busy) dialog.append(element("p", "共通フォームはありません。"));
    const conditionList = element("div");
    conditionList.className = "attribute-conditions";
    conditions.forEach((c, index) => {
      const fields = fieldList(),
        field = fields.find((f) => f.id === c.field_id && f.type === c.field_type);
      const row = element("div");
      row.className = "attribute-row";
      row.append(
        label(
          "属性",
          select(
            fields.map((f) => [`${f.id}:${f.type}`, f.label]),
            `${c.field_id}:${c.field_type}`,
            (value) => {
              const f = fields.find((f) => `${f.id}:${f.type}` === value);
              if (f) reset(c, f);
              render();
            },
            `field-${index}`,
          ),
        ),
      );
      row.append(
        label(
          "比較方法",
          select(
            attributeOperations(c.field_type),
            c.op,
            (value) => {
              c.op = value;
              render();
            },
            `operator-${index}`,
          ),
        ),
      );
      const values = element("div");
      values.className = "attribute-values";
      if (!["filled", "empty", "missing"].includes(c.op)) {
        if (c.field_type === "select" || c.field_type === "radio") {
          const currentChoices = field?.choices || [];
          const savedChoices = Array.isArray(c.value)
            ? c.value.filter((value): value is string => typeof value === "string")
            : [];
          for (const [choiceIndex, choice] of [
            ...new Set([...currentChoices, ...savedChoices]),
          ].entries()) {
            const retired = !currentChoices.includes(choice);
            const input = element("input");
            input.type = "checkbox";
            input.value = choice;
            input.dataset.focusKey = `choice-${index}-${choiceIndex}`;
            input.checked = Array.isArray(c.value) && c.value.includes(choice);
            input.setAttribute("aria-invalid", String(retired && input.checked));
            input.addEventListener("change", () => {
              const selected = new Set(Array.isArray(c.value) ? c.value : []);
              if (input.checked) selected.add(choice);
              else selected.delete(choice);
              c.value = [...selected];
              input.setAttribute("aria-invalid", String(retired && input.checked));
            });
            const l = label(retired ? `${choice}（現在の選択肢にありません）` : choice, input);
            l.className = retired ? "attribute-choice attribute-error" : "attribute-choice";
            values.append(l);
          }
        } else if (c.field_type === "checkbox")
          values.append(
            label(
              "値",
              select(
                [
                  ["true", "はい"],
                  ["false", "いいえ"],
                ],
                String(c.value),
                (value) => (c.value = value === "true"),
                `value-${index}`,
              ),
            ),
          );
        else {
          const input = (upper: boolean) => {
            const i = element("input");
            i.type =
              c.field_type === "date" ? "date" : c.field_type === "number" ? "number" : "text";
            i.step = "any";
            i.dataset.focusKey = `value-${index}-${upper ? "upper" : "lower"}`;
            i.value = String((upper ? c.upper : c.value) ?? "");
            i.addEventListener("input", () => {
              if (upper) c.upper = i.value;
              else c.value = i.value;
            });
            return i;
          };
          values.append(label(c.op === "between" ? "開始値" : "値", input(false)));
          if (c.op === "between") values.append(label("終了値", input(true)));
        }
      }
      row.append(
        values,
        button(
          "削除",
          () => {
            conditions.splice(index, 1);
            render("条件を追加");
          },
          `remove-${index}`,
        ),
      );
      conditionList.append(row);
    });
    const add = button("条件を追加", () => {
      const field = fieldList()[0];
      if (field && conditions.length < 10) {
        const c = {} as AttributeCondition;
        reset(c, field);
        conditions.push(c);
        render(`field-${conditions.length - 1}`);
      }
    });
    add.disabled = !fieldList().length || conditions.length >= 10;
    conditionList.append(add);
    dialog.append(conditionList);
    status = element("p");
    status.setAttribute("role", "status");
    dialog.append(status);
    const footer = element("footer"),
      submit = button("検索", () => void search());
    submit.className = "attribute-submit";
    footer.append(
      button("属性条件を解除", () => {
        options.onApply(null, null);
        formId = "";
        conditions = [];
        render("属性条件を解除");
        status.textContent = "属性条件を解除しました。";
      }),
      submit,
    );
    dialog.append(footer);
    dialog
      .querySelectorAll<
        HTMLButtonElement | HTMLSelectElement | HTMLInputElement
      >("button,select,input")
      .forEach((b) => {
        if (b.textContent !== "閉じる") {
          b.dataset.busy = String(b.disabled);
          if (busy) b.disabled = true;
        }
      });
    if (focusKey && dialog.open) {
      const controls = [...dialog.querySelectorAll<HTMLElement>("[data-focus-key]")];
      const target =
        controls.find((node) => node.dataset.focusKey === focusKey && !node.matches(":disabled")) ??
        controls.find((node) => node.dataset.focusKey === "閉じる");
      target?.focus({ preventScroll: true });
    }
  }
  return {
    async open(from?: HTMLElement) {
      if (disposed) return;
      cancel();
      trigger = from || (document.activeElement as HTMLElement | null);
      const applied = options.getApplied();
      formId = applied?.common_form_id || "";
      conditions = clone(applied?.conditions || []);
      const seq = ++sequence;
      controller = new AbortController();
      busy = true;
      render();
      if (!dialog.open) dialog.showModal();
      status.textContent = "共通フォームを取得中…";
      try {
        const data = await options.transport("/common-forms", undefined, controller.signal);
        if (disposed || seq !== sequence || !dialog.open) return;
        if (!Array.isArray(data)) throw Error("共通フォームを取得できませんでした。");
        forms = data as CommonForm[];
        busy = false;
        render();
        if (
          applied &&
          !forms.some((f) => f.id === formId && f.version === applied.definition_version)
        )
          error("共通フォームが変更・削除されています。条件を確認してください。");
      } catch (e) {
        if (!disposed && seq === sequence) {
          busy = false;
          render();
          error(e instanceof Error ? e.message : "取得に失敗しました。");
        }
      }
    },
    close,
    dispose() {
      close();
      disposed = true;
      dialog.remove();
    },
  };
}
