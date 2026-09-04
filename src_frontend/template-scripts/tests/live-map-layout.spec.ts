import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("live map layout", () => {
  it("keeps the map in the viewport-filling grid row while the error is hidden", () => {
    const template = readFileSync(
      resolve(process.cwd(), "../../src/templates/live-map.html"),
      "utf8",
    );

    expect(template).toMatch(/grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
    expect(template).toMatch(/main\s*\{[^}]*grid-row:\s*3;/);
    expect(template).toMatch(/#map\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/);
    expect(template).toContain('aria-label="共有対象一覧"');
    expect(template).not.toContain("車両一覧");
    expect(template).toMatch(/header\s*\{[^}]*background:\s*#000;/s);
    expect(template).not.toMatch(/header\s*\{[^}]*border-bottom:/s);
    expect(template).toMatch(/#map-title\s*\{[^}]*color:\s*#f5f5f5;/s);
    expect(template).toMatch(/#connection-status\s*\{[^}]*color:\s*#f5f5f5;/s);
  });

  it("uses the fixed public URL and cookie authentication", () => {
    const template = readFileSync(
      resolve(process.cwd(), "../../src/templates/live-map.html"),
      "utf8",
    );
    const script = readFileSync(
      resolve(process.cwd(), "src/entries/live-map.ts"),
      "utf8",
    );

    expect(template).toContain('publicId: "{{ publicId }}"');
    expect(script).toContain("bootstrap.publicId");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("Authorization");
  });

  it("provides tile switching and one Leaflet overlay per shared member", () => {
    const script = readFileSync(
      resolve(process.cwd(), "src/entries/live-map.ts"),
      "utf8",
    );

    expect(script).toContain("Object.entries(tileServers)");
    expect(script).toContain("selectTileServer");
    expect(script).toContain("tileServer.include_foreign_tiles");
    expect(script).toContain("L.control.layers(null, null");
    expect(script).toContain("collapsed: false");
    expect(script).toContain("createCollapsibleLayerControl");
    expect(script).toContain("locationLayersControl.addOverlay");
    expect(script).toContain("L.layerGroup().addTo(map)");
    expect(script).toContain("addTo(memberLayer)");
  });

  it("adds viewer-location and shared-name controls", () => {
    const script = readFileSync(
      resolve(process.cwd(), "src/entries/live-map.ts"),
      "utf8",
    );
    const template = readFileSync(
      resolve(process.cwd(), "../../src/templates/live-map.html"),
      "utf8",
    );

    expect(script).toContain("createCurrentLocationControl");
    expect(script).toContain("createNameVisibilityControl");
    expect(script).toContain("setTooltipContent");
    expect(template).toContain(".custom-control-button");
    expect(template).toContain(".custom-tooltip");
    expect(template).not.toContain(".custom-control-button.is-active");
    expect(template).toMatch(/\.tile-option \+ \.tile-option\s*\{[^}]*margin-top:\s*6px/);
  });

  it("uses a full-screen map and horizontally swipeable target cards on mobile", () => {
    const template = readFileSync(
      resolve(process.cwd(), "../../src/templates/live-map.html"),
      "utf8",
    );
    const script = readFileSync(
      resolve(process.cwd(), "src/entries/live-map.ts"),
      "utf8",
    );

    expect(template).toMatch(/@media \(max-width: 700px\)[\s\S]*height:\s*100dvh/);
    expect(template).toMatch(/#vehicle-list\s*\{[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
    expect(template).toMatch(/\.vehicle\s*\{[^}]*scroll-snap-align:\s*start;/s);
    expect(template).toMatch(/#vehicle-list\s*\{[^}]*z-index:\s*1000;/s);
    expect(template).toMatch(/#vehicle-list\s*\{[^}]*bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom\)\);/s);
    expect(template).not.toMatch(/\.leaflet-bottom\s*\{[^}]*bottom:/s);
    expect(template).toMatch(/@media \(max-width: 700px\)[\s\S]*header\s*\{\s*display:\s*none;/);
    expect(template).toContain(".live-layer-control-toggle");
    expect(script).toContain('focusButton.className = "vehicle-focus"');
    expect(script).toContain("focusSharedLocation");
    expect(script).toContain("map.invalidateSize");
  });
});
