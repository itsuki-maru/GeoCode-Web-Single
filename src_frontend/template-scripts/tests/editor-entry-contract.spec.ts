import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import { editorEntrySources } from "../src/entries/editor-entry-sources";

const packageDirectory = process.cwd();
const repositoryRoot = resolve(packageDirectory, "../..");

describe("editor map module entry contract", () => {
  it.each(Object.entries(editorEntrySources))(
    "%s has a complete, unique, strict-compatible source list",
    (_entryName, sources) => {
      expect(new Set(sources).size).toBe(sources.length);
      const combinedSource = sources.map((source) => {
        const path = resolve(packageDirectory, source);
        expect(existsSync(path), source).toBe(true);
        return readFileSync(path, "utf8");
      }).join("\n");
      expect(() => new Script(`"use strict";\n${combinedSource}`)).not.toThrow();
    },
  );

  it.each(Object.keys(editorEntrySources) as Array<keyof typeof editorEntrySources>)(
    "%s template loads only its generated module",
    (entryName) => {
      const template = readFileSync(
        resolve(repositoryRoot, `src/templates/${entryName}.html`),
        "utf8",
      );
      expect(template).toContain(
        `<script type="module" src="/assets/template-${entryName}.js"></script>`,
      );
      editorEntrySources[entryName].forEach((source) => {
        expect(template).not.toContain(`/assets/${basename(source)}`);
      });
    },
  );

  it("uses Vite virtual entries for both editor maps", () => {
    const source = readFileSync(resolve(packageDirectory, "vite.config.ts"), "utf8");
    expect(source).toContain('map: `${editorVirtualPrefix}map`');
    expect(source).toContain('"map-mobile": `${editorVirtualPrefix}map-mobile`');
    expect(source).toContain('name: "geocode-editor-entries"');
    expect(source).toContain('from "/src/map/common/map-object-focus.ts"');
    expect(source).toContain("createMapObjectFocusController({");
  });

  it("does not depend on removed compatibility scripts", () => {
    Object.values(editorEntrySources).forEach((sources) => {
      expect(sources.every((source) => source.endsWith(".ts"))).toBe(true);
    });
    expect(existsSync(resolve(repositoryRoot, "src/templates/js"))).toBe(false);
  });

  it("loads all shared editor features from TypeScript sources", () => {
    const expectedSources = [
      "src/map/editor/map-editor-mode.ts",
      "src/map/editor/map-editor-shape-state.ts",
      "src/map/editor/map-editor-shape-measurement.ts",
      "src/map/editor/map-editor-shape-metadata.ts",
      "src/map/editor/map-editor-shape-delete.ts",
      "src/map/editor/map-editor-shape-geometry.ts",
      "src/map/editor/map-editor-shape-drawing.ts",
      "src/map/editor/map-editor-controls.ts",
      "src/map/editor/map-editor-final.ts",
    ];
    Object.values(editorEntrySources).forEach((sources) => {
      expectedSources.forEach((source) => expect(sources).toContain(source));
      expect(sources.filter((source) => source.startsWith("editor/"))).toEqual([]);
    });
  });

  it("shares editor state and metadata while keeping the PC filter local", () => {
    const sharedState = "src/map/editor/map-editor-shape-state.ts";
    const sharedMetadata = "src/map/editor/map-editor-shape-metadata.ts";
    expect(editorEntrySources.map).toContain(sharedState);
    expect(editorEntrySources["map-mobile"]).toContain(sharedState);
    expect(editorEntrySources.map).toContain(sharedMetadata);
    expect(editorEntrySources["map-mobile"]).toContain(sharedMetadata);
    expect(editorEntrySources.map).toContain(
      "src/map/editor/map-editor-shape-filter.ts",
    );
    expect(editorEntrySources["map-mobile"]).not.toContain(
      "src/map/editor/map-editor-shape-filter.ts",
    );
  });

  it("shares one TypeScript drawing implementation", () => {
    const sharedDrawing = "src/map/editor/map-editor-shape-drawing.ts";
    expect(editorEntrySources.map.filter((source) => source === sharedDrawing)).toHaveLength(1);
    expect(
      editorEntrySources["map-mobile"].filter((source) => source === sharedDrawing),
    ).toHaveLength(1);
    Object.values(editorEntrySources).forEach((sources) => {
      expect(sources.some((source) => source.endsWith("-shape-drawing.js"))).toBe(false);
    });
  });

  it("assembles editor maps only from TypeScript sources", () => {
    Object.values(editorEntrySources).forEach((sources) => {
      expect(sources.every((source) => source.endsWith(".ts"))).toBe(true);
    });
    expect(editorEntrySources.map).toContain("src/map/editor/map-editor-base.ts");
    expect(editorEntrySources["map-mobile"]).toContain(
      "src/map/editor/map-editor-mobile-base.ts",
    );
  });
});
