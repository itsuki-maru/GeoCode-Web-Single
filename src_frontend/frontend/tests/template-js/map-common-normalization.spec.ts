import { afterEach, describe, expect, it } from "vitest";

import { loadMapCommon, type LoadedClassicScript } from "./helpers/load-classic-script";

type NormalizationApi = {
  applyShapeArrowStyle: (layer: unknown) => void;
  escapeHtml: (text: string) => string;
  extractYouTubeId: (url: string) => string | null;
  formatArea: (area: number) => string;
  formatDistance: (distance: number) => string;
  getCircleRadiusFromGeoJson: (geojson: unknown) => number | null;
  getShapeDashArray: (lineType: string) => string | null;
  getShapeLineTypeFromDashArray: (dashArray: unknown) => string;
  getShapeStyleFromGeoJson: (shapeType: string, geojson: unknown) => Record<string, unknown>;
  isValidCoordinate: (latitude: unknown, longitude: unknown) => boolean;
  matchesMarkerSearch: (record: unknown, query: unknown) => boolean;
  matchesShapeSearch: (record: unknown, query: unknown) => boolean;
  normalizeDashArrayValue: (dashArray: unknown) => string;
  normalizeMarkerSearchText: (value: unknown) => string;
  normalizeShapeColor: (color: unknown, fallback?: string) => string;
  normalizeShapeArrowType: (arrowType: unknown, fallback?: string) => string;
  normalizeShapeLineType: (lineType: unknown, fallback?: string) => string;
  normalizeShapeName: (name: unknown) => string;
  normalizeShapeWeight: (weight: unknown, fallback?: number) => number;
  renderIframe: (html: string) => string;
  resolveSameOriginContentUrl: (url: unknown) => URL | null;
};

const exportedNames = [
  "applyShapeArrowStyle",
  "escapeHtml",
  "extractYouTubeId",
  "formatArea",
  "formatDistance",
  "getCircleRadiusFromGeoJson",
  "getShapeDashArray",
  "getShapeLineTypeFromDashArray",
  "getShapeStyleFromGeoJson",
  "isValidCoordinate",
  "matchesMarkerSearch",
  "matchesShapeSearch",
  "normalizeDashArrayValue",
  "normalizeMarkerSearchText",
  "normalizeShapeColor",
  "normalizeShapeArrowType",
  "normalizeShapeLineType",
  "normalizeShapeName",
  "normalizeShapeWeight",
  "renderIframe",
  "resolveSameOriginContentUrl",
] as const;

let loaded: LoadedClassicScript<NormalizationApi> | undefined;

function loadApi() {
  loaded = loadMapCommon<NormalizationApi>(exportedNames);
  return loaded.api;
}

afterEach(() => {
  loaded?.dom.window.close();
  loaded = undefined;
});

describe("map-commonの図形入力値の正規化", () => {
  it("図形名・色・太さ・線種を許容範囲の値に正規化する", () => {
    const api = loadApi();

    expect(api.normalizeShapeName("  避難経路  ")).toBe("避難経路");
    expect(api.normalizeShapeName(null)).toBe("");
    expect(api.normalizeShapeColor(" #AbC ")).toBe("#aabbcc");
    expect(api.normalizeShapeColor("#12EF90")).toBe("#12ef90");
    expect(api.normalizeShapeColor("red", "#010203")).toBe("#010203");
    expect(api.normalizeShapeWeight(0)).toBe(1);
    expect(api.normalizeShapeWeight(20)).toBe(10);
    expect(api.normalizeShapeWeight("7", 5)).toBe(7);
    expect(api.normalizeShapeWeight("invalid", 4)).toBe(4);
    expect(api.normalizeShapeLineType(" DASH-DOT ")).toBe("dash-dot");
    expect(api.normalizeShapeLineType("unknown", "dashed")).toBe("dashed");
    expect(api.normalizeShapeArrowType(" BOTH ")).toBe("both");
    expect(api.normalizeShapeArrowType("unknown", "start")).toBe("start");
  });

  it("折れ線の始点・終点へ矢印マーカーを適用する", () => {
    const api = loadApi();
    const path = loaded!.dom.window.document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("stroke", "#12ef90");
    const layer = {
      _path: path,
      shapeStyle: { arrowType: "both", color: "#010203" },
      shapeType: "polyline",
    };

    api.applyShapeArrowStyle(layer);
    expect(path.getAttribute("marker-start")).toBe("url(#geocode-shape-arrowhead-12ef90)");
    expect(path.getAttribute("marker-end")).toBe("url(#geocode-shape-arrowhead-12ef90)");
    const marker = loaded!.dom.window.document.getElementById("geocode-shape-arrowhead-12ef90");
    expect(marker?.getAttribute("refX")).toBe("3.25");
    expect(marker?.getAttribute("markerWidth")).toBe("4.5");
    expect(marker?.getAttribute("markerHeight")).toBe("4.5");
    expect(marker?.querySelector("path")?.getAttribute("fill")).toBe("#12ef90");

    layer.shapeStyle.arrowType = "start";
    api.applyShapeArrowStyle(layer);
    expect(path.hasAttribute("marker-start")).toBe(true);
    expect(path.hasAttribute("marker-end")).toBe(false);

    layer.shapeStyle.arrowType = "end";
    api.applyShapeArrowStyle(layer);
    expect(path.hasAttribute("marker-start")).toBe(false);
    expect(path.hasAttribute("marker-end")).toBe(true);

    layer.shapeStyle.arrowType = "none";
    api.applyShapeArrowStyle(layer);
    expect(path.hasAttribute("marker-start")).toBe(false);
    expect(path.hasAttribute("marker-end")).toBe(false);
  });

  it("現在の線色ごとに矢印マーカーを生成し、同色では再利用する", () => {
    const api = loadApi();
    const document = loaded!.dom.window.document;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("stroke", "#d94841");
    const layer = {
      _path: path,
      shapeStyle: { arrowType: "end", color: "#123456" },
      shapeType: "polyline",
    };

    api.applyShapeArrowStyle(layer);
    expect(path.getAttribute("marker-end")).toBe("url(#geocode-shape-arrowhead-d94841)");
    expect(
      document.querySelector("#geocode-shape-arrowhead-d94841 path")?.getAttribute("fill"),
    ).toBe("#d94841");

    api.applyShapeArrowStyle(layer);
    expect(document.querySelectorAll("#geocode-shape-arrowhead-d94841")).toHaveLength(1);

    path.setAttribute("stroke", "#c1121f");
    api.applyShapeArrowStyle(layer);
    expect(path.getAttribute("marker-end")).toBe("url(#geocode-shape-arrowhead-c1121f)");
    expect(
      document.querySelector("#geocode-shape-arrowhead-c1121f path")?.getAttribute("fill"),
    ).toBe("#c1121f");
    expect(document.querySelectorAll("marker")).toHaveLength(2);
    expect(document.querySelector('[fill="context-stroke"]')).toBeNull();
  });

  it("GeoJSONの矢印設定を復元し、既存データは矢印なしとして扱う", () => {
    const api = loadApi();

    expect(
      api.getShapeStyleFromGeoJson("polyline", {
        properties: { style: { arrowType: "both", color: "#123456" } },
      }),
    ).toMatchObject({ arrowType: "both", color: "#123456", fill: false });
    expect(
      api.getShapeStyleFromGeoJson("polyline", {
        properties: { style: { color: "#123456" } },
      }),
    ).toMatchObject({ arrowType: "none", color: "#123456", fill: false });
    expect(
      api.getShapeStyleFromGeoJson("polygon", {
        properties: { style: { arrowType: "both" } },
      }),
    ).not.toHaveProperty("arrowType");
  });

  it("破線パターンを対応する線種と標準表現に正規化する", () => {
    const api = loadApi();

    expect(api.normalizeDashArrayValue(" 12,  6 1,6 ")).toBe("12,6,1,6");
    expect(api.normalizeDashArrayValue(null)).toBe("");
    expect(api.getShapeLineTypeFromDashArray("12 8")).toBe("dashed");
    expect(api.getShapeLineTypeFromDashArray("1, 6")).toBe("dotted");
    expect(api.getShapeLineTypeFromDashArray("unexpected")).toBe("solid");
    expect(api.getShapeDashArray("dash-dot")).toBe("12,6,1,6");
    expect(api.getShapeDashArray("solid")).toBeNull();
  });

  it("円の半径として正の有限値だけを受け入れる", () => {
    const api = loadApi();

    expect(api.getCircleRadiusFromGeoJson({ properties: { radius: "125.5" } })).toBe(125.5);
    expect(api.getCircleRadiusFromGeoJson({ properties: { radius: 0 } })).toBeNull();
    expect(api.getCircleRadiusFromGeoJson({ properties: { radius: "invalid" } })).toBeNull();
  });
});

describe("map-commonの表示形式と検索判定", () => {
  it("距離と面積を値に応じた単位で表示する", () => {
    const api = loadApi();

    expect(api.formatDistance(12.34)).toBe("12.3 m");
    expect(api.formatDistance(150.4)).toBe("150 m");
    expect(api.formatDistance(1500)).toBe("1.50 km");
    expect(api.formatDistance(Number.NaN)).toBe("-");
    expect(api.formatArea(1234.5)).toBe("1235 m²");
    expect(api.formatArea(2_500_000)).toBe("2.50 km²");
    expect(api.formatArea(Number.POSITIVE_INFINITY)).toBe("-");
  });

  it("緯度と経度が有効範囲内か判定する", () => {
    const api = loadApi();

    expect(api.isValidCoordinate(90, 180)).toBe(true);
    expect(api.isValidCoordinate(-90, -180)).toBe(true);
    expect(api.isValidCoordinate(90.0001, 0)).toBe(false);
    expect(api.isValidCoordinate(0, -180.0001)).toBe(false);
    expect(api.isValidCoordinate("not-a-number", 139)).toBe(false);
  });

  it("大文字小文字を区別せずマーカーと図形の対象項目を検索する", () => {
    const api = loadApi();
    const marker = {
      detail: "Near the EAST gate",
      latitude: 35.6812,
      longitude: 139.7671,
      marker_name: "Tokyo Station",
    };
    const shape = {
      geojson: { properties: { memo: "洪水時の避難ルート" } },
      name: "Route A",
    };

    expect(api.normalizeMarkerSearchText("  TOKYO ")).toBe("tokyo");
    expect(api.matchesMarkerSearch(marker, "east")).toBe(true);
    expect(api.matchesMarkerSearch(marker, "35.6812")).toBe(true);
    expect(api.matchesMarkerSearch(marker, "west")).toBe(false);
    expect(api.matchesMarkerSearch(marker, "   ")).toBe(true);
    expect(api.matchesShapeSearch(shape, "route a")).toBe(true);
    expect(api.matchesShapeSearch(shape, "避難")).toBe(true);
    expect(api.matchesShapeSearch(shape, "通行止め")).toBe(false);
  });
});

describe("map-commonのURLとHTMLの安全性境界", () => {
  it("対応するYouTube URL形式からだけ動画IDを抽出する", () => {
    const api = loadApi();
    const id = "abcdefghijk";

    expect(api.extractYouTubeId(`https://youtu.be/${id}`)).toBe(id);
    expect(api.extractYouTubeId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
    expect(api.extractYouTubeId(`https://youtube.com/shorts/${id}`)).toBe(id);
    expect(api.extractYouTubeId(`https://www.youtube-nocookie.com/embed/${id}`)).toBe(id);
    expect(api.extractYouTubeId(`https://evil.example/watch?v=${id}`)).toBeNull();
    expect(api.extractYouTubeId("not a url")).toBeNull();
  });

  it("HTMLをエスケープし有効な動画プレースホルダーだけをiframe化する", () => {
    const api = loadApi();

    expect(api.escapeHtml(`<a title="'">&</a>`)).toBe(
      "&lt;a title=&quot;&#39;&quot;&gt;&amp;&lt;/a&gt;",
    );
    const rendered = api.renderIframe('<app-youtube video-id="abcdefghijk"></app-youtube>');
    expect(rendered).toContain("https://www.youtube-nocookie.com/embed/abcdefghijk");
    expect(api.renderIframe('<app-youtube video-id="short"></app-youtube>')).toContain(
      "<app-youtube",
    );
  });

  it("同一オリジンのコンテンツURLだけを解決する", () => {
    const api = loadApi();

    expect(api.resolveSameOriginContentUrl("/static/images/map.png")?.pathname).toBe(
      "/static/images/map.png",
    );
    expect(
      api.resolveSameOriginContentUrl("https://example.test/images/html/info.html")?.pathname,
    ).toBe("/images/html/info.html");
    expect(api.resolveSameOriginContentUrl("https://attacker.example/map.png")).toBeNull();
    expect(api.resolveSameOriginContentUrl(42)).toBeNull();
  });
});
