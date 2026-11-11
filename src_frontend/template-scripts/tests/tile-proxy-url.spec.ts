import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tileProxyRenderUrl } from "../src/map/common/tile-proxy-url";

const tilePath = "/tile/{z}/{x}/{y}.png";
const revision = "018f6ff0-08eb-7da6-8727-6531bc7b4414";

afterEach(() => {
  delete window.__GEOCODE_TILE_PROXY_REVISION__;
});

describe("tile proxy rendering URL", () => {
  it.each([undefined, null, "invalid&v=injected"])("preserves the URL with revision %s", (value) => {
    window.__GEOCODE_TILE_PROXY_REVISION__ = value;
    const template = `${tilePath}?other=a%20b#position`;
    expect(tileProxyRenderUrl(template)).toBe(template);
  });

  it("preserves Leaflet placeholders and existing parameters while replacing the revision", () => {
    window.__GEOCODE_TILE_PROXY_REVISION__ = revision;
    expect(tileProxyRenderUrl(tilePath)).toBe(`${tilePath}?v=${revision}`);
    expect(tileProxyRenderUrl(`${tilePath}?other=a%20b&v=old&%76=older#position`)).toBe(
      `${tilePath}?other=a%20b&v=${revision}#position`,
    );
  });

  it("limits the revision to this application's exact tile template", () => {
    window.__GEOCODE_TILE_PROXY_REVISION__ = revision;
    const own = `${window.location.origin}${tilePath}`;
    expect(tileProxyRenderUrl(own)).toBe(`${own}?v=${revision}`);
    for (const template of [
      `https://tiles.example.test${tilePath}?token=a%20b`,
      `${window.location.origin}/proxy${tilePath}`,
      `//tiles.example.test${tilePath}`,
      "/tile/{z}/{x}/{y}.jpg",
      "/tile/{z}/{x}/{y}.pbf",
    ]) {
      expect(tileProxyRenderUrl(template)).toBe(template);
    }
  });

  it("loads the revision before the map module in every drawing template", () => {
    const templates = [
      ...[
        "map",
        "map-mobile",
        "map-anather",
        "temporary-map",
        "temporary-map-mobile",
        "form-answer-map",
        "form-answer-map-print",
        "live-map",
      ].map((page) => `../../src/templates/${page}.html`),
      "public/read-only-map-print.html",
    ];
    for (const path of templates) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      const doc = new DOMParser().parseFromString(source, "text/html");
      const revisionScripts = doc.querySelectorAll('script[src="/tile-proxy-revision.js"]');
      expect(revisionScripts, path).toHaveLength(1);
      const script = revisionScripts[0]!;
      expect(script.matches("[async], [defer], [type]"), path).toBe(false);
      const module = doc.querySelector('script[type="module"]');
      expect(module, path).not.toBeNull();
      expect(script.compareDocumentPosition(module!) & Node.DOCUMENT_POSITION_FOLLOWING, path)
        .toBeTruthy();
    }
  });
});
