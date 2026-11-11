import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("src/map/editor/map-editor-final.ts", "utf8");
const printHandlers = source.slice(
  source.indexOf("// 埋め込み表示の PC 版"),
  source.indexOf("// 親ウィンドウへログイン画面遷移要求"),
);

function setup(pending = false) {
  let ready!: () => void;
  const completed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const controller = {
    pending,
    selectedId: "1",
    isPending() {
      return this.pending;
    },
    getSelectedId() {
      return this.selectedId;
    },
    whenReady: vi.fn(() => completed),
  };
  const handlers: Record<string, (event: any) => void> = {};
  const parent = { postMessage: vi.fn() };
  const context = createContext({
    URL,
    window: {
      parent,
      location: { origin: "https://example.test" },
      addEventListener: (name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
      },
    },
    document: {
      referrer: "https://example.test/app",
      querySelector: () => {
        throw Error("Uncommitted radio must not be read");
      },
    },
    getBasemapController: () => controller,
    editorEntryProfile: { isMobile: false },
    editorParentOrigin: null,
    editorDataReady: true,
    map: { getCenter: () => ({ lat: 35, lng: 139 }), getZoom: () => 10, hasLayer: () => true },
    tileOverlayManager: { getVisibility: () => ({}) },
    is_master: false,
    layer: "layer-1",
    editorColoring: { getState: () => null },
    markerClustering: { getEnabled: () => true, isAllowed: () => true, minZoom: 15 },
    markersClusterGroup: {},
    drawnShapesGroup: {},
    shapeNameVisibilityLayer: {},
    externalMarkerFilterIds: null,
    externalShapeFilterIdSet: null,
  });
  runInContext(printHandlers, context);
  return {
    context,
    controller,
    parent,
    handlers,
    ready,
    request() {
      handlers.message!({
        source: parent,
        origin: "https://example.test",
        data: { type: "printStateRequest", requestId: "print-request" },
      });
    },
  };
}

describe("editor basemap print state", () => {
  it("returns the committed background synchronously while idle", () => {
    const s = setup();
    s.request();
    expect(s.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "printStateResult",
        state: expect.objectContaining({ tileServerId: "1" }),
      }),
      "https://example.test",
    );
    expect(s.controller.whenReady).not.toHaveBeenCalled();
  });

  it("waits for the latest committed background before replying", async () => {
    const s = setup(true);
    s.request();
    expect(s.parent.postMessage).not.toHaveBeenCalled();
    s.controller.selectedId = "2";
    s.controller.pending = false;
    s.ready();
    await Promise.resolve();
    expect(s.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ tileServerId: "2" }) }),
      "https://example.test",
    );
  });

  it("does not publish stale object state if data changes during the background wait", async () => {
    const s = setup(true);
    s.request();
    s.context.editorDataReady = false;
    s.controller.pending = false;
    s.ready();
    await Promise.resolve();
    expect(s.parent.postMessage).toHaveBeenCalledWith(
      { type: "printStateResult", requestId: "print-request", error: "map-data-loading" },
      "https://example.test",
    );
  });

  it("waits for background completion before opening Ctrl+P print preview", async () => {
    const s = setup(true);
    const preventDefault = vi.fn();
    s.handlers.keydown!({ ctrlKey: true, key: "p", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(s.parent.postMessage).not.toHaveBeenCalled();
    s.controller.pending = false;
    s.ready();
    await Promise.resolve();
    expect(s.parent.postMessage).toHaveBeenCalledWith(
      { type: "printOpen" },
      "https://example.test",
    );
  });
});
