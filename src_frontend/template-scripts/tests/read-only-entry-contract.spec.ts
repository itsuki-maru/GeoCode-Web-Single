import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDirectory = process.cwd();
const repositoryRoot = resolve(packageDirectory, "../..");
const pages = [
  "map-anather",
  "temporary-map",
  "temporary-map-mobile",
] as const;

describe("read-only TypeScript entry contract", () => {
  it.each(pages)("%s uses a dedicated TypeScript entry", (page) => {
    const entryPath = resolve(packageDirectory, `src/entries/${page}.ts`);
    const source = readFileSync(entryPath, "utf8");

    expect(source).toContain(
      `initializeReadOnlyMapPage("${page}")`,
    );
    expect(source).toContain('from "../map/read-only-page"');
  });

  it("configures Vite with physical entry files and no concatenation plugin", () => {
    const source = readFileSync(
      resolve(packageDirectory, "vite.config.ts"),
      "utf8",
    );

    pages.forEach((page) => {
      expect(source).toContain(
        `new URL("./src/entries/${page}.ts", import.meta.url)`,
      );
    });
    expect(source).not.toContain("virtual:geocode-read-only");
    expect(source).not.toContain("readOnlyEntryPlugin");
    expect(
      existsSync(resolve(packageDirectory, "read-only-entries.json")),
    ).toBe(false);
  });

  it("removes the compatibility JavaScript tree", () => {
    expect(existsSync(resolve(repositoryRoot, "src/templates/js"))).toBe(false);
  });

  it("initializes read-only behavior through imported TypeScript modules", () => {
    const source = readFileSync(
      resolve(packageDirectory, "src/map/read-only-page.ts"),
      "utf8",
    );

    [
      "createReadOnlyMapRuntime",
      "hydrateReadOnlyMarkers",
      "createReadOnlyMarkerLayerControl",
      "createReadOnlyLayerGroupRuntime",
      "createReadOnlyShapeMeasurementDisplayRuntime",
      "createReadOnlyShapeRestorationRuntime",
      "createViewportShapeLabelManager",
      "installReadOnlyOverlayHandlers",
      "addReadOnlySearchControls",
      "addReadOnlyMapVisibilityControls",
    ].forEach((name) => expect(source).toContain(name));
  });

  it.each(pages)("%s template loads only its generated module", (page) => {
    const template = readFileSync(
      resolve(repositoryRoot, `src/templates/${page}.html`),
      "utf8",
    );

    expect(template).toContain(
      `<script type="module" src="/assets/template-${page}.js"></script>`,
    );
    expect(template).not.toContain(`/assets/${page}-base.js`);
    expect(template).not.toContain(`/assets/${page}-layers.js`);
    expect(template).not.toContain(`/assets/${page}.js`);
  });
});
