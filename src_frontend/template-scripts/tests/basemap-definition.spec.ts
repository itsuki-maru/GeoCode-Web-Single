import { describe, expect, it } from "vitest";
import {
  isBasemapStyleUrl,
  normalizeBasemapDefinition,
} from "../src/map/common/basemap-definition";

describe("basemap metadata compatibility", () => {
  it("旧設定と明示的なラスタ設定を同じ定義に正規化する", () => {
    for (const value of [{}, { kind: "raster" }, { kind: "raster", style_url: null }])
      expect(normalizeBasemapDefinition(value)).toEqual({ kind: "raster", style_url: null });
  });

  it.each(["https://styles.example.test/style.json?key=public", "/assets/style.json"])(
    "ベクタのstyle URLを保持する: %s",
    (style_url) => {
      const value = { kind: "vector", style_url };
      const before = JSON.stringify(value);
      expect(normalizeBasemapDefinition(value)).toEqual(value);
      expect(JSON.stringify(value)).toBe(before);
    },
  );

  it.each([
    null,
    [],
    { kind: "unknown" },
    { kind: null },
    { kind: "vector" },
    { kind: "vector", style_url: null },
    { style_url: "/style.json" },
    { kind: "raster", style_url: "/style.json" },
  ])("曖昧または未対応の定義を拒否する: %j", (value) => {
    expect(normalizeBasemapDefinition(value)).toBeNull();
  });

  it.each([
    "",
    "style.json",
    "http://styles.example.test/style.json",
    "//styles.example.test/style.json",
    "/\\styles.example.test/style.json",
    "https://styles.example.test/\\style.json",
    "https://user:secret@styles.example.test/style.json",
    "https:///",
    "https://styles.example.test/style.json#fragment",
    "/style.json#",
    "/style\n.json",
    "/style\u0085.json",
  ])("安全でないstyle URLを拒否する: %s", (value) => {
    expect(isBasemapStyleUrl(value)).toBe(false);
  });

  it("URL長を文字数ではなくUTF-8の4096byteで制限する", () => {
    expect(isBasemapStyleUrl("/" + "a".repeat(4095))).toBe(true);
    expect(isBasemapStyleUrl("/" + "a".repeat(4096))).toBe(false);
    expect(isBasemapStyleUrl("/" + "界".repeat(1365))).toBe(true);
    expect(isBasemapStyleUrl("/" + "界".repeat(1366))).toBe(false);
  });
});
