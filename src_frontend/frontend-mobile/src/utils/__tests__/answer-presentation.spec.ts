import { describe, expect, it, vi } from "vitest";
import {
  AnswerTablePresentation,
  answerPreview,
  describeAnswerDetail,
  describeAnswerFields,
  type FormAnswer,
} from "../answer-presentation";
const answer = (): FormAnswer => ({
  id: "a",
  target_type: "marker",
  target_id: "target",
  target_name: "対象",
  layer_id: null,
  layer_name: null,
  create_at: "2026-01-01T00:00:00",
  submitted_values: { amount: 0, flag: false, empty: "" },
  form_snapshot: {
    form_title: "当時",
    form_description: "説明",
    form_schema: {
      fields: [
        { id: "amount", label: "項目", type: "number" },
        { id: "flag", label: "項目", type: "checkbox" },
        { id: "empty", label: "空欄", type: "text" },
      ],
    },
  },
  source_form: null,
  common_form_name: null,
  common_form_deleted: null,
});
const columns = () =>
  describeAnswerFields([
    { id: "amount", label: "項目", field_type: "number", choices: [] },
    { id: "flag", label: "項目", field_type: "checkbox", choices: [] },
    { id: "empty", label: "空欄", field_type: "text", choices: [] },
    { id: "amount", label: "変更後", field_type: "text", choices: [] },
  ]);
describe("answer presentation snapshots", () => {
  it("preserves order, typed existence, zero/false/empty values and historical labels", () => {
    const presentation = new AnswerTablePresentation(),
      source = answer();
    presentation.setPage([source, { ...source, target_type: "shape" }]);
    const rows = presentation.rows(columns());
    expect(rows.map((row) => row.key)).toEqual(["marker:a", "shape:a"]);
    expect(rows[0]!.cells.map((cell) => cell.text)).toEqual(["0", "いいえ", "未入力", "項目なし"]);
    expect(rows[0]!.cells.map((cell) => cell.label)).toEqual([
      "項目（数値・1）",
      "項目（真偽・2）",
      "空欄",
      "変更後",
    ]);
    expect(rows[0]!.canEdit).toBe(true);
    expect(describeAnswerDetail(source).fields.map((field) => field.displayLabel)).toEqual([
      "項目（数値・1）",
      "項目（真偽・2）",
      "空欄",
    ]);
    expect(source.submitted_values).toEqual({ amount: 0, flag: false, empty: "" });
  });
  it("formats dates once per page and values only once for requested columns", () => {
    const date = vi.spyOn(Date.prototype, "toLocaleString");
    const read = vi.fn(() => "long value");
    const source = answer();
    Object.defineProperty(source.submitted_values, "empty", { enumerable: true, get: read });
    const presentation = new AnswerTablePresentation(),
      page = [source];
    presentation.setPage(page);
    expect(date).toHaveBeenCalledTimes(1);
    presentation.rows(columns().slice(0, 1));
    expect(read).not.toHaveBeenCalled();
    presentation.rows(columns());
    expect(read).toHaveBeenCalledTimes(1);
    presentation.setPage(page);
    presentation.rows(columns());
    expect(date).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    presentation.setPage([{ ...source, id: "next", submitted_values: { amount: 1 } }]);
    expect(presentation.rows(columns()).map((row) => row.key)).toEqual(["marker:next"]);
    expect(date).toHaveBeenCalledTimes(2);
    presentation.clear();
    expect(presentation.rows(columns())).toEqual([]);
  });
  it("bounds long Unicode previews and preserves full values in details", () => {
    const text = "😀".repeat(201);
    expect(answerPreview(text)).toBe("😀".repeat(200) + "…");
    expect(answerPreview("😀".repeat(200))).toBe("😀".repeat(200));
    expect(answerPreview({ filename: "画像.png", url: "/static/images/valid.png" })).toBe(
      "画像.png",
    );
    const source = answer();
    source.submitted_values.empty = text;
    expect(describeAnswerDetail(source).fields.find((field) => field.id === "empty")!.text).toBe(
      text,
    );
  });
  it("distinguishes legacy values, unknown keys and unsafe image links", () => {
    const source = { ...answer(), form_snapshot: null, submitted_values: { legacy: "以前の回答" } };
    const presentation = new AnswerTablePresentation();
    presentation.setPage([source]);
    const fields = describeAnswerFields([
      { id: "legacy", label: "legacy", field_type: "unknown", choices: [] },
    ]);
    expect(presentation.rows(fields)[0]).toMatchObject({
      canEdit: false,
      cells: [{ label: "項目名不明の項目 1", text: "以前の回答" }],
    });
    const image = answer();
    image.form_snapshot!.form_schema.fields = [{ id: "photo", label: "画像", type: "image" }];
    image.submitted_values = { photo: { filename: "photo.png", url: "javascript:alert(1)" } };
    expect(describeAnswerDetail(image).fields[0]!.imagePath).toBe("");
    image.submitted_values.photo = { filename: "photo.png", url: "/static/images/valid.png" };
    expect(describeAnswerDetail(image).fields[0]!.imagePath).toBe("/static/images/valid.png");
    image.submitted_values.unknown = "不明";
    presentation.setPage([image]);
    expect(presentation.rows([])[0]!.canEdit).toBe(false);
  });
});
