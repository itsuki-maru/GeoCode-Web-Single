import { requireElement } from "../dom";
import { readMarkerFormBootstrap } from "../marker-form/bootstrap";
import { resizeImage } from "../marker-form/image-resize";
import type {
  MarkerFormField,
  MarkerFormSchema,
  PreparedImage,
  SubmissionResponse,
} from "../marker-form/types";

interface MarkerFormElements {
  fieldsRoot: HTMLElement;
  form: HTMLFormElement;
  message: HTMLElement;
  submitButton: HTMLButtonElement;
}

export function initializeMarkerForm(): void {
  const bootstrap = readMarkerFormBootstrap();
  const elements: MarkerFormElements = {
    fieldsRoot: requireElement("#fields", HTMLElement),
    form: requireElement("#marker-form", HTMLFormElement),
    message: requireElement("#message", HTMLElement),
    submitButton: requireElement("#submit-button", HTMLButtonElement),
  };
  const imageFiles = new Map<string, PreparedImage>();

  for (const field of bootstrap.schema.fields) {
    elements.fieldsRoot.appendChild(buildField(field, imageFiles));
  }

  elements.form.addEventListener("submit", (event) => {
    void submitMarkerForm(
      event,
      elements,
      bootstrap.schema,
      imageFiles,
      bootstrap.submissionPath,
      bootstrap.isPasswordProtected,
    );
  });
}

function createLabel(field: MarkerFormField, inputId: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = inputId;
  label.textContent = field.label;
  if (field.required) {
    const required = document.createElement("span");
    required.className = "required";
    required.textContent = "必須";
    label.appendChild(required);
  }
  return label;
}

function commonInput(
  field: MarkerFormField,
  type: HTMLInputElement["type"],
): HTMLInputElement {
  const input = document.createElement("input");
  input.id = `field-${field.id}`;
  input.name = field.id;
  input.type = type;
  input.required = field.required;
  if (field.max_length) input.maxLength = field.max_length;
  return input;
}

function buildField(
  field: MarkerFormField,
  imageFiles: Map<string, PreparedImage>,
): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const inputId = `field-${field.id}`;
  wrapper.appendChild(createLabel(field, inputId));

  if (field.type === "textarea") {
    const input = document.createElement("textarea");
    input.id = inputId;
    input.name = field.id;
    input.required = field.required;
    input.maxLength = field.max_length || 2000;
    wrapper.appendChild(input);
  } else if (field.type === "select") {
    const select = document.createElement("select");
    select.id = inputId;
    select.name = field.id;
    select.required = field.required;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "選択してください";
    select.appendChild(empty);
    for (const choice of field.choices) {
      const option = document.createElement("option");
      option.value = choice;
      option.textContent = choice;
      select.appendChild(option);
    }
    wrapper.appendChild(select);
  } else if (field.type === "radio") {
    const list = document.createElement("div");
    list.className = "choice-list";
    list.id = inputId;
    field.choices.forEach((choice, index) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = field.id;
      input.value = choice;
      input.required = field.required;
      input.id = `${inputId}-${index}`;
      optionLabel.append(input, document.createTextNode(choice));
      list.appendChild(optionLabel);
    });
    wrapper.appendChild(list);
  } else if (field.type === "checkbox") {
    const choice = document.createElement("label");
    choice.className = "choice";
    const input = commonInput(field, "checkbox");
    choice.append(input, document.createTextNode("はい"));
    wrapper.appendChild(choice);
  } else if (field.type === "image") {
    const input = commonInput(field, "file");
    input.accept = "image/jpeg,image/png,image/webp";
    const status = document.createElement("span");
    status.className = "image-status";
    status.textContent = "JPEG・PNG・WebP";
    input.addEventListener("change", () => {
      void prepareImage(field.id, input, status, imageFiles);
    });
    wrapper.append(input, status);
  } else {
    const input = commonInput(field, field.type);
    if (field.type === "number") input.step = "any";
    wrapper.appendChild(input);
  }
  return wrapper;
}

async function prepareImage(
  fieldId: string,
  input: HTMLInputElement,
  status: HTMLElement,
  imageFiles: Map<string, PreparedImage>,
): Promise<void> {
  const file = input.files?.[0];
  imageFiles.delete(fieldId);
  if (!file) return;

  status.textContent = "画像を縮小しています…";
  try {
    const blob = await resizeImage(file);
    imageFiles.set(fieldId, { blob, filename: file.name });
    status.textContent = `準備完了: ${file.name}`;
  } catch (error) {
    input.value = "";
    status.textContent =
      error instanceof Error ? error.message : "画像を処理できませんでした。";
  }
}

function collectValues(schema: MarkerFormSchema): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of schema.fields) {
    if (field.type === "image") continue;

    if (field.type === "checkbox") {
      values[field.id] = requireElement<HTMLInputElement>(
        `#field-${CSS.escape(field.id)}`,
        HTMLInputElement,
      ).checked;
    } else if (field.type === "radio") {
      const selected = document.querySelector<HTMLInputElement>(
        `input[name="${CSS.escape(field.id)}"]:checked`,
      );
      values[field.id] = selected?.value ?? "";
    } else {
      values[field.id] = requireElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `#field-${CSS.escape(field.id)}`,
        field.type === "textarea" ? HTMLTextAreaElement : field.type === "select" ? HTMLSelectElement : HTMLInputElement,
      ).value;
    }
  }
  return values;
}

async function submitMarkerForm(
  event: SubmitEvent,
  elements: MarkerFormElements,
  schema: MarkerFormSchema,
  imageFiles: Map<string, PreparedImage>,
  submissionPath: string,
  isPasswordProtected: boolean,
): Promise<void> {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;

  elements.submitButton.disabled = true;
  elements.submitButton.textContent = "送信中…";
  elements.message.className = "message";

  try {
    const passwordInput = isPasswordProtected
      ? requireElement<HTMLInputElement>("#form-password", HTMLInputElement)
      : null;
    const formData = new FormData();
    formData.append(
      "submission",
      JSON.stringify({
        password: passwordInput?.value ?? null,
        values: collectValues(schema),
      }),
    );
    for (const [fieldId, image] of imageFiles) {
      formData.append(`image__${fieldId}`, image.blob, image.filename);
    }

    const response = await fetch(submissionPath, { method: "POST", body: formData });
    const body = (await response.json().catch(() => ({}))) as SubmissionResponse;
    if (!response.ok) throw new Error(body.error || "送信に失敗しました。");

    showCompletion(elements.form, body.message || "送信が完了しました。");
    imageFiles.clear();
    return;
  } catch (error) {
    elements.message.textContent =
      error instanceof Error ? error.message : "送信に失敗しました。";
    elements.message.className = "message error";
  }

  elements.submitButton.disabled = false;
  elements.submitButton.textContent = "入力内容を送信";
  elements.message.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showCompletion(form: HTMLFormElement, message: string): void {
  const completion = document.createElement("p");
  completion.className = "message success";
  completion.setAttribute("role", "status");
  completion.setAttribute("aria-live", "polite");
  completion.tabIndex = -1;
  completion.textContent = message;
  const main = form.closest("main");
  if (!main) throw new Error("Marker form main element was not found");
  main.classList.add("completion-view");
  main.replaceChildren(completion);
  completion.focus({ preventScroll: true });
  completion.scrollIntoView({ behavior: "smooth", block: "center" });
}

initializeMarkerForm();
