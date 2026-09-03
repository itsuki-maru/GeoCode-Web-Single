export type MarkerFormFieldType =
  | "checkbox"
  | "date"
  | "image"
  | "number"
  | "radio"
  | "select"
  | "text"
  | "textarea";

export interface MarkerFormField {
  choices: string[];
  id: string;
  label: string;
  max_length: number | null;
  required: boolean;
  type: MarkerFormFieldType;
}

export interface MarkerFormSchema {
  fields: MarkerFormField[];
}

export interface MarkerFormBootstrap {
  isPasswordProtected: boolean;
  schema: MarkerFormSchema;
  submissionPath: string;
}

export interface PreparedImage {
  blob: Blob;
  filename: string;
}

export interface SubmissionResponse {
  error?: string;
  message?: string;
}
