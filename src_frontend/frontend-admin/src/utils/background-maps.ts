import {
  isBasemapStyleUrl,
  type BasemapKind,
} from "../../../template-scripts/src/map/common/basemap-definition";

export type BackgroundMapInput = {
  layer_name: string;
  label: string;
  url: string;
  kind: BasemapKind;
  style_url: string | null;
  attribution: string;
  include_foreign_tiles: boolean;
  min_zoom: number | null;
  max_zoom: number | null;
};

export type BackgroundMapRecord = Omit<BackgroundMapInput, "kind" | "style_url"> & {
  id: number;
  kind?: BasemapKind;
  style_url?: string | null;
};

export type BackgroundMapForm = Omit<BackgroundMapInput, "style_url" | "min_zoom" | "max_zoom"> & {
  style_url: string;
  min_zoom: number | string;
  max_zoom: number | string;
};

export const newBackgroundMapForm = (): BackgroundMapForm => ({
  layer_name: "",
  label: "",
  url: "",
  kind: "raster",
  style_url: "",
  attribution: "",
  include_foreign_tiles: false,
  min_zoom: "",
  max_zoom: "",
});

export function editBackgroundMapForm(record: BackgroundMapRecord): BackgroundMapForm {
  return {
    layer_name: record.layer_name,
    label: record.label,
    url: record.url,
    kind: record.kind ?? "raster",
    style_url: record.style_url ?? "",
    attribution: record.attribution,
    include_foreign_tiles: record.include_foreign_tiles,
    min_zoom: record.min_zoom ?? "",
    max_zoom: record.max_zoom ?? "",
  };
}

function validImageUrl(value: string): boolean {
  if (/[\\#\p{Cc}]/u.test(value)) return false;
  const localPath = value.startsWith("/") && !value.startsWith("//");
  if (!localPath && !/^https?:\/\//i.test(value)) return false;
  const expanded = value.replace(/\{(s|r|z|x|y|-y)\}/g, (_match, token) =>
    token === "s" ? "a" : token === "r" ? "" : "0",
  );
  if (/[{}]/.test(expanded)) return false;
  try {
    const url = new URL(expanded, "https://map.invalid");
    return !!url.hostname && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function zoom(value: number | string): number | null | undefined {
  if (value === "") return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 22
    ? value
    : undefined;
}

export function validateBackgroundMapForm(
  form: BackgroundMapForm,
  editingId: number | null,
  records: BackgroundMapRecord[],
): { input: BackgroundMapInput; error?: never } | { error: string; input?: never } {
  if ([form.label, form.layer_name, form.url].some((value) => /\p{Cc}/u.test(value)))
    return { error: "表示名・識別名・画像タイルURLに制御文字は使用できません。" };
  if (form.attribution.includes("\0")) return { error: "出典に使用できない文字が含まれています。" };
  const layer_name = form.layer_name.trim();
  const label = form.label.trim();
  const url = form.url.trim();
  if (!label || [...label].length > 255) return { error: "表示名は1〜255文字で入力してください。" };
  if (!layer_name || [...layer_name].length > 255)
    return { error: "識別名は1〜255文字で入力してください。" };
  const previous = records.find((record) => record.id === editingId);
  if (
    layer_name !== previous?.layer_name &&
    records.some((record) => record.id !== editingId && record.layer_name === layer_name)
  )
    return { error: "この識別名は使用されています。別の識別名を入力してください。" };
  if (!url || [...url].length > 255 || !validImageUrl(url))
    return {
      error:
        "画像タイルURLは255文字以内のHTTP・HTTPS URL、または / で始まるパスで入力してください。認証情報・フラグメントは使用できません。",
    };
  if ([...form.attribution].length > 255) return { error: "出典は255文字以内で入力してください。" };
  if (form.kind !== "raster" && form.kind !== "vector")
    return { error: "背景の種別を選択してください。" };
  if (editingId === 1 && form.kind !== "raster")
    return { error: "背景ID 1はラスタのまま使用してください。" };
  if (
    form.kind === "vector" &&
    (form.style_url !== form.style_url.trim() || !isBasemapStyleUrl(form.style_url))
  )
    return {
      error:
        "スタイルURLはHTTPS URL、または / で始まるパスで入力してください（UTF-8で4096バイト以内）。認証情報・フラグメント・前後の空白は使用できません。",
    };
  const min_zoom = zoom(form.min_zoom);
  const max_zoom = zoom(form.max_zoom);
  if (min_zoom === undefined || max_zoom === undefined || (min_zoom ?? 5) > (max_zoom ?? 18))
    return {
      error:
        "ズームは0〜22の整数で、最大ズームは最小ズーム以上にしてください。空欄は最小5・最大18です。",
    };
  return {
    input: {
      layer_name,
      label,
      url,
      kind: form.kind,
      style_url: form.kind === "vector" ? form.style_url : null,
      attribution: form.attribution,
      include_foreign_tiles: form.include_foreign_tiles,
      min_zoom,
      max_zoom,
    },
  };
}
