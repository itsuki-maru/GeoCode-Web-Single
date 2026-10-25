import { afterEach, beforeEach, expect, it, vi } from "vitest";
const preview = vi.hoisted(() => vi.fn());
vi.mock("../src/map/print/print-preview", () => ({ createPrintPreview: preview }));
beforeEach(() => {
  vi.resetModules();
  preview.mockClear();
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  delete window.__GEOCODE_MAP_BOOTSTRAP__;
  vi.restoreAllMocks();
});
it("passes validated coloring to the dedicated print preview", async () => {
  const session = { parentOrigin: location.origin, requestId: "colored-session" };
  (window as any).__ANSWER_PRINT_SESSION__ = session;
  vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  await import("../src/entries/form-answer-map-print");
  const snapshot = {
    state: {
      view: { latitude: 35, longitude: 139, zoom: 12 },
      tileServerId: "1",
      overlays: {},
      markersVisible: true,
      shapesVisible: false,
      shapeNamesVisible: false,
      layerIds: ["a"],
    },
    bootstrap: {
      page: "form-answer-map",
      isCluster: false,
      tileServers: {},
      tileOverlays: [],
      layers: { a: {} },
      markers: {
        m: {
          id: "m",
          layer_id: "a",
          latitude: 35,
          longitude: 139,
          detail: "",
          marker_name: "対象",
        },
      },
      shapes: [],
      answerPreview: { query: {}, targets: ["marker:m"] },
    },
    coloring: {
      version: 1,
      rules: [{ id: "r", label: "分類", color: "#ff0000" }],
      targets: { "marker:m": "r" },
    },
  };
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window.parent,
      origin: location.origin,
      data: { type: "printInitialize", requestId: session.requestId, snapshot },
    }),
  );
  expect(preview).toHaveBeenCalledWith(
    snapshot.state,
    expect.any(Function),
    "form-answer-map",
    session,
    snapshot.coloring,
  );
});
it("dedicated print entry binds its session, validates the snapshot and cleans up on pagehide", async () => {
  const session = { parentOrigin: location.origin, requestId: "session" };
  (window as any).__ANSWER_PRINT_SESSION__ = session;
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  await import("../src/entries/form-answer-map-print");
  expect(post).toHaveBeenLastCalledWith(
    { type: "printReady", requestId: "session" },
    location.origin,
  );
  const send = (extra: any, origin = location.origin, source = window.parent) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        origin,
        data: { type: "printInitialize", requestId: "session", ...extra },
      }),
    );
  send({ snapshot: {} }, "https://invalid.example");
  send({ requestId: "old", snapshot: {} });
  send({ snapshot: {} }, location.origin, window);
  expect(preview).not.toHaveBeenCalled();
  send({ snapshot: {} });
  expect(post).toHaveBeenLastCalledWith(
    { type: "printError", requestId: "session" },
    location.origin,
  );
  const snapshot = {
    state: {
      view: { latitude: 35, longitude: 139, zoom: 12 },
      tileServerId: "1",
      overlays: {},
      markersVisible: true,
      shapesVisible: false,
      shapeNamesVisible: false,
      layerIds: ["a"],
    },
    bootstrap: {
      page: "form-answer-map",
      isCluster: false,
      tileServers: {},
      tileOverlays: [],
      layers: { a: {} },
      markers: {
        m: {
          id: "m",
          layer_id: "a",
          latitude: 35,
          longitude: 139,
          detail: "",
          marker_name: "test",
        },
      },
      shapes: [],
      answerPreview: { query: {}, targets: ["marker:m"] },
    },
  };
  send({ snapshot });
  expect(preview).toHaveBeenCalledWith(
    snapshot.state,
    expect.any(Function),
    "form-answer-map",
    session,
  );
  expect(post).toHaveBeenLastCalledWith(
    { type: "printInitialized", requestId: "session" },
    location.origin,
  );
  expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBe(snapshot.bootstrap);
  preview.mock.calls[0][1]();
  expect(post).toHaveBeenLastCalledWith(
    { type: "printClose", requestId: "session" },
    location.origin,
  );
  send({ snapshot });
  expect(preview).toHaveBeenCalledOnce();
});
