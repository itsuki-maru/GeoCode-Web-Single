import { describe, expect, it } from "vitest";
import {
  editBackgroundMapForm,
  newBackgroundMapForm,
  validateBackgroundMapForm,
  type BackgroundMapForm,
  type BackgroundMapRecord,
} from "../background-maps";

const legacy: BackgroundMapRecord = {
  id: 1,
  label: "旧背景",
  layer_name: "legacy",
  url: "/tile/{z}/{x}/{y}.png",
  attribution: '<span>既存出典</span>\n<a href="https://example.test">出典</a>',
  include_foreign_tiles: false,
  min_zoom: null,
  max_zoom: null,
};
const valid = (values: Partial<BackgroundMapForm> = {}) => ({
  ...editBackgroundMapForm(legacy),
  layer_name: "new",
  ...values,
});
const check = (values: Partial<BackgroundMapForm> = {}, id: number | null = null) =>
  validateBackgroundMapForm(valid(values), id, [legacy]);

describe("背景地図設定の入力検証", () => {
  it("旧種別省略をラスタとして読み、nullズームと出典原文を保存する", () => {
    const form = editBackgroundMapForm(legacy);
    expect(form.kind).toBe("raster");
    expect(form.min_zoom).toBe("");
    expect(form.max_zoom).toBe("");
    expect(validateBackgroundMapForm(form, 1, [legacy]).input).toEqual({
      ...legacy,
      id: undefined,
      kind: "raster",
      style_url: null,
    });
    expect(newBackgroundMapForm()).toMatchObject({ kind: "raster", min_zoom: "", max_zoom: "" });
  });

  it.each([
    "/tile/{z}/{x}/{y}.png",
    "https://{s}.example.test/{z}/{x}/{-y}{r}.png",
    "http://tiles.example.test/{z}/{x}/{y}.png",
    "/fixed.png",
    "https://example.test/fixed.png",
  ])("既存互換の画像URLを許可する: %s", (url) => {
    expect(check({ url }).error).toBeUndefined();
  });

  it.each([
    "",
    "//other.test/a.png",
    "javascript:alert(1)",
    "data:image/png;base64,a",
    "relative/a.png",
    "https://user:secret@tiles.test/a.png",
    "https://tiles.test/a.png#fragment",
    "/\\other.test/a.png",
    "https://tiles.test/{quadkey}.png",
    "/{missing}.png",
    "https://tiles.test/a.png\n",
    "https://tiles.test/\u0085a.png",
    "/" + "a".repeat(255),
  ])("不正な画像URLは送信しない: %s", (url) => {
    expect(check({ url }).error).toBeTruthy();
  });

  it.each([
    "",
    "http://tiles.test/style.json",
    "//tiles.test/style.json",
    "style.json",
    "https://user:secret@tiles.test/style.json",
    "/style.json#part",
    "/style.json\n",
    " /style.json",
    "/style.json ",
    "/\\tiles.test/style.json",
    "/" + "あ".repeat(1366),
  ])("不正なベクタスタイルを送信しない: %s", (style_url) => {
    expect(check({ kind: "vector", style_url }).error).toContain("スタイルURL");
  });

  it("4096 UTF-8バイトのスタイルとズーム0を受け入れ、ラスタへの変更は隠れたスタイルを送らない", () => {
    const style_url = "/" + "あ".repeat(1365);
    expect(new TextEncoder().encode(style_url).length).toBe(4096);
    expect(check({ kind: "vector", style_url, min_zoom: 0, max_zoom: 22 }).input).toMatchObject({
      kind: "vector",
      style_url,
      min_zoom: 0,
      max_zoom: 22,
    });
    expect(
      check({ kind: "raster", style_url: "javascript:retained-hidden-text" }).input?.style_url,
    ).toBeNull();
  });

  it.each([
    { min_zoom: -1 },
    { max_zoom: 23 },
    { min_zoom: 5.5 },
    { min_zoom: "5" },
    { min_zoom: 19, max_zoom: "" },
    { min_zoom: "", max_zoom: 4 },
    { min_zoom: 10, max_zoom: 9 },
  ])("無効なズームと実効既定値の逆転を拒否する: %j", (values) => {
    expect(check(values).error).toContain("ズーム");
  });

  it("文字数・識別名重複・ID1種別変更を検証し、既存の重複識別名を維持する編集を許可する", () => {
    for (const field of ["label", "layer_name", "attribution"] as const)
      expect(check({ [field]: "あ".repeat(256) }).error).toBeTruthy();
    expect(check({ label: " " }).error).toContain("表示名");
    expect(check({ layer_name: " " }).error).toContain("識別名");
    expect(check({ label: "new\nname" }).error).toContain("制御文字");
    expect(check({ attribution: "credit\0" }).error).toBeTruthy();
    expect(check({ layer_name: "legacy" }).error).toContain("使用されています");
    expect(check({ kind: "vector", style_url: "/style.json" }, 1).error).toContain("ID 1");
    expect(check({ kind: "unknown" as any }).error).toContain("種別");
    const same = { ...legacy, id: 2 };
    expect(
      validateBackgroundMapForm({ ...editBackgroundMapForm(legacy), label: "改名" }, 1, [
        legacy,
        same,
      ]).error,
    ).toBeUndefined();
  });
});
