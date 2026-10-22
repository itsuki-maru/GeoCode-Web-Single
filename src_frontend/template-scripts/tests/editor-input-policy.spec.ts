import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function setup() {
  const c = createContext({
    layersFromAxum: { locked: { restrict_free_text: true }, free: { restrict_free_text: false } },
    currentMapMode: "edit",
    activeDrawMode: null,
    document,
    fetchWithAuth: vi.fn().mockResolvedValue({ ok: true }),
    setDrawStatus: vi.fn(),
    shapeGeometryEditHandles: { clearLayers: vi.fn() },
  });
  for (const file of ["map-editor-shape-metadata.ts", "map-editor-shape-geometry.ts"])
    runInContext(readFileSync(resolve(`src/map/editor/${file}`), "utf8"), c);
  const geojson = {
    type: "Feature",
    properties: { memo: "既存メモ" },
    geometry: {
      type: "LineString",
      coordinates: [
        [139, 35],
        [140, 36],
      ],
    },
  };
  return {
    c,
    shape: {
      shapeId: "s",
      layerId: "locked",
      shapeType: "polyline",
      options: { shapeRecord: { geojson } },
    },
  };
}

describe("地図編集の自由記述制限", () => {
  it("名前と所属レイヤだけの更新は許可し、メモを含む更新を送信しない", async () => {
    const { c, shape } = setup();
    await c.persistShapeMetadata(shape, "名前", "free", null);
    expect(c.fetchWithAuth).toHaveBeenCalledOnce();
    const body = JSON.parse(c.fetchWithAuth.mock.calls[0][1].body);
    expect(body).toMatchObject({ name: "名前", layer_id: "free", geojson: null });
    const changed = structuredClone(shape.options.shapeRecord.geojson);
    changed.properties.memo = "迂回編集";
    await expect(c.persistShapeMetadata(shape, "名前", "free", changed)).rejects.toThrow(
      "入力が制限されています",
    );
    shape.layerId = "free";
    await expect(c.persistShapeMetadata(shape, "名前", "locked", changed)).rejects.toThrow();
    expect(c.fetchWithAuth).toHaveBeenCalledOnce();
  });
  it("制限中も頂点を持つ図形は編集対象とし、円の移動は開始しない", () => {
    const { c, shape } = setup();
    expect(c.canAddVertexToShape(shape)).toBe(true);
    expect(c.canAddVertexToShape({ ...shape, shapeType: "polygon" })).toBe(true);
    expect(c.canAddVertexToShape({ ...shape, shapeType: "rectangle" })).toBe(true);
    const circle = { ...shape, shapeType: "circle" };
    expect(c.startCircleShapeDrag(circle)).toBe(false);
    expect(c.selectShapeForGeometryEdit(circle)).toBe(false);
    expect(c.canAddVertexToShape(circle)).toBe(false);
    expect(c.fetchWithAuth).not.toHaveBeenCalled();
  });
  it("制限付きレイヤのマーカーだけドラッグを無効にする", () => {
    const { c } = setup();
    const marker = { dragging: { enable: vi.fn(), disable: vi.fn() } };
    c.syncMarkerInputRestriction(marker, { layer_id: "locked" });
    expect(marker.dragging.disable).toHaveBeenCalledOnce();
    c.syncMarkerInputRestriction(marker, { layer_id: "free" });
    expect(marker.dragging.enable).toHaveBeenCalledOnce();
    c.currentMapMode = "view";
    c.syncMarkerInputRestriction(marker, { layer_id: "free" });
    expect(marker.dragging.disable).toHaveBeenCalledTimes(2);
  });
  it("自由記述を変えずに保存するときは元の順序を維持し、変更しても回答部分を保持する", () => {
    const { c } = setup();
    const info = {
      body: "前回答1後回答2",
      free_text: "前後",
      parts: [
        { type: "text", text: "前" },
        { type: "answer", id: "a", markdown: "回答1" },
        { type: "text", text: "後" },
        { type: "answer", id: "b", markdown: "回答2" },
      ],
    };
    expect(c.mergeShapeFreeText(info, "前後")).toBe("前回答1後回答2");
    expect(c.mergeShapeFreeText(info, "変更後")).toBe("変更後回答1回答2");
  });
});
