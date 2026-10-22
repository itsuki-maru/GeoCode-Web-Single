export interface FormBody {
  body: string;
  body_token: string;
  free_text: string;
  sync_required: boolean;
  managed_markdown: string;
  parts: ({ type: "text"; text: string } | { type: "answer"; id: string; markdown: string })[];
}

export function mergeFreeText(document: FormBody, text: string): string {
  if (text === document.free_text) return document.body;
  let first = true;
  const body = document.parts
    .map((part) => {
      if (part.type === "answer") return part.markdown;
      const value = first ? text : "";
      first = false;
      return value;
    })
    .join("");
  return first ? text + body : body;
}
