import { isAnswerColoring, type AnswerColoring } from "../map/answer-coloring";

export interface AiContext {
  layer_ids: string[] | null;
}
export interface AiMapView {
  latitude: number;
  longitude: number;
  zoom: number;
}
export interface AiCapabilities {
  enabled: boolean;
  voice_enabled: boolean;
  revision: string;
  protocol_version?: number;
  write_enabled?: boolean;
}
export interface AiSuggestion {
  text: string;
  kind: "filter" | "coloring";
}
export interface AiSuggestions {
  revision: string;
  as_of: string;
  suggestions: AiSuggestion[];
}
export function validateSuggestions(value: unknown): AiSuggestions {
  const data = value as AiSuggestions;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.revision !== "string" ||
    typeof data.as_of !== "string" ||
    !Number.isFinite(Date.parse(data.as_of)) ||
    !Array.isArray(data.suggestions) ||
    data.suggestions.length > 3 ||
    data.suggestions.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.text !== "string" ||
        !item.text.trim() ||
        [...item.text].length > 300 ||
        /[\u0000-\u001f\u007f]/.test(item.text) ||
        !["filter", "coloring"].includes(item.kind),
    )
  )
    throw Error("入力例を確認できませんでした。");
  return {
    revision: data.revision,
    as_of: data.as_of,
    suggestions: data.suggestions.map(({ text, kind }) => ({ text, kind })),
  };
}
export const AI_OPERATION_NOT_ALLOWED = "要求された操作は許可されていません。";
/** randomUUID is unavailable on HTTP LAN origins; getRandomValues remains a CSPRNG there. */
export function createAiOperationId(): string {
  const secureCrypto = globalThis.crypto;
  if (typeof secureCrypto?.randomUUID === "function") return secureCrypto.randomUUID();
  if (typeof secureCrypto?.getRandomValues !== "function")
    throw Error("このブラウザーでは安全な操作IDを生成できません。対応ブラウザーで開いてください。");
  const bytes = secureCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}
export interface AiDefinition {
  type: "filter" | "color";
  [key: string]: unknown;
}
export interface AiAppliedState {
  filter: AiDefinition | null;
  color: AiDefinition | null;
}
export function aiFailureMessage(data: unknown, fallback: string): string {
  const value = data as { code?: unknown; error?: unknown } | null;
  if (value?.code === "ai_operation_not_allowed") return AI_OPERATION_NOT_ALLOWED;
  return typeof value?.error === "string"
    ? value.error.replace(/^validation error:\s*/, "")
    : fallback;
}
export function validateDefinition(value: unknown): AiDefinition {
  const definition = value as AiDefinition;
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    !["filter", "color"].includes(definition.type) ||
    JSON.stringify(value).length > 131072
  )
    throw Error("保存条件の形式を確認できませんでした。");
  if (
    definition.type === "filter" &&
    (!definition.expression || typeof definition.expression !== "object")
  )
    throw Error("検索式を確認できませんでした。");
  if (
    definition.type === "color" &&
    (typeof definition.common_form_id !== "string" ||
      !Array.isArray(definition.rules) ||
      definition.rules.length < 1 ||
      definition.rules.length > 10)
  )
    throw Error("色分け条件を確認できませんでした。");
  return structuredClone(definition);
}
export interface AiExecutionResult {
  type: "filter" | "color" | "reset" | "focus";
  targets?: string[];
  coloring?: AnswerColoring;
  latitude?: number;
  longitude?: number;
  zoom?: number;
  target_count?: number;
  definition?: AiDefinition | { type: "reset" | "focus" };
}
export type AiTransport = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
) => Promise<unknown>;
export type AiUndo = () => Promise<void>;

export function validateCapabilities(value: unknown): AiCapabilities {
  const data = value as AiCapabilities;
  if (
    !data ||
    typeof data.enabled !== "boolean" ||
    typeof data.voice_enabled !== "boolean" ||
    (data.protocol_version !== undefined &&
      (!Number.isSafeInteger(data.protocol_version) || data.protocol_version < 1)) ||
    (data.write_enabled !== undefined && typeof data.write_enabled !== "boolean") ||
    (typeof data.revision !== "string" && !(data.revision === null && !data.enabled))
  )
    throw Error("AIの利用設定を取得できませんでした。");
  return { ...data, revision: data.revision ?? "" };
}

export function validateExecutionResult(value: unknown): AiExecutionResult {
  const data = value as AiExecutionResult;
  if (!data || !["filter", "color", "reset", "focus"].includes(data.type))
    throw Error("AIの操作結果を確認できませんでした。");
  if (data.type === "filter") {
    if (
      !Array.isArray(data.targets) ||
      data.targets.some(
        (key) => typeof key !== "string" || !/^(marker|shape):[^:]{1,128}$/.test(key),
      ) ||
      new Set(data.targets).size !== data.targets.length ||
      data.target_count !== data.targets.length
    )
      throw Error("AIの検索結果が不正です。");
  }
  if (data.type === "color" && !isAnswerColoring(data.coloring))
    throw Error("AIの色分け結果が不正です。");
  if (
    data.type === "focus" &&
    (typeof data.latitude !== "number" ||
      !Number.isFinite(data.latitude) ||
      Math.abs(data.latitude) > 90 ||
      typeof data.longitude !== "number" ||
      !Number.isFinite(data.longitude) ||
      Math.abs(data.longitude) > 180 ||
      (data.zoom !== undefined &&
        (!Number.isInteger(data.zoom) || data.zoom < 0 || data.zoom > 22)))
  )
    throw Error("AIの移動先が不正です。");
  return data;
}

/** テンプレートの地図でも既存Cookieと認証更新を使用する。キーはブラウザーへ渡さない。 */
export async function aiFetchTransport(
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
  accountId?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(cancel, 180000);
  try {
    const isForm = body instanceof FormData;
    const init: RequestInit = {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : isForm
          ? { body: body as FormData }
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    };
    if (
      (path.startsWith("/ai/") && path !== "/ai/capabilities") ||
      path === "/form-answers/map-presets/evaluate"
    )
      init.headers = { ...init.headers, "X-AI-Account-ID": accountId ?? "" };
    let response = await fetch(path, init);
    if (response.status === 401) {
      const renewed = await fetch("/account/refresh", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (renewed.ok && !controller.signal.aborted) response = await fetch(path, init);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw Error(
        aiFailureMessage(
          data,
          response.status === 401
            ? "再ログインしてください。"
            : "AIへの要求に失敗しました。再試行してください。",
        ),
      );
    return data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
