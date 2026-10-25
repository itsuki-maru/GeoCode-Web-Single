import { afterEach, describe, expect, it, vi } from "vitest";
import { installAnswerFilter } from "../src/map/answer-filter";

afterEach(() => vi.useRealTimers());

function setup() {
  const marker = { getLatLng: () => [35, 139] };
  const shape = { getLatLng: () => [36, 140] };
  const group = { hasLayer: vi.fn(() => true) };
  const handlers: Record<string, () => void> = {};
  const runtime = {
    markers: { "marker-id": marker },
    shapeLayers: { "shape-id": shape },
    visibleMarkerGroup: group,
    map: {
      hasLayer: vi.fn(() => true),
      fitBounds: vi.fn(),
      on: vi.fn((name, fn) => {
        handlers[name] = fn;
      }),
      off: vi.fn(),
    },
    setAnswerTargets: vi.fn(),
  };
  const bounds = { extend: vi.fn(), isValid: () => true };
  const post = vi.spyOn(window.parent, "postMessage");
  const preview = {
    requestId: "r",
    parentOrigin: location.origin,
    targets: ["marker:id", "shape:id", "marker:invalid"],
  } as any;
  const result = installAnswerFilter(runtime, preview, { latLngBounds: () => bounds });
  const send = (data: object, origin = location.origin, source = window.parent) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { requestId: "r", type: "answer-map-filter", updateId: "u", ...data },
      }),
    );
  return { runtime, post, send, result, handlers, bounds };
}

describe("dedicated answer map filter", () => {
  it("validates coloring against the new filter scope before updating either state", () => {
    const s = setup();
    const controller = { apply: vi.fn(), getState: () => null };
    (s.runtime as any).answerColoring = controller;
    const coloring = {
      version: 1,
      rules: [{ id: "a", label: "分類A", color: "#0072b2" }],
      targets: { "marker:id": "a" },
    };
    s.send({ targets: ["shape:id"], coloring });
    s.send({
      targets: ["marker:id"],
      coloring: { ...coloring, targets: { "marker:outside": "a" } },
    });
    expect(controller.apply).not.toHaveBeenCalled();
    expect(s.runtime.setAnswerTargets).not.toHaveBeenCalled();
    s.send({ targets: ["marker:id"], coloring }, "https://invalid.example");
    expect(controller.apply).not.toHaveBeenCalled();
    s.send({ targets: ["marker:id"], coloring });
    expect(controller.apply).toHaveBeenCalledWith(coloring);
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-filter-applied", visible: 1 }),
      location.origin,
    );
    s.send({ targets: ["marker:id"], coloring: null });
    expect(controller.apply).toHaveBeenLastCalledWith(null);
    s.handlers.unload();
  });

  it("rolls back coloring and targets together when applying the filter fails", () => {
    const s = setup();
    const previous = {
      version: 1,
      rules: [{ id: "a", label: "A", color: "#0072b2" }],
      targets: { "shape:id": "a" },
    };
    const controller = { apply: vi.fn(), getState: () => previous };
    (s.runtime as any).answerColoring = controller;
    s.runtime.setAnswerTargets.mockImplementationOnce(() => {
      throw Error("failure");
    });
    s.send({ targets: ["marker:id"], coloring: null });
    expect(controller.apply.mock.calls).toEqual([[null], [previous]]);
    expect(s.runtime.setAnswerTargets).toHaveBeenLastCalledWith([
      "marker:id",
      "shape:id",
      "marker:invalid",
    ]);
    expect(s.result.counts()).toEqual({ visible: 2, renderable: 2 });
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-filter-error" }),
      location.origin,
    );
    s.handlers.unload();
  });

  it("CSVは反映済み条件と実際のレイヤ表示に限定し、古い更新・未許可・0件を拒否する", () => {
    const s = setup();
    const request = { type: "answer-map-csv-request", csvRequestId: "csv", updateId: "" };
    s.send(request);
    expect(s.post.mock.calls.at(-1)![0].type).toBe("answer-map-csv-error");
    s.send({ type: "answer-map-print-enable", enabled: true });
    s.send(request);
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "answer-map-csv-targets",
        targets: ["marker:id", "shape:id"],
        updateId: "",
      }),
      location.origin,
    );
    s.runtime.visibleMarkerGroup.hasLayer.mockReturnValue(false);
    s.send(request);
    expect(s.post.mock.calls.at(-1)![0].targets).toEqual(["shape:id"]);
    s.send({ targets: ["marker:id"], updateId: "next" });
    s.send(request);
    expect(s.post.mock.calls.at(-1)![0].type).toBe("answer-map-csv-error");
    s.send({ ...request, updateId: "next" });
    expect(s.post.mock.calls.at(-1)![0].type).toBe("answer-map-csv-error");
    s.runtime.visibleMarkerGroup.hasLayer.mockReturnValue(true);
    s.send({ ...request, updateId: "next" });
    expect(s.post.mock.calls.at(-1)![0].targets).toEqual(["marker:id"]);
    expect(s.runtime.map.fitBounds).not.toHaveBeenCalled();
    s.handlers.unload();
  });
  it("validates message source and initial scope, updates cached objects without moving the map", () => {
    const s = setup();
    s.send({ targets: [] }, "https://invalid.example");
    s.send({ targets: [], requestId: "old" });
    expect(s.runtime.setAnswerTargets).not.toHaveBeenCalled();
    s.send({ targets: ["marker:outside"] });
    s.send({ targets: ["marker:id", "marker:id"] });
    expect(s.runtime.setAnswerTargets).not.toHaveBeenCalled();
    s.send({ targets: ["marker:id", "shape:id"] });
    expect(s.runtime.setAnswerTargets).toHaveBeenCalledWith(["marker:id", "shape:id"]);
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-filter-applied", visible: 2, renderable: 2 }),
      location.origin,
    );
    expect(s.runtime.map.fitBounds).not.toHaveBeenCalled();
    s.send({ targets: [] });
    expect(s.result.counts()).toEqual({ visible: 0, renderable: 0 });
    s.send({ targets: ["marker:id", "shape:id", "marker:invalid"] });
    expect(s.result.counts()).toEqual({ visible: 2, renderable: 2 });
    s.send({ type: "answer-map-fit" });
    expect(s.runtime.map.fitBounds).toHaveBeenCalledOnce();
    s.handlers.unload();
  });

  it("keeps previous selection on failure and releases listeners on unload", () => {
    vi.useFakeTimers();
    const s = setup();
    s.runtime.setAnswerTargets.mockImplementationOnce(() => {
      throw new Error("failure");
    });
    s.send({ targets: [] });
    expect(s.result.counts().renderable).toBe(2);
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-filter-error" }),
      location.origin,
    );
    s.handlers["layeradd layerremove overlayadd overlayremove answerfilterchange"]();
    vi.advanceTimersByTime(50);
    expect(s.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "answer-map-filter-visible", visible: 2 }),
      location.origin,
    );
    s.handlers.unload();
    s.runtime.setAnswerTargets.mockClear();
    s.send({ targets: [] });
    expect(s.runtime.setAnswerTargets).not.toHaveBeenCalled();
    expect(s.runtime.map.off).toHaveBeenCalledOnce();
  });
});
