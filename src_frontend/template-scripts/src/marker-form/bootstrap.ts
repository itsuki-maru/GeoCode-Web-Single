import type { MarkerFormBootstrap, MarkerFormFieldType } from "./types";

const FIELD_TYPES = new Set<MarkerFormFieldType>([
  "checkbox",
  "date",
  "image",
  "number",
  "radio",
  "select",
  "text",
  "textarea",
]);

declare global {
  interface Window {
    __GEOCODE_MARKER_FORM__?: unknown;
  }
}

export function readMarkerFormBootstrap(): MarkerFormBootstrap {
  const value = window.__GEOCODE_MARKER_FORM__;
  if (!isRecord(value)) {
    throw new Error("Marker form bootstrap data is missing");
  }
  if (
    typeof value.submissionPath !== "string" ||
    typeof value.isPasswordProtected !== "boolean" ||
    !isRecord(value.schema) ||
    !Array.isArray(value.schema.fields)
  ) {
    throw new Error("Marker form bootstrap data is invalid");
  }

  for (const field of value.schema.fields) {
    if (
      !isRecord(field) ||
      typeof field.id !== "string" ||
      typeof field.label !== "string" ||
      typeof field.required !== "boolean" ||
      typeof field.type !== "string" ||
      !FIELD_TYPES.has(field.type as MarkerFormFieldType) ||
      !Array.isArray(field.choices) ||
      !field.choices.every((choice) => typeof choice === "string") ||
      !(field.max_length === null || typeof field.max_length === "number")
    ) {
      throw new Error("Marker form field data is invalid");
    }
  }

  return value as unknown as MarkerFormBootstrap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
