export interface AnswerField {
  id: string;
  label: string;
  field_type: string;
  choices: string[];
}
export interface FormAnswer {
  id: string;
  target_type: "marker" | "shape";
  target_id: string;
  target_name: string;
  layer_id: string | null;
  layer_name: string | null;
  create_at: string;
  edited_at?: string | null;
  submitted_values: Record<string, unknown>;
  form_snapshot: {
    form_title: string;
    form_description: string;
    form_schema: { fields: { id: string; label: string; type: string }[] };
  } | null;
  source_form: { id: string; version: number } | null;
  common_form_name: string | null;
  common_form_deleted: boolean | null;
}
export interface AnswerColumn extends AnswerField {
  key: string;
  displayLabel: string;
}
export const answerFieldKey = (field: AnswerField) => `${field.id}|${field.field_type}`;
export const answerDateLabel = (raw: string) =>
  new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`).toLocaleString();
const typeLabel = (type: string) =>
  (
    ({
      text: "テキスト",
      textarea: "複数行",
      number: "数値",
      date: "日付",
      select: "選択",
      radio: "選択",
      checkbox: "真偽",
      image: "画像",
      unknown: "定義情報なし",
    }) as Record<string, string>
  )[type] || type;

// 名前は、検索結果か過去のスナップショットかという定義の文脈によって決まる。
export function describeAnswerFields(fields: readonly AnswerField[]): AnswerColumn[] {
  const totals = new Map<string, number>(),
    positions = new Map<string, number>();
  for (const field of fields) totals.set(field.label, (totals.get(field.label) ?? 0) + 1);
  return fields.map((field, index) => {
    const number = (positions.get(field.label) ?? 0) + 1;
    positions.set(field.label, number);
    const displayLabel =
      field.field_type === "unknown"
        ? `項目名不明の項目 ${index + 1}`
        : (totals.get(field.label) ?? 0) > 1
          ? `${field.label}（${typeLabel(field.field_type)}・${number}）`
          : field.label;
    return { ...field, key: answerFieldKey(field), displayLabel };
  });
}
export const formatAnswerValue = (value: unknown): string =>
  value === null || value === undefined || value === ""
    ? "未入力"
    : typeof value === "boolean"
      ? value
        ? "はい"
        : "いいえ"
      : typeof value === "object" && "filename" in value
        ? String(value.filename)
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
export const ANSWER_PREVIEW_LENGTH = 200;
export function answerPreview(value: unknown): string {
  const text = formatAnswerValue(value);
  if (text.length <= ANSWER_PREVIEW_LENGTH) return text;
  let end = 0,
    count = 0;
  // 長い値全体の配列を確保せず、プレビューに必要なところで処理を止める。
  for (const character of text) {
    if (count++ === ANSWER_PREVIEW_LENGTH) return text.slice(0, end) + "…";
    end += character.length;
  }
  return text;
}
export function answerCanEdit(answer: FormAnswer): boolean {
  const fields = answer.form_snapshot?.form_schema.fields;
  if (!fields?.length) return false;
  const ids = new Set(fields.map((field) => field.id));
  return Object.keys(answer.submitted_values).every((id) => ids.has(id));
}
export interface AnswerTableRow {
  key: string;
  answer: FormAnswer;
  dateLabel: string;
  canEdit: boolean;
  cells: { key: string; label: string; text: string }[];
}
interface PreparedAnswer {
  key: string;
  answer: FormAnswer;
  dateLabel: string;
  canEdit: boolean;
  fields: Set<string> | null;
  cells: Map<string, string>;
}
// 現在のページ内に限定し、全結果や以前のページを蓄積しない。
export class AnswerTablePresentation {
  private source: readonly FormAnswer[] | null = null;
  private prepared: PreparedAnswer[] = [];
  clear() {
    this.source = null;
    this.prepared = [];
  }
  setPage(answers: readonly FormAnswer[]) {
    if (answers === this.source) return;
    this.source = answers;
    this.prepared = answers.map((answer) => ({
      key: `${answer.target_type}:${answer.id}`,
      answer,
      dateLabel: answerDateLabel(answer.create_at),
      canEdit: answerCanEdit(answer),
      fields: answer.form_snapshot
        ? new Set(
            answer.form_snapshot.form_schema.fields.map((field) => `${field.id}|${field.type}`),
          )
        : null,
      cells: new Map(),
    }));
  }
  rows(columns: readonly AnswerColumn[]): AnswerTableRow[] {
    return this.prepared.map((row) => ({
      key: row.key,
      answer: row.answer,
      dateLabel: row.dateLabel,
      canEdit: row.canEdit,
      cells: columns.map((field) => {
        if (!row.cells.has(field.key)) {
          const exists = row.fields
            ? row.fields.has(field.key)
            : field.field_type === "unknown" &&
              Object.prototype.hasOwnProperty.call(row.answer.submitted_values, field.id);
          row.cells.set(
            field.key,
            exists ? answerPreview(row.answer.submitted_values[field.id]) : "項目なし",
          );
        }
        return { key: field.key, label: field.displayLabel, text: row.cells.get(field.key)! };
      }),
    }));
  }
}
export function describeAnswerDetail(answer: FormAnswer) {
  const fields: AnswerField[] = answer.form_snapshot
    ? answer.form_snapshot.form_schema.fields.map((field) => ({
        id: field.id,
        label: field.label,
        field_type: field.type,
        choices: [],
      }))
    : Object.keys(answer.submitted_values).map((id) => ({
        id,
        label: id,
        field_type: "unknown",
        choices: [],
      }));
  return {
    dateLabel: answerDateLabel(answer.create_at),
    editedDateLabel: answer.edited_at ? answerDateLabel(answer.edited_at) : "",
    canEdit: answerCanEdit(answer),
    fields: describeAnswerFields(fields).map((field) => {
      const value = answer.submitted_values[field.id];
      const url =
        field.field_type === "image" && typeof value === "object" && value && "url" in value
          ? String(value.url)
          : "";
      return {
        ...field,
        text: formatAnswerValue(value),
        imagePath: /^\/static\/images\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(url) ? url : "",
      };
    }),
  };
}
