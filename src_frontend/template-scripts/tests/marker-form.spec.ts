import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const resize = vi.hoisted(() => vi.fn());
vi.mock("../src/marker-form/image-resize", () => ({ resizeImage: resize }));

describe("marker form entry", () => {
  beforeEach(() => {
    resize.mockReset().mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
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

  it("submits the configuration token from the displayed form", async () => {
    (window.__GEOCODE_MARKER_FORM__ as Record<string, unknown>).configToken = "displayed-version";
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ message: "保存済み" }) });
    vi.stubGlobal("fetch", fetchMock);
    await import("../src/entries/marker-form");
    (document.querySelector("#field-name") as HTMLInputElement).value = "テスト";
    document
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(String(body.get("submission")))).toMatchObject({
      config_token: "displayed-version",
      values: { name: "テスト" },
    });
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
    document
      .querySelector<HTMLFormElement>("#marker-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const formData = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(String(formData.get("submission")))).toEqual({
      password: null,
      values: { name: "テスト" },
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("受付完了"));
  });
  it("asks to reload after a concurrent configuration change without showing completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ status: 409, ok: false, json: async () => ({ error: "conflict" }) }),
    );
    await import("../src/entries/marker-form");
    document.querySelector<HTMLInputElement>("#field-name")!.value = "入力を保持";
    document
      .querySelector<HTMLFormElement>("#marker-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("#message")!.textContent).toContain("再読み込み"),
    );
    expect(document.querySelector<HTMLInputElement>("#field-name")!.value).toBe("入力を保持");
    expect(document.querySelector<HTMLButtonElement>("#submit-button")!.disabled).toBe(false);
  });

  it("collects all field types, a password and a prepared attachment without losing values", async () => {
    const bootstrap = window.__GEOCODE_MARKER_FORM__ as any;
    bootstrap.isPasswordProtected = true;
    bootstrap.schema.fields = [
      "textarea",
      "select",
      "radio",
      "checkbox",
      "number",
      "date",
      "image",
    ].map((type) => ({
      id: type,
      type,
      label: type,
      choices: ["A", "B"],
      required: false,
      max_length: null,
    }));
    const password = document.createElement("input");
    password.id = "form-password";
    password.value = "secret";
    document.querySelector("form")!.append(password);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetcher);
    await import("../src/entries/marker-form");
    document.querySelector<HTMLTextAreaElement>("#field-textarea")!.value = "本文";
    document.querySelector<HTMLSelectElement>("#field-select")!.value = "B";
    document.querySelector<HTMLInputElement>('input[name="radio"][value="A"]')!.checked = true;
    document.querySelector<HTMLInputElement>("#field-checkbox")!.checked = true;
    document.querySelector<HTMLInputElement>("#field-number")!.value = "1.5";
    document.querySelector<HTMLInputElement>("#field-date")!.value = "2026-01-01";
    const image = document.querySelector<HTMLInputElement>("#field-image")!;
    Object.defineProperty(image, "files", {
      configurable: true,
      value: [new File(["png"], "photo.png", { type: "image/png" })],
    });
    image.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(document.querySelector(".image-status")!.textContent).toContain("準備完了"),
    );
    document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="status"]')!.textContent).toContain("送信が完了"),
    );
    const body = fetcher.mock.calls[0]![1].body as FormData;
    expect(JSON.parse(String(body.get("submission")))).toMatchObject({
      password: "secret",
      values: {
        textarea: "本文",
        select: "B",
        radio: "A",
        checkbox: true,
        number: "1.5",
        date: "2026-01-01",
      },
    });
    expect((body.get("image__image") as File).name).toBe("photo.png");
    expect(document.querySelector("form")).toBeNull();
  });

  it.each([new Error("decode failed"), "unknown"])(
    "rejects failed image preparation and clears a removed attachment: %s",
    async (error) => {
      (window.__GEOCODE_MARKER_FORM__ as any).schema.fields = [
        {
          id: "photo",
          label: "写真",
          type: "image",
          required: false,
          choices: [],
          max_length: null,
        },
      ];
      resize.mockRejectedValueOnce(error);
      await import("../src/entries/marker-form");
      const input = document.querySelector<HTMLInputElement>("#field-photo")!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["bad"], "bad.png")],
      });
      input.dispatchEvent(new Event("change"));
      await vi.waitFor(() =>
        expect(document.querySelector(".image-status")!.textContent).toBe(
          error instanceof Error ? error.message : "画像を処理できませんでした。",
        ),
      );
      expect(input.value).toBe("");
      Object.defineProperty(input, "files", { value: [] });
      input.dispatchEvent(new Event("change"));
      expect(resize).toHaveBeenCalledTimes(1);
    },
  );

  it("does not submit invalid required fields and permits retry after an unreadable server error", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });
    vi.stubGlobal("fetch", fetcher);
    await import("../src/entries/marker-form");
    const form = document.querySelector("form")!;
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(fetcher).not.toHaveBeenCalled();
    document.querySelector<HTMLInputElement>("#field-name")!.value = "保持する";
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("#message")!.textContent).toBe("送信に失敗しました。"),
    );
    expect(document.querySelector<HTMLButtonElement>("#submit-button")!.disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#field-name")!.value).toBe("保持する");
  });
});
