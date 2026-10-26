import { describe, expect, it, vi } from "vitest";
import { finishAnswerPreview } from "../src/map/answer-preview";

describe("lazy answer preview", () => {
  it("未生成図形の範囲と件数を通知し、引き継いだ表示位置を維持する", () => {
    const bounds = { extend: vi.fn(), isValid: () => true };
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    const runtime = {
      markers: {},
      shapeLayers: {},
      hasInheritedMapView: true,
      getRenderableShapeIds: () => ["offscreen-circle", "tiny-line"],
      getShapeGeometryInfo: (id: string) => ({
        bounds:
          id === "offscreen-circle"
            ? { south: 34, west: 138, north: 36, east: 140 }
            : { south: 35, west: 139, north: 35.00001, east: 139.00001 },
      }),
      map: { invalidateSize: vi.fn(), fitBounds: vi.fn() },
    };
    const bootstrap = {
      answerPreview: {
        answerCount: 3,
        targetCount: 3,
        parentOrigin: location.origin,
        requestId: "r",
        query: {},
        targets: ["shape:offscreen-circle", "shape:tiny-line", "shape:invalid"],
      },
    };
    finishAnswerPreview(runtime, bootstrap as any, { latLngBounds: () => bounds });
    expect(bounds.extend).toHaveBeenCalledWith([34, 138]);
    expect(bounds.extend).toHaveBeenCalledWith([36, 140]);
    expect(runtime.map.fitBounds).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer-map-ready", displayed: 2, skipped: 1 }),
      location.origin,
    );
    post.mockRestore();
  });
});
