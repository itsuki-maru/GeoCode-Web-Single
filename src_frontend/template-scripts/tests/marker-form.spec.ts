import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("marker form entry", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <main>
        <form id="marker-form">
          <div id="fields"></div>
          <div id="message" class="message"></div>
          <button id="submit-button" type="submit">入力内容を送信</button>
        </form>
      </main>
    `;
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.__GEOCODE_MARKER_FORM__ = {
      isPasswordProtected: false,
      schema: {
        fields: [
          {
            choices: [],
            id: "name",
            label: "名前",
            max_length: 100,
            required: true,
            type: "text",
          },
        ],
      },
      submissionPath: "/forms/example",
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds fields and submits values", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ message: "受付完了" }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    await import("../src/entries/marker-form");

    const input = document.querySelector<HTMLInputElement>("#field-name");
    expect(input).not.toBeNull();
    input!.value = "テスト";
    document.querySelector<HTMLFormElement>("#marker-form")!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const formData = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(String(formData.get("submission")))).toEqual({
      password: null,
      values: { name: "テスト" },
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("受付完了"));
  });
});
