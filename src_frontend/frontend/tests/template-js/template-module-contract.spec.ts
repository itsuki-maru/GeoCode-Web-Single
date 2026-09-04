import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { editorEntrySources } from "../../../template-scripts/src/entries/editor-entry-sources";
import {
  editorImplementationScriptNames,
  editorSourcePath,
} from "./helpers/editor-entry-source";

const repositoryRoot = resolve(process.cwd(), "../..");
const editorPages = ["map", "map-mobile"] as const;
const mapPages = [
  "map",
  "map-mobile",
  "map-anather",
  "temporary-map",
  "temporary-map-mobile",
] as const;

function readRepositoryFile(relativePath: string) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function editorSourceByName(fileName: string) {
  const relativePath = Object.values(editorEntrySources)
    .flat()
    .find((source) => basename(source) === fileName);
  if (!relativePath) throw new Error(`Editor TypeScript source was not found: ${fileName}`);
  return readFileSync(editorSourcePath(relativePath), "utf8");
}

function readPageImplementation(pageName: (typeof mapPages)[number]) {
  if (!editorPages.includes(pageName as (typeof editorPages)[number])) {
    return readRepositoryFile("src_frontend/template-scripts/src/map/read-only-page.ts");
  }
  return editorEntrySources[pageName as (typeof editorPages)[number]]
    .map((source) => readFileSync(editorSourcePath(source), "utf8"))
    .join("\n");
}

describe("地図テンプレートのES Modules配信契約", () => {
  it("互換JavaScriptディレクトリを撤去している", () => {
    expect(existsSync(resolve(repositoryRoot, "src/templates/js"))).toBe(false);
  });

  it.each(editorPages)("%sの実装が一意なTypeScriptだけで構成される", (pageName) => {
    const sources = editorEntrySources[pageName];
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources.every((source) => source.endsWith(".ts"))).toBe(true);
    const combinedSource = sources
      .map((source) => readFileSync(editorSourcePath(source), "utf8"))
      .join("\n");
    expect(() => new Script(`"use strict";\n${combinedSource}`)).not.toThrow();
  });

  it.each(mapPages)("%s.htmlが生成moduleを1本だけ読み込む", (pageName) => {
    const template = readRepositoryFile(`src/templates/${pageName}.html`);
    expect(template).toContain(
      `<script type="module" src="/assets/template-${pageName}.js"></script>`,
    );
    expect(template).not.toMatch(
      /<script\s+src="\/assets\/(?:map-common|map-editor|map-(?:anather|mobile)|temporary-map)[^"]*\.js"/,
    );
  });

  it.each(mapPages)("%s.htmlが単一の型付きbootstrap境界を公開する", (pageName) => {
    const template = readRepositoryFile(`src/templates/${pageName}.html`);
    expect(template.match(/window\.__GEOCODE_MAP_BOOTSTRAP__\s*=\s*\{/g)).toHaveLength(1);
    expect(template).not.toMatch(/var tileServers\s*=\s*\{\{\s*tileServers/);
  });

  it("map-anather.htmlがバックエンド指定の初期表示位置を公開する", () => {
    const template = readRepositoryFile("src/templates/map-anather.html");
    expect(template).toContain("initialView:");
    expect(template).toContain("latitude: {{ latitude }}");
    expect(template).toContain("longitude: {{ longitude }}");
    expect(template).toContain("zoom: {{ zoom }}");
  });

  it("PC・モバイルが編集機能を共有し、PC固有フィルターだけを分離する", () => {
    const sharedSources = [
      "map-editor-mode.ts",
      "map-editor-shape-state.ts",
      "map-editor-shape-measurement.ts",
      "map-editor-shape-metadata.ts",
      "map-editor-shape-delete.ts",
      "map-editor-shape-geometry.ts",
      "map-editor-shape-drawing.ts",
      "map-editor-controls.ts",
      "map-editor-final.ts",
    ];
    editorPages.forEach((pageName) => {
      const names = editorImplementationScriptNames(pageName);
      sharedSources.forEach((source) => expect(names).toContain(source));
    });
    expect(editorImplementationScriptNames("map")).toContain("map-editor-shape-filter.ts");
    expect(editorImplementationScriptNames("map-mobile")).not.toContain(
      "map-editor-shape-filter.ts",
    );
  });

  it("Vite entryがTS共通moduleとフォーカス処理を組み立てる", () => {
    const config = readRepositoryFile("src_frontend/template-scripts/vite.config.ts");
    expect(config).toContain('from "/src/map/common/map-object-focus.ts"');
    expect(config).toContain("editorCommonPrelude + editorEntryProfile + sources");
    expect(config).toContain("relativePath === \"src/map/editor/map-editor-final.ts\"");
    expect(config).not.toContain("src/templates/js");
  });

  it("図形描画をPC・モバイルで共有する", () => {
    const controls = editorSourceByName("map-editor-controls.ts");
    expect(controls).not.toContain("function handleShapeDrawLatLng");
    expect(controls).not.toContain("installPenPointerDrawingHandlers()");
  });

  it("PowerShellビルドがVite成果物の階層を保って統合する", () => {
    const builder = readRepositoryFile("src_frontend/scripts/frontends-builder.ps1");
    expect(builder).toContain(
      'Copy-Item -Path (Join-Path $templateScriptsDistDir "*") -Destination $movedDir -Recurse -Force',
    );
    expect(builder).not.toContain("Get-ChildItem -LiteralPath $templateScriptsDistDir -File");
  });

  it("UnixビルドがVite成果物の階層を保って統合する", () => {
    const builder = readRepositoryFile("src_frontend/scripts/frontends-builder.sh");
    expect(builder).toContain('cp -r "$templateScriptsDistDir/." "$mainDistAssetsDir/"');
    expect(builder).not.toContain('find "$templateScriptsDistDir" -maxdepth 1 -type f');
  });

  it("折れ線ホバー強調をPC版だけで有効にする", () => {
    expect(editorSourceByName("map-editor-shape-state.ts")).toContain(
      "bindPolylineHoverHighlight: !editorEntryProfile.isMobile",
    );
    expect(readPageImplementation("map-anather")).toContain(
      "bindPolylineHover: !isMobile",
    );
  });

  it("共有計測と形状編集が画面別プロファイルだけを参照する", () => {
    const measurement = editorSourceByName("map-editor-shape-measurement.ts");
    const geometry = editorSourceByName("map-editor-shape-geometry.ts");
    expect(measurement).toContain("mapEditorProfile.isShapeVisibleForMeasurement(layer)");
    expect(measurement).toContain("mapEditorProfile.shouldSuppressShapeLabelClick()");
    expect(geometry).toContain("mapEditorProfile.bindPolylineHoverHighlight");
  });

  it("全地図画面が表示範囲内の計測生成を使用する", () => {
    mapPages.forEach((pageName) => {
      expect(readPageImplementation(pageName)).toContain(
        "createViewportShapeMeasurementManager({",
      );
    });
  });
});
