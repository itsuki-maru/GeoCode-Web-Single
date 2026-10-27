import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("src/map/editor/map-editor-final.ts", "utf8").split(
  "// 埋め込み表示の PC 版",
)[0]!;
function setup(referrer = "https://example.test/app") {
  const postMessage = vi.fn();
  const records: Record<string, unknown> = {};
  const context = createContext({
    window: {
      __GEOCODE_MAP_BOOTSTRAP__: { dataSource: "parent" },
      parent: { postMessage },
      location: {
        origin: "https://example.test",
        href: "https://example.test/map?data_source=parent",
      },
    },
    document: { referrer },
    URL,
    setTimeout,
    clearTimeout,
    setDrawStatus: vi.fn(),
    fetchWithAuth: vi.fn(),
    clearShapeGeometryEditing: vi.fn(),
    closeShapeNameEditor: vi.fn(),
    markersClusterGroup: { clearLayers: vi.fn() },
    markers: {},
    markersFromAxum: records,
    shapesFromAxum: [],
    editorShapeRecords: new Map(),
    deletedShapeIds: new Set(),
    shapeRenderManager: { replaceRecords: vi.fn() },
    renderVisibleShapes: vi.fn(),
    editorEntryProfile: { isMobile: false },
  });
  runInContext(source, context);
  return { context, postMessage, records };
}
afterEach(() => vi.useRealTimers());

describe("editor data bridge lifecycle", () => {
  it("retries only the same delta when ACK is lost, without repeating server writes", () => {
    vi.useFakeTimers();
    const { context, postMessage } = setup();
    const object = { id: "saved", name: "canonical", updated_at: "server-time" };
    context.notifyParentMapObjectChange({ operation: "upsert", objectType: "shape", object });
    vi.advanceTimersByTime(9000);
    expect(postMessage).toHaveBeenCalledTimes(3);
    const messages = postMessage.mock.calls.map(([message]) => message);
    expect(new Set(messages.map((message) => message.change.mutationId)).size).toBe(1);
    expect(messages.every((message) => message.change.object === object)).toBe(true);
    expect(context.fetchWithAuth).not.toHaveBeenCalled();
    expect(context.setDrawStatus).toHaveBeenCalledWith(
      expect.stringContaining("保存しましたが"),
      true,
    );
  });

  it("does not disclose saved records to an untrusted embedding origin", () => {
    const { context, postMessage } = setup("https://untrusted.test/embed");
    context.notifyParentMapObjectChange({
      operation: "upsert",
      objectType: "marker",
      object: { id: "private" },
    });
    context.announceEditorRuntime();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("proxies only supported object writes to the authenticated parent", () => {
    const { context } = setup();
    for (const [url, method] of [
      ["/marker?layer_id=a", "POST"],
      ["/shape", "POST"],
      ["/shape/s/geometry", "PUT"],
      ["/marker/update/m", "PUT"],
      ["/marker/update-marker-latlng?marker_id=m", "PUT"],
      ["/shape/s", "DELETE"],
    ])
      expect(context.isParentMapObjectWrite(url, method)).toBe(true);
    for (const [url, method] of [
      ["https://external.test/shape", "POST"],
      ["/account/logout", "POST"],
      ["/shapes", "GET"],
      ["/shape/s/form", "PUT"],
    ])
      expect(context.isParentMapObjectWrite(url, method)).toBe(false);
  });

  it("cancels an older chunked snapshot before it can republish stale records", async () => {
    vi.useFakeTimers();
    const { context, records } = setup();
    context.applyMarkerUpdateFromParent = ({ object }: { object: { id: string } }) => {
      records[object.id] = object;
      return true;
    };
    const oldMarkers = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        "old-" + i,
        { id: "old-" + i, latitude: 35, longitude: 139 },
      ]),
    );
    const oldSnapshot = context.applyEditorMapSnapshot({ markers: oldMarkers, shapes: [] });
    expect(Object.keys(records)).toHaveLength(500);
    const newest = context.applyEditorMapSnapshot({
      markers: { latest: { id: "latest", latitude: 35, longitude: 139 } },
      shapes: [{ id: "latest-shape", geojson: {} }],
    });
    expect(await newest).toBe(true);
    await vi.runAllTimersAsync();
    expect(await oldSnapshot).toBe(false);
    expect(Object.keys(records)).toEqual(["latest"]);
    expect([...context.editorShapeRecords.keys()]).toEqual(["latest-shape"]);
    expect(context.shapeRenderManager.replaceRecords).toHaveBeenCalledTimes(1);
  });
});
