import { describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import {
  deferHtmlDetails,
  type CreateHtmlDetails,
} from "../src/map/common/progressive-html-details";

interface Deferred {
  type: string;
  attributes: Record<string, string>;
  summary: unknown[];
  body: unknown[];
  hasSummary: boolean;
}
const create: CreateHtmlDetails = (attributes, summary, body, hasSummary) => ({
  type: "progressiveHtmlDetails",
  attributes,
  summary,
  body,
  hasSummary,
});
const raw = (text: string) => ({ type: "html", block: true, raw: text, text });
const join = (tokens: unknown[]) =>
  (tokens as Array<{ raw?: string }>).map((token) => token.raw ?? "[deferred]").join("");

describe("raw HTML details planning", () => {
  it("separates one raw token without interpreting literal Markdown again", () => {
    const source =
      '<div>before<details class="photos"><summary>**Title**</summary>**literal body**</details>after</div>';
    const result = deferHtmlDetails([raw(source)], create);
    expect(result).toHaveLength(3);
    expect(join([result[0]])).toBe("<div>before");
    expect(join([result[2]])).toBe("after</div>");
    const details = result[1] as Deferred;
    expect(details.attributes).toEqual({ class: "photos" });
    expect(details.hasSummary).toBe(true);
    expect(join(details.summary)).toBe("**Title**");
    expect(join(details.body)).toBe("**literal body**");
  });

  it("keeps original Markdown blocks between separate raw HTML tokens", () => {
    const paragraph = { type: "paragraph", raw: "**Markdown**", text: "**Markdown**", tokens: [] };
    const result = deferHtmlDetails(
      [raw("<details><summary>Title</summary>\n\n"), paragraph, raw("\n\n</details>")],
      create,
    );
    const details = result[0] as Deferred;
    expect(details.body).toContain(paragraph);
    expect(join(details.body)).toBe("\n\n**Markdown**\n\n");
  });

  it("defers nested raw details independently", () => {
    const result = deferHtmlDetails(
      [
        raw(
          "<details><summary>Parent</summary>before<details><summary>Child</summary>inner</details>after</details>",
        ),
      ],
      create,
    );
    const parent = result[0] as Deferred;
    expect(join(parent.summary)).toBe("Parent");
    expect(parent.body).toHaveLength(3);
    const child = parent.body[1] as Deferred;
    expect(join(child.summary)).toBe("Child");
    expect(join(child.body)).toBe("inner");
    expect(join([parent.body[0], parent.body[2]])).toBe("beforeafter");
  });

  it("distinguishes an empty summary from an absent summary", () => {
    const [empty, absent] = deferHtmlDetails(
      [raw("<details><summary></summary>one</details><details>two</details>")],
      create,
    ) as Deferred[];
    expect(empty!.hasSummary).toBe(true);
    expect(empty!.summary).toEqual([]);
    expect(join(empty!.body)).toBe("one");
    expect(absent!.hasSummary).toBe(false);
    expect(absent!.summary).toEqual([]);
    expect(join(absent!.body)).toBe("two");
  });

  it("keeps a second summary as ordinary body content", () => {
    const [details] = deferHtmlDetails(
      [raw("<details>before<summary>first</summary><summary>second</summary>after</details>")],
      create,
    ) as Deferred[];
    expect(join(details!.summary)).toBe("first");
    expect(join(details!.body)).toBe("before<summary>second</summary>after");
  });

  it("preserves raw attributes and unclosed details/summary at EOF", () => {
    const [details] = deferHtmlDetails(
      [raw('<details open class="x&amp;y"><summary>title')],
      create,
    ) as Deferred[];
    expect(details!.attributes).toEqual({ open: "", class: "x&y" });
    expect(join(details!.summary)).toBe("title");
    expect(details!.body).toEqual([]);
  });

  it("supports a self-closing raw details without overlapping ranges", () => {
    const result = deferHtmlDetails([raw("before<details/>after")], create);
    expect(join([result[0]])).toBe("before");
    expect((result[1] as Deferred).body).toEqual([]);
    expect(join([result[2]])).toBe("after");
  });

  it.each(["script", "style", "pre", "code", "textarea"])("ignores raw details in %s", (tag) => {
    const source = `<${tag}><details><summary>Example</summary>body</details></${tag}>`;
    const callback = vi.fn(create);
    const result = deferHtmlDetails([raw(source)], callback);
    expect(callback).not.toHaveBeenCalled();
    expect(join(result)).toBe(source);
  });

  it("does not inspect Markdown fenced code or code spans", () => {
    const marked = new Marked();
    const source =
      "```html\n<details><summary>Example</summary>body</details>\n```\n\n`<details>literal</details>`";
    const tokens = marked.lexer(source);
    const callback = vi.fn(create);
    expect(deferHtmlDetails(tokens, callback)).toEqual(tokens);
    expect(callback).not.toHaveBeenCalled();
  });

  it("processes raw details nested in notes, blockquotes, and list items", () => {
    const detailTokens = [raw("<details><summary>T</summary>B</details>")];
    for (const type of ["note", "warning", "blockquote"]) {
      const [result] = deferHtmlDetails([{ type, tokens: detailTokens }], create) as Array<{
        tokens: Deferred[];
      }>;
      expect(result!.tokens[0]!.type).toBe("progressiveHtmlDetails");
    }
    const [list] = deferHtmlDetails(
      [{ type: "list", items: [{ type: "list_item", tokens: detailTokens }] }],
      create,
    ) as Array<{ items: Array<{ tokens: Deferred[] }> }>;
    expect(list!.items[0]!.tokens[0]!.type).toBe("progressiveHtmlDetails");
  });
});
