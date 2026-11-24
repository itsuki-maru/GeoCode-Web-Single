import type { AiDefinition, AiExecutionResult } from "../../ai/types";
import type { AnswerColoring } from "./answer-coloring";
import { PresetText } from "./preset-text";
import {
  compareDecimals,
  decimal,
  validateAiEditorDefinition,
  type Condition,
  type Expression,
  type Definition,
} from "./preset-definition";

export interface PresetTarget {
  key: string;
  name: string;
  detail: string;
}
type Scope = { layer_ids?: string[] | null; query?: Record<string, unknown> };
type Transport = (
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type Field = { type: string; value: string | boolean | null };
interface Row {
  target: string;
  id: string;
  revision: number;
  form_id: string | null;
  fields: Record<string, Field>;
}
type Projection = Map<string, Set<string>>;
type Rows = Map<string, Map<string, Row>>;
type Cursor = { target: string; id: string };
const endpoint = "/form-answers/map-presets/data";
const chunkSize = 2048;
const maxForms = 64;
const maxFields = 1024;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = () =>
  Error("保存条件の判定用データを確認できませんでした。再度呼び出してください。");

// 編集途中でも、値の入力に先行して選択済みのフォーム・項目を準備できる。
export function presetReferences(
  definitions: readonly AiDefinition[],
  terms = new Set<string>(),
): Projection {
  const forms: Projection = new Map();
  function add(form: unknown, conditions: unknown) {
    if (typeof form !== "string" || !form) return;
    let fields = forms.get(form);
    if (!fields) forms.set(form, (fields = new Set()));
    if (Array.isArray(conditions))
      for (const item of conditions)
        if (record(item) && typeof item.field_id === "string" && item.field_id)
          fields.add(item.field_id);
  }
  function visit(expr: unknown) {
    if (!record(expr)) return;
    if (expr.op === "attribute") add(expr.common_form_id, expr.conditions);
    else if (expr.op === "text") {
      for (const term of [expr.query1, expr.query2])
        if (typeof term === "string" && term) terms.add(term);
    } else if (expr.op === "not") visit(expr.child);
    else if (Array.isArray(expr.children)) expr.children.forEach(visit);
  }
  for (const definition of definitions) {
    if (definition.type === "filter") visit(definition.expression);
    else if (definition.type === "color" && Array.isArray(definition.rules)) {
      add(definition.common_form_id, []);
      for (const rule of definition.rules)
        if (record(rule)) add(definition.common_form_id, rule.conditions);
    }
  }
  return forms;
}

function remaining(forms: Projection, covered: Projection): Projection {
  const missing: Projection = new Map();
  for (const [id, fields] of forms) {
    const existing = covered.get(id);
    const needed = new Set([...fields].filter((field) => !existing?.has(field)));
    if (!existing || needed.size) missing.set(id, needed);
  }
  return missing;
}

// 一覧の複数条件を合算すると、地物数とは別に一要求のフォーム数・項目数も上限に達する。
function projectionBatches(forms: Projection): [Projection, ...Projection[]] {
  // 登録地図では参照項目がなくても、件数に含める回答行を一度取得する。
  const batches: [Projection, ...Projection[]] = [new Map()];
  let batch = batches[0];
  let count = 0;
  for (const [id, fields] of forms) {
    const ids = [...fields];
    // 同じフォームを複数回問い合わせるのは、単独で上限を超えた場合だけにする。
    for (let i = 0; i === 0 || i < ids.length; i += maxFields) {
      const part = ids.slice(i, i + maxFields);
      if (batch.size === maxForms || count + part.length > maxFields) {
        batch = new Map();
        batches.push(batch);
        count = 0;
      }
      batch.set(id, new Set(part));
      count += part.length;
    }
  }
  return batches;
}

function matchesCondition(c: Condition): (row: Row) => boolean {
  const numeric = c.field_type === "number";
  const lower = numeric && c.value != null ? decimal(String(c.value)) : null;
  const upper = numeric && c.upper != null ? decimal(String(c.upper)) : null;
  return (row) => {
    const field = Object.prototype.hasOwnProperty.call(row.fields, c.field_id)
      ? row.fields[c.field_id]
      : undefined;
    if (c.op === "missing") return field?.type !== c.field_type;
    if (field?.type !== c.field_type) return false;
    const value = field.value;
    const empty = value === null || value === "";
    if (c.op === "empty") return empty;
    if (c.op === "filled") return !empty;
    if (value === null) return false;
    if (c.op === "contains") return typeof value === "string" && value.includes(c.value as string);
    if (c.op === "in") return (c.value as string[]).includes(value as string);
    if (c.field_type === "checkbox") return value === c.value;
    if (typeof value !== "string") return false;
    if (numeric) {
      // 登録値の形式は form_answers::typed_value の SQL と合わせる。
      if (!lower || !/^[+-]?\d{1,100}(?:\.\d{0,100})?(?:[eE][+-]?\d{1,3})?$/.test(value))
        return false;
      const current = decimal(value);
      const order = compareDecimals(current, lower);
      if (c.op === "between")
        return order >= 0 && upper !== null && compareDecimals(current, upper) <= 0;
      return c.op === "lte" ? order <= 0 : c.op === "gte" ? order >= 0 : order === 0;
    }
    if (c.op === "between") return value >= (c.value as string) && value <= (c.upper as string);
    if (c.op === "gte") return value >= (c.value as string);
    if (c.op === "lte") return value <= (c.value as string);
    return value === c.value;
  };
}

type Predicate = (target: PresetTarget, rows: readonly Row[]) => boolean;
function compileExpression(expr: Expression, text: PresetText): Predicate {
  switch (expr.op) {
    case "all":
      return () => true;
    case "text": {
      const terms = [expr.query1, expr.query2].filter((q): q is string => !!q);
      if (!terms.length) return () => true;
      const match = text.matcher(terms);
      let previous: PresetTarget | undefined;
      let matched = false;
      return (target) => {
        // 履歴の登録件数にかかわらず、地物の長い本文の照合は一度で済む。
        if (previous === target) return matched;
        previous = target;
        matched = match(target);
        return matched;
      };
    }
    case "attribute": {
      const checks = expr.conditions.map(matchesCondition);
      return (_, rows) =>
        rows.some(
          (row) => row.form_id === expr.common_form_id && checks.every((check) => check(row)),
        );
    }
    case "not": {
      const child = compileExpression(expr.child, text);
      return (target, rows) => !child(target, rows);
    }
    case "and":
    case "or": {
      const children = expr.children.map((child) => compileExpression(child, text));
      return expr.op === "and"
        ? (target, rows) => children.every((match) => match(target, rows))
        : (target, rows) => children.some((match) => match(target, rows));
    }
  }
}

function classifier(definition: Extract<Definition, { type: "color" }>) {
  const rules = definition.rules.map((rule) => rule.conditions.map(matchesCondition));
  const coloring: AnswerColoring = {
    version: 1,
    rules: definition.rules.map(({ id, label, color }) => ({ id, label, color })),
    targets: {},
  };
  return {
    coloring,
    classify(key: string, rows: readonly Row[]) {
      const index = rules.findIndex((checks) =>
        rows.some(
          (row) => row.form_id === definition.common_form_id && checks.every((check) => check(row)),
        ),
      );
      const rule = definition.rules[index];
      if (rule) coloring.targets[key] = rule.id;
    },
  };
}

/** 一つの地図とその読み込み済み地物の世代だけが所有する、判定用の回答データ。 */
export class LocalPresetData {
  private covered: Projection = new Map();
  private rows: Rows = new Map();
  private asOf?: string;
  private baseLoaded = false;
  private queue = Promise.resolve();
  private readonly keys: string[];
  private readonly text: PresetText;

  constructor(
    private readonly transport: Transport,
    private readonly scope: Scope,
    private readonly targets: readonly PresetTarget[],
  ) {
    this.keys = targets.map((target) => target.key);
    this.text = new PresetText(targets);
    if (new Set(this.keys).size !== this.keys.length) throw invalid();
  }

  ready(definitions: readonly AiDefinition[]) {
    if (!this.keys.length) return true;
    const terms = new Set<string>();
    const forms = presetReferences(definitions, terms);
    return (
      (!this.scope.query || this.baseLoaded) &&
      !remaining(forms, this.covered).size &&
      this.text.ready(terms)
    );
  }

  prepare(definitions: readonly AiDefinition[], signal: AbortSignal): Promise<void> {
    const terms = new Set<string>();
    const forms = presetReferences(definitions, terms);
    const pending = this.queue.then(async () => {
      signal.throwIfAborted();
      const missing = remaining(forms, this.covered);
      if (!this.keys.length) return;
      const commitText = await this.text.prepare(terms, this.transport, signal);
      signal.throwIfAborted();
      if (!missing.size && (!this.scope.query || this.baseLoaded)) {
        commitText?.();
        return;
      }
      let all = new Map(this.covered);
      for (const [id, fields] of forms) all.set(id, new Set([...(all.get(id) ?? []), ...fields]));
      let page = await this.download(missing, signal);
      // 登録の編集で過去の投影が変わった場合は、同じ行の新旧の値を混ぜない。
      let refresh = false;
      for (const [key, batch] of page.rows) {
        for (const row of batch.values()) {
          const old = this.rows.get(key)?.get(row.id);
          if (
            row.form_id &&
            this.covered.has(row.form_id) &&
            (!old || old.revision !== row.revision)
          )
            refresh = true;
        }
      }
      if (refresh) {
        // 更新を検出した時点で古い投影を失効させ、現在の条件に必要な範囲を取り直す。
        all = forms;
        page = await this.download(all, signal);
      }
      signal.throwIfAborted();
      for (const [key, batch] of page.rows) {
        const old = this.rows.get(key);
        if (!old || refresh) continue;
        for (const row of batch.values()) {
          const previous = old.get(row.id);
          if (previous) row.fields = { ...previous.fields, ...row.fields };
        }
      }
      if (!this.scope.query && !refresh) {
        for (const [key, old] of this.rows) {
          let batch = page.rows.get(key);
          for (const [id, row] of old) {
            if (row.form_id && !missing.has(row.form_id)) {
              if (!batch) page.rows.set(key, (batch = new Map()));
              batch.set(id, row);
            }
          }
        }
      }
      this.rows = page.rows;
      commitText?.();
      this.asOf = page.asOf;
      this.covered = all;
      this.baseLoaded = true;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async download(forms: Projection, signal: AbortSignal) {
    const [first, ...rest] = projectionBatches(forms);
    const result = await this.downloadProjection(first, signal, this.asOf);
    const seenForms = new Set(first.keys());
    for (const part of rest) {
      const { rows } = await this.downloadProjection(part, signal, result.asOf);
      // 登録地図はすべての行を毎回返す。通常地図では複数回取得したフォームの行だけが重なる。
      const shared = (form: string | null) =>
        !!this.scope.query || (form !== null && part.has(form) && seenForms.has(form));
      for (const [key, prior] of result.rows) {
        for (const row of prior.values()) {
          if (shared(row.form_id) && !rows.get(key)?.has(row.id)) throw invalid();
        }
      }
      for (const [key, current] of rows) {
        let prior = result.rows.get(key);
        if (!prior) result.rows.set(key, (prior = new Map()));
        for (const row of current.values()) {
          const old = prior.get(row.id);
          if (old) {
            if (old.revision !== row.revision || old.form_id !== row.form_id) throw invalid();
            if (Object.keys(row.fields).length) old.fields = { ...old.fields, ...row.fields };
          } else {
            if (shared(row.form_id)) throw invalid();
            prior.set(row.id, row);
          }
        }
      }
      for (const id of part.keys()) seenForms.add(id);
    }
    return result;
  }

  private async downloadProjection(forms: Projection, signal: AbortSignal, asOf?: string) {
    const rows: Rows = new Map();
    const requested = Object.fromEntries(Array.from(forms, ([id, fields]) => [id, [...fields]]));
    for (let i = 0; i < this.keys.length; i += chunkSize) {
      const targets = this.keys.slice(i, i + chunkSize);
      const allowed = new Set(targets);
      let cursor: Cursor | null = null;
      do {
        signal.throwIfAborted();
        const value = await this.transport(
          endpoint,
          {
            ...this.scope,
            forms: requested,
            targets,
            ...(cursor ? { cursor } : {}),
            ...(!this.scope.query && asOf && { as_of: asOf }),
          },
          signal,
        );
        signal.throwIfAborted();
        if (
          !record(value) ||
          !Array.isArray(value.rows) ||
          typeof value.as_of !== "string" ||
          !Number.isFinite(Date.parse(value.as_of)) ||
          (asOf && value.as_of !== asOf) ||
          (typeof this.scope.query?.as_of === "string" &&
            Date.parse(this.scope.query.as_of) !== Date.parse(value.as_of))
        )
          throw invalid();
        asOf = value.as_of;
        for (const item of value.rows) {
          if (
            !record(item) ||
            typeof item.target !== "string" ||
            !allowed.has(item.target) ||
            typeof item.id !== "string" ||
            !item.id ||
            !Number.isSafeInteger(item.revision) ||
            !(item.form_id === null || typeof item.form_id === "string") ||
            !record(item.fields)
          )
            throw invalid();
          const fields = typeof item.form_id === "string" ? forms.get(item.form_id) : undefined;
          if (!this.scope.query && !fields) throw invalid();
          for (const [id, field] of Object.entries(item.fields)) {
            if (
              !fields?.has(id) ||
              !record(field) ||
              typeof field.type !== "string" ||
              !(
                field.value === null ||
                typeof field.value === "string" ||
                typeof field.value === "boolean"
              )
            )
              throw invalid();
          }
          let byId = rows.get(item.target);
          if (!byId) rows.set(item.target, (byId = new Map()));
          if (byId.has(item.id)) throw invalid();
          byId.set(item.id, item as unknown as Row);
        }
        const next = value.next_cursor,
          last = value.rows.at(-1);
        if (
          next !== null &&
          (!record(next) || !last || next.target !== last.target || next.id !== last.id)
        )
          throw invalid();
        cursor = next as Cursor | null;
      } while (cursor);
    }
    return { rows, asOf };
  }

  evaluate(value: AiDefinition): AiExecutionResult {
    if (!this.ready([value])) throw invalid();
    const definition = validateAiEditorDefinition(value);
    if (definition.type === "filter") {
      const match = compileExpression(definition.expression, this.text);
      const targets = this.targets
        .filter((t) => match(t, [...(this.rows.get(t.key)?.values() ?? [])]))
        .map((t) => t.key);
      return { type: "filter", targets, target_count: targets.length, definition };
    }
    const colors = classifier(definition);
    for (const target of this.targets)
      colors.classify(target.key, [...(this.rows.get(target.key)?.values() ?? [])]);
    return {
      type: "color",
      coloring: colors.coloring,
      target_count: Object.keys(colors.coloring.targets).length,
      definition,
    };
  }

  evaluateAnswers(filter: AiDefinition | null, color: AiDefinition | null) {
    if (!this.scope.query || !this.ready([...(filter ? [filter] : []), ...(color ? [color] : [])]))
      throw invalid();
    const f = filter && validateAiEditorDefinition(filter);
    const c = color && validateAiEditorDefinition(color);
    if ((f && f.type !== "filter") || (c && c.type !== "color")) throw invalid();
    const match = f && compileExpression(f.expression, this.text);
    const colors = c && classifier(c);
    const targets: string[] = [];
    let answer_count = 0;
    for (const target of this.targets) {
      const rows = this.rows.get(target.key);
      if (!rows) continue;
      // 履歴では全式を同じ登録に適用し、件数と色の両方にその結果を使う。
      const matches = [...rows.values()].filter((row) => !match || match(target, [row]));
      if (!matches.length) continue;
      targets.push(target.key);
      answer_count += matches.length;
      colors?.classify(target.key, matches);
    }
    return {
      targets,
      target_count: targets.length,
      answer_count,
      coloring: colors?.coloring ?? null,
    };
  }
}
