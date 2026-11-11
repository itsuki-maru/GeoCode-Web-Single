/** 省略された種別は従来のラスタ背景として扱う。 */
export type BasemapKind = "raster" | "vector";

export type BasemapMetadata =
  { kind?: "raster"; style_url?: null } | { kind: "vector"; style_url: string };

/** Vueと地図iframeの両方から使うため、地図描画モジュールに依存させない。 */
interface TileServerBaseRecord {
  attribution: string;
  id: number;
  include_foreign_tiles: boolean;
  label: string;
  layer_name: string;
  max_zoom: number | null;
  min_zoom: number | null;
  url: string;
}

export type TileServerRecord = TileServerBaseRecord & BasemapMetadata;

export type BasemapDefinition =
  { kind: "raster"; style_url: null } | { kind: "vector"; style_url: string };

export function isBasemapStyleUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 4096 ||
    /[\\#\p{Cc}]/u.test(value)
  )
    return false;
  const localPath = value.startsWith("/") && !value.startsWith("//");
  if (!localPath && !/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value, "https://map.invalid");
    return !!url.hostname && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** 描画方法を変更せず、旧設定と新設定を共通のメタデータへ正規化する。 */
export function normalizeBasemapDefinition(value: unknown): BasemapDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, style_url } = value as Record<string, unknown>;
  if (kind === undefined || kind === "raster") {
    return style_url === undefined || style_url === null
      ? { kind: "raster", style_url: null }
      : null;
  }
  return kind === "vector" && isBasemapStyleUrl(style_url) ? { kind: "vector", style_url } : null;
}
