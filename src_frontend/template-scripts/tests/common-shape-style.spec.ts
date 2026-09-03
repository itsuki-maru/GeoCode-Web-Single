import { describe, expect, it } from "vitest";

import { createShapeStyleCore } from "../src/map/common/shape-style";

const defaults = {
  color: "#3388ff",
  fillOpacity: 0.2,
  weight: 5,
};

describe("map common shape style", () => {
  const style = createShapeStyleCore(() => defaults);

  it("normalizes colors and falls back to the configured default", () => {
    expect(style.normalizeShapeColor(" #ABC ")).toBe("#aabbcc");
    expect(style.normalizeShapeColor("#A1B2C3")).toBe("#a1b2c3");
    expect(style.normalizeShapeColor("red")).toBe(defaults.color);
    expect(style.normalizeShapeColor(null, "#000000")).toBe("#000000");
  });

  it("normalizes and clamps line weights", () => {
    expect(style.normalizeShapeWeight("7")).toBe(7);
    expect(style.normalizeShapeWeight(20)).toBe(10);
    expect(style.normalizeShapeWeight(-1)).toBe(1);
    expect(style.normalizeShapeWeight("invalid")).toBe(defaults.weight);
  });

  it("converts line and arrow style values", () => {
    expect(style.normalizeShapeLineType(" DASHED ")).toBe("dashed");
    expect(style.getShapeDashArray("dotted")).toBe("1,6");
    expect(style.getShapeLineTypeFromDashArray("12 6 1 6")).toBe("dash-dot");
    expect(style.normalizeShapeDashArray("12, 8")).toBe("12,8");
    expect(style.normalizeShapeArrowType("BOTH")).toBe("both");
    expect(style.normalizeShapeArrowType("invalid")).toBe("none");
  });

  it("builds typed polyline styles from GeoJSON", () => {
    expect(
      style.getShapeStyleFromGeoJson("polyline", {
        properties: {
          style: {
            arrowType: "end",
            color: "#F00",
            dashArray: "12,8",
            weight: 8,
          },
        },
      }),
    ).toEqual({
      arrowType: "end",
      color: "#ff0000",
      dashArray: "12,8",
      fill: false,
      weight: 8,
    });
  });

  it("builds area styles and preserves default values for invalid data", () => {
    expect(
      style.getShapeStyleFromGeoJson("polygon", {
        properties: {
          style: {
            color: "invalid",
            fillOpacity: "0.5",
            weight: null,
          },
        },
      }),
    ).toEqual({
      color: defaults.color,
      dashArray: null,
      fillColor: defaults.color,
      fillOpacity: 0.5,
      weight: defaults.weight,
    });
    expect(style.getDefaultShapeStyle("circle")).toEqual({
      color: defaults.color,
      dashArray: null,
      fillColor: defaults.color,
      fillOpacity: defaults.fillOpacity,
      weight: defaults.weight,
    });
  });
});
