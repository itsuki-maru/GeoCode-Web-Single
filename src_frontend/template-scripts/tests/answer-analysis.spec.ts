import { describe, it, expect, vi } from "vitest";
import { installAnswerAnalysis, type AnswerAnalysis } from "../src/map/answer-analysis";

const setup = () => {
  const marker = {
    setIcon: vi.fn(),
    bindPopup: vi.fn(),
    getPopup: () => ({ getContent: () => "<p>元の本文</p>" }),
  };
  const shape = {
    setStyle: vi.fn(),
    shapeMemo: "元のメモ",
    shapeStyle: { weight: 4, color: "#123456" },
  };
  const visible = new Set<any>();
  const cluster = {
    hasLayer: (layer: any) => {
      if (!layer) throw Error("missing");
      return visible.has(layer);
    },
    options: {} as any,
    refreshClusters: vi.fn(),
  };
  visible.add(cluster);
  visible.add(marker);
  visible.add(shape);
  const handlers: Record<string, () => void> = {};
  const runtime = {
    markers: { "marker-same": marker },
    shapeLayers: { "shape-same": shape },
    visibleMarkerGroup: cluster,
    map: {
      hasLayer: (layer: any) => visible.has(layer),
      on: (e: string, fn: () => void) => {
        handlers[e] = fn;
      },
      off: vi.fn(),
    },
  };
  const leaflet = { divIcon: vi.fn((v: unknown) => v) };
  const data: AnswerAnalysis = {
    active: true,
    forms: [],
    forms_overflow: false,
    fields: [],
    field_label: "<script>項目",
    legend: [
      { label: "分類A", color: "#0072b2", count: 2 },
      { label: "未入力", color: "#888888", count: 1 },
    ],
    targets: {
      "marker:same": {
        bucket: 0,
        value: "<img onerror=alert(1)>",
        answered_at: "2026-10-01T00:00:00Z",
      },
      "shape:same": { bucket: 0, value: "0", answered_at: "2026-10-01T00:00:00Z" },
      "marker:invalid-position": { bucket: 1, value: null, answered_at: null },
    },
  };
  return { runtime, leaflet, data, marker, shape, cluster, visible, handlers };
};
describe("回答値の地図表示", () => {
  it("未生成の図形を論理表示の件数へ含め、生成時に分析スタイルを適用する", () => {
    const s = setup();
    let created: ((layer: any, record: { id: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    Object.assign(s.runtime, {
      isShapeLogicallyVisible: (id: string) => id === "same",
      onShapeLayerCreated: (listener: typeof created) => {
        created = listener;
        return unsubscribe;
      },
    });
    delete (s.runtime.shapeLayers as Record<string, unknown>)["shape-same"];
    const analysis = installAnswerAnalysis(s.runtime, s.data, s.leaflet, vi.fn());
    expect(analysis.visibleCounts()).toEqual([2, 0]);
    created?.(s.shape, { id: "same" });
    expect(s.shape.setStyle).toHaveBeenCalledWith(expect.objectContaining({ color: "#0072b2" }));
    s.handlers.unload();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps analysis separate from selectable bodies in owner popups", () => {
    const s = setup();
    (s.runtime as any).popupContent = { setAnalysis: vi.fn() };
    installAnswerAnalysis(s.runtime, s.data, s.leaflet, vi.fn());
    expect((s.runtime as any).popupContent.setAnalysis).toHaveBeenCalledWith(
      "shape:same",
      expect.stringContaining("使用した回答"),
    );
    expect(s.shape.shapeMemo).toBe("元のメモ");
    expect(s.marker.bindPopup).not.toHaveBeenCalled();
  });
  it("マーカーと同じIDの図形を別々に色分けし、安全な分析値と既存本文を残す", () => {
    const s = setup();
    const analysis = installAnswerAnalysis(s.runtime, s.data, s.leaflet, vi.fn());
    expect(s.marker.setIcon).toHaveBeenCalledOnce();
    const html = s.marker.bindPopup.mock.calls[0][0];
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("元の本文");
    expect(s.shape.setStyle).toHaveBeenCalledWith(
      expect.objectContaining({ color: "#0072b2", fillColor: "#0072b2", weight: 4 }),
    );
    expect(s.shape.shapeMemo).toContain("元のメモ");
    expect(s.shape.shapeMemo).toContain("0");
    expect(s.cluster.refreshClusters).toHaveBeenCalledOnce();
    expect(s.cluster.options.iconCreateFunction({ getChildCount: () => 3 }).html).toContain(
      "background:#555",
    );
    expect(analysis.visibleCounts()).toEqual([2, 0]); // 無効な図形は表示件数から除外する。
  });
  it("クラスタ内のマーカーを数え、表示切替を通知するが分類境界と全件数を変えない", () => {
    vi.useFakeTimers();
    const s = setup(),
      notify = vi.fn();
    installAnswerAnalysis(s.runtime, s.data, s.leaflet, notify);
    s.visible.delete(s.marker);
    s.handlers["layeradd layerremove overlayadd overlayremove moveend"]();
    vi.advanceTimersByTime(50);
    expect(notify).toHaveBeenLastCalledWith([1, 0]);
    expect(s.data.legend[0].count).toBe(2);
    s.handlers.unload();
    expect(s.runtime.map.off).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("色分けなしでは既存アイコン・形状・ポップアップを変更しない", () => {
    const s = setup();
    s.data.active = false;
    installAnswerAnalysis(s.runtime, s.data, s.leaflet, vi.fn());
    expect(s.marker.setIcon).not.toHaveBeenCalled();
    expect(s.shape.setStyle).not.toHaveBeenCalled();
    expect(s.shape.shapeMemo).toBe("元のメモ");
  });
});
