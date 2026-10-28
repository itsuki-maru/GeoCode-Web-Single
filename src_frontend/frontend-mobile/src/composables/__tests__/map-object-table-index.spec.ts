import { describe, expect, it, vi } from "vitest";
import { MapObjectTableIndex } from "../map-object-table-index";
import { tableRange } from "../useVirtualTable";
import * as centers from "../useShapeCenter";
import { marker, shape } from "./table-fixtures";

describe("lightweight map table index", () => {
  it("preserves unnamed/date/type-ID ordering and separates equal marker/shape IDs", () => {
    const index = new MapObjectTableIndex();
    const old = shape("old");
    old.updated_at = "invalid";
    const recent = shape("recent");
    recent.updated_at = "2026-02-01T00:00:00";
    index.reset([marker("same"), marker("blank", "  ")], [shape("same"), old, recent]);
    expect(index.keys).toEqual([
      "marker:blank",
      "shape:recent",
      "marker:same",
      "shape:same",
      "shape:old",
    ]);
    index.upsert("shape", { ...recent, name: "", updated_at: "2026-03-01T00:00:00" });
    expect(index.keys[0]).toBe("shape:recent");
    index.remove("marker", "same");
    index.remove("marker", "unknown");
    expect(index.keys).toContain("shape:same");
    expect(index.keys).not.toContain("marker:same");
  });
  it("does no geometry traversal at initial indexing and only invalidates a changed shape's center", () => {
    const spy = vi.spyOn(centers, "getShapeCenter");
    const index = new MapObjectTableIndex();
    const shapes = new Map(
      Array.from({ length: 20000 }, (_, i) => {
        const record = shape(String(i).padStart(5, "0"));
        return [record.id, record] as const;
      }),
    );
    index.reset([], shapes.values());
    expect(spy).not.toHaveBeenCalled();
    expect(index.rows.get("shape:00000")).not.toHaveProperty("geojson");
    const rows = () =>
      index.slice(
        0,
        20,
        () => undefined,
        (id) => shapes.get(id),
      );
    expect(rows()).toHaveLength(20);
    expect(spy).toHaveBeenCalledTimes(20);
    rows();
    expect(spy).toHaveBeenCalledTimes(20);
    const oldRow = index.rows.get("shape:00001");
    index.upsert("shape", shapes.get("19999")!);
    rows();
    expect(spy).toHaveBeenCalledTimes(20);
    index.upsert("shape", shapes.get("00000")!);
    rows();
    expect(spy).toHaveBeenCalledTimes(21);
    expect(index.rows.get("shape:00001")).toBe(oldRow);
    index.clear();
    expect(index.keys).toHaveLength(0);
  });
  it("bounds the rendered range independently of the total and clamps empty/last ranges", () => {
    for (const count of [2000, 20000, 40000]) {
      for (const top of [0, 50000, count * 56 - 560]) {
        const range = tableRange(count, top, 560, 36);
        expect(range.end - range.start).toBeLessThanOrEqual(23);
        expect(range.top + range.bottom + (range.end - range.start) * 56).toBe(count * 56);
      }
    }
    expect(tableRange(0, 9999, 560, 36)).toEqual({ start: 0, end: 0, top: 0, bottom: 0 });
  });
});
