import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  mapCommonScriptNames,
  templateJsFileNames,
  templateScriptNames,
  templateJsPath,
} from "./helpers/load-classic-script";

const pageContracts = [
  { templateName: "map.html", entryScript: "map.js" },
  { templateName: "map-mobile.html", entryScript: "map-mobile.js" },
  { templateName: "map-anather.html", entryScript: "map-anather.js" },
  { templateName: "temporary-map.html", entryScript: "temporary-map.js" },
  {
    templateName: "temporary-map-mobile.html",
    entryScript: "temporary-map-mobile.js",
  },
] as const;

const sharedEditorScriptNames = [
  "map-editor-mode.js",
  "map-editor-shape-measurement.js",
  "map-editor-shape-delete.js",
  "map-editor-shape-geometry.js",
] as const;
const sharedMapObjectFocusScriptName = "map-object-focus.js";

const allScriptNames = Array.from(
  new Set(pageContracts.flatMap(({ templateName }) => templateScriptNames(templateName))),
);

function readRepositoryFile(relativePath: string) {
  return readFileSync(resolve(process.cwd(), "../..", relativePath), "utf8");
}

describe("テンプレートJavaScriptの本番配信契約", () => {
  it("全テンプレートJavaScriptのファイル名が一意でHTMLから参照される", () => {
    expect([...allScriptNames].sort()).toEqual(templateJsFileNames);
  });

  it.each(allScriptNames)("%sがclassic scriptとして正しい構文である", (scriptName) => {
    const source = readFileSync(templateJsPath(scriptName), "utf8");

    expect(() => new Script(source, { filename: scriptName })).not.toThrow();
  });

  it.each(pageContracts)(
    "$templateNameが共通スクリプトと画面別スクリプトを所定順で一度ずつ読み込む",
    ({ templateName, entryScript }) => {
      const scriptNames = templateScriptNames(templateName);

      expect(scriptNames.slice(0, mapCommonScriptNames.length)).toEqual(mapCommonScriptNames);
      expect(scriptNames.at(-1)).toBe(entryScript);
      expect(new Set(scriptNames).size).toBe(scriptNames.length);
    },
  );

  it.each(["map.html", "map-mobile.html"])(
    "%sが同じ編集共通スクリプトを一度ずつ読み込む",
    (templateName) => {
      const scriptNames = templateScriptNames(templateName);

      sharedEditorScriptNames.forEach((scriptName) => {
        expect(scriptNames.filter((name) => name === scriptName)).toHaveLength(1);
      });
      expect(scriptNames.indexOf("map-editor-mode.js")).toBeLessThan(
        scriptNames.indexOf("map-editor-shape-measurement.js"),
      );
      expect(scriptNames.indexOf("map-editor-shape-measurement.js")).toBeLessThan(
        scriptNames.indexOf("map-editor-shape-delete.js"),
      );
      expect(scriptNames.indexOf("map-editor-shape-delete.js")).toBeLessThan(
        scriptNames.indexOf("map-editor-shape-geometry.js"),
      );
    },
  );

  it.each([
    { controlsScript: "map-controls.js", entryScript: "map.js", templateName: "map.html" },
    {
      controlsScript: "map-mobile-controls.js",
      entryScript: "map-mobile.js",
      templateName: "map-mobile.html",
    },
  ])(
    "$templateNameが共通フォーカス処理をコントロール初期化後に一度だけ読み込む",
    ({ controlsScript, entryScript, templateName }) => {
      const scriptNames = templateScriptNames(templateName);

      expect(scriptNames.filter((name) => name === sharedMapObjectFocusScriptName)).toHaveLength(1);
      expect(scriptNames.indexOf(controlsScript)).toBeLessThan(
        scriptNames.indexOf(sharedMapObjectFocusScriptName),
      );
      expect(scriptNames.indexOf(sharedMapObjectFocusScriptName)).toBeLessThan(
        scriptNames.indexOf(entryScript),
      );
    },
  );

  it("PowerShellビルドでテンプレートJavaScriptを配布先へコピーする", () => {
    const builder = readRepositoryFile("src_frontend/scripts/frontends-builder.ps1");

    expect(builder).toContain(
      'Get-ChildItem -LiteralPath $rustTemplateJsDir -Recurse -File -Filter "*.js"',
    );
    expect(builder).toContain("Group-Object -Property Name");
    expect(builder).toContain(
      "Copy-Item -LiteralPath $templateJsFile.FullName -Destination $movedDir -Force",
    );
  });

  it("UnixビルドでテンプレートJavaScriptを配布先へコピーする", () => {
    const builder = readRepositoryFile("src_frontend/scripts/frontends-builder.sh");

    expect(builder).toContain('rustTemplateJsDir="$rustTemplatesDir/js"');
    expect(builder).toContain("find \"$rustTemplateJsDir\" -type f -name '*.js'");
    expect(builder).toContain("sort | uniq -d");
    expect(builder).toContain('-exec cp -f {} "$mainDistAssetsDir"');
  });

  it("編集地図の折れ線ホバー強調をPC版だけで有効にする", () => {
    expect(readPageScripts("map.html")).toContain("bindPolylineHoverHighlight: true");
    expect(readPageScripts("map-mobile.html")).toContain("bindPolylineHoverHighlight: false");
    expect(readPageScripts("map-anather.html")).toContain("bindPolylineHoverHighlight(layer");
    expect(readPageScripts("temporary-map.html")).toContain("bindPolylineHoverHighlight(layer");
    expect(readPageScripts("temporary-map-mobile.html")).not.toContain(
      "bindPolylineHoverHighlight(layer",
    );
  });

  it("共有計測と形状編集が画面別プロファイルだけを参照する", () => {
    const measurementSource = readFileSync(
      templateJsPath("map-editor-shape-measurement.js"),
      "utf8",
    );
    const geometrySource = readFileSync(templateJsPath("map-editor-shape-geometry.js"), "utf8");

    expect(measurementSource).toContain("mapEditorProfile.isShapeVisibleForMeasurement(layer)");
    expect(measurementSource).toContain("mapEditorProfile.shouldSuppressShapeLabelClick()");
    expect(measurementSource).not.toContain("isShapeVisibleForExternalFilter(layer)");
    expect(measurementSource).not.toContain("isShapeVisibleForSearch(layer)");
    expect(geometrySource).toContain("mapEditorProfile.bindPolylineHoverHighlight");
  });

  it("通常の地図画面だけが初期図形抑止を使用する", () => {
    ["map.html", "map-mobile.html", "map-anather.html"].forEach((templateName) => {
      expect(readPageScripts(templateName)).toContain("shouldSuppressInitialShapeRendering(");
    });
    ["temporary-map.html", "temporary-map-mobile.html"].forEach((templateName) => {
      expect(readPageScripts(templateName)).not.toContain("shouldSuppressInitialShapeRendering(");
    });
  });

  it("全地図画面が表示範囲内の計測生成を使用する", () => {
    pageContracts.forEach(({ templateName }) => {
      const source = readPageScripts(templateName);
      expect(source).toContain("createViewportShapeMeasurementManager({");
    });
  });
});

function readPageScripts(templateName: string) {
  return templateScriptNames(templateName)
    .slice(mapCommonScriptNames.length)
    .map((scriptName) => readFileSync(templateJsPath(scriptName), "utf8"))
    .join("");
}
