import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function setup() {
  let configuration: any;
  const manager = { refresh: vi.fn(), scheduleRefresh: vi.fn(), destroy: vi.fn() };
  const context = createContext({
    editorEntryProfile: { isMobile: true },
    editorShapeRecords: new Map(),
    editorShapeSearchCache: new WeakMap(),
    localMarkerSearchQuery: "needle",
    matchesShapeSearch: vi.fn((record, query) => record.name.includes(query)),
    is_master: true,
    externalShapeFilterIdSet: null,
    deletedShapeIds: new Set(),
    savingShapeIds: new Map(),
    recentlyCreatedShapeId: null,
    focusedEditorShapeId: null,
    geometryEditingShapeLayer: null,
    editingShapeLayer: null,
    circleShapeDragState: null,
    measurementSelectedShapes: new Set(),
    isEditorShapePopupOpen: () => false,
    shapeNameLabelManager: null,
    shapeMeasurementManager: null,
    layersFromAxum: {},
    drawnShapesGroup: {},
    map: { hasLayer: () => true, on: vi.fn() },
    createShapeRenderManager: vi.fn((options) => {
      configuration = options;
      return manager;
    }),
    fetchWithAuth: vi.fn(),
  });
  runInContext(readFileSync("src/map/editor/map-editor-shape-metadata.ts", "utf8"), context);
  context.initializeEditorShapeRendering();
  return { context, manager, configuration };
}
const layer = () => ({ shapeId: "shape-1", layerId: "layer-1", shapeType: "polyline" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("editor shape lifecycle", () => {
  it("keeps an object pinned while metadata is saving even after the editor is closed", async () => {
    const { context, configuration } = setup();
    const response = deferred<{ ok: boolean }>();
    context.fetchWithAuth.mockReturnValue(response.promise);
    const shape = layer();
    const saving = context.persistShapeMetadata(shape, "name", "layer-1", null);
    expect(configuration.isPinned("shape-1", shape)).toBe(true);
    expect(configuration.isPinned("shape-1", null)).toBe(true);
    response.resolve({ ok: true });
    await saving;
    expect(configuration.isPinned("shape-1", shape)).toBe(false);
  });

  it("retains a save pin until the last concurrent save finishes", async () => {
    const { context, configuration } = setup();
    const first = deferred<{ ok: boolean }>();
    const second = deferred<{ ok: boolean }>();
    context.fetchWithAuth.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const shape = layer();
    const a = context.persistShapeMetadata(shape, "first", "layer-1", null);
    const b = context.persistShapeMetadata(shape, "second", "layer-1", null);
    first.resolve({ ok: true });
    await a;
    expect(configuration.isPinned("shape-1", shape)).toBe(true);
    second.resolve({ ok: false });
    await expect(b).rejects.toThrow("shape update failed");
    expect(configuration.isPinned("shape-1", shape)).toBe(false);
  });

  it("reuses mobile search results but recomputes after a query or record update", () => {
    const { context } = setup();
    const record = { id: "shape-1", name: "needle" };
    expect(context.isEditorShapeRecordVisible(record)).toBe(true);
    expect(context.isEditorShapeRecordVisible(record)).toBe(true);
    expect(context.matchesShapeSearch).toHaveBeenCalledTimes(1);
    context.localMarkerSearchQuery = "updated";
    expect(context.isEditorShapeRecordVisible(record)).toBe(false);
    expect(context.isEditorShapeRecordVisible({ ...record, name: "updated" })).toBe(true);
    expect(context.matchesShapeSearch).toHaveBeenCalledTimes(3);
  });
});
