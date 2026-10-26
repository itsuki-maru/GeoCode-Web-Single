import { beforeEach, describe, expect, it, vi } from "vitest";
import * as content from "../src/map/common/content";

import {
  SHAPE_MEMO_MAX_LENGTH,
  createShapeMemoRuntime,
  getShapeMemoFromGeoJson,
  normalizeShapeMemo,
  normalizeShapeName,
} from "../src/map/common/shape-memo";

describe("map common shape memo", () => {
  it("routes selection taps before memo popups and ignores synthetic label clicks", () => {
    const onShapeClick = vi.fn(() => true);
    const { runtime, dependencies, popup } = createRuntime(onShapeClick);
    const handlers = new Map<string, (event: object) => void>();
    const layer = {
      on: (name: string, callback: (event: object) => void) => {
        handlers.set(name, callback);
      },
      getTooltip: () => ({ getElement: () => document.createElement("div") }),
      shapeMemo: "memo",
    };
    runtime.attachShapeMemoPopup(layer);
    handlers.get("click")?.({});
    runtime.attachShapeMemoTooltipOpen(layer, { lat: 1, lng: 2 });
    dependencies.domListeners.get("touchend")?.({ type: "touchend" });
    dependencies.domListeners.get("click")?.({ type: "click" });
    expect(onShapeClick).toHaveBeenCalledTimes(2);
    expect(popup.openOn).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("normalizes shape metadata and reads a GeoJSON memo", () => {
    expect(SHAPE_MEMO_MAX_LENGTH).toBe(10_000);
    expect(normalizeShapeName("  避難経路  ")).toBe("避難経路");
    expect(normalizeShapeName(null)).toBe("");
    expect(normalizeShapeMemo(123)).toBe("");
    expect(getShapeMemoFromGeoJson({ properties: { memo: "note" } })).toBe("note");
    expect(getShapeMemoFromGeoJson(null)).toBe("");
  });

  it("renders escaped titles and sanitized Markdown content", () => {
    const { runtime, dependencies } = createRuntime();

    expect(runtime.renderShapeMemoPopupContent("<避難所>", "**案内**")).toBe(
      '<div class="md-detail-contents"><h1>&lt;避難所&gt;</h1><iframe>safe</iframe></div>',
    );
    expect(dependencies.renderMarkdown).toHaveBeenCalledWith("**案内**");
    expect(dependencies.sanitizeHtml).toHaveBeenCalledWith("<b>案内</b>");
    expect(runtime.renderShapeMemoPopupContent("name", "  ")).toBe("");
  });

  it("opens a popup and initializes lazy images", () => {
    const { runtime, dependencies, popup } = createRuntime();
    const latLng = { lat: 35, lng: 139 };

    expect(
      runtime.openShapeMemoPopup({ on: vi.fn(), shapeName: "避難所", shapeMemo: "memo" }, latLng),
    ).toBe(true);
    expect(popup.setLatLng).toHaveBeenCalledWith(latLng);
    expect(popup.openOn).toHaveBeenCalledWith(dependencies.map);
    expect(dependencies.setupDetailsLazyImages).toHaveBeenCalledWith(popup.element);
  });

  it("does not initialize a popup closed before its scheduled setup", () => {
    const pending: Array<() => void> = [];
    const { runtime, dependencies, popup } = createRuntime(undefined, (callback) =>
      pending.push(callback),
    );

    runtime.openShapeMemoPopup({ on: vi.fn(), shapeMemo: "memo" }, { lat: 35, lng: 139 });
    expect(dependencies.setupDetailsLazyImages).not.toHaveBeenCalled();
    popup.isOpen.mockReturnValue(false);
    pending[0]!();

    expect(dependencies.setupDetailsLazyImages).not.toHaveBeenCalled();
  });

  it("does not initialize the document when its scheduled popup DOM is unavailable", () => {
    const pending: Array<() => void> = [];
    const { runtime, dependencies, popup } = createRuntime(undefined, (callback) =>
      pending.push(callback),
    );

    runtime.openShapeMemoPopup({ on: vi.fn(), shapeMemo: "memo" }, { lat: 35, lng: 139 });
    expect(dependencies.setupDetailsLazyImages).not.toHaveBeenCalled();
    popup.getElement.mockReturnValue(null);
    pending[0]!();

    expect(dependencies.setupDetailsLazyImages).not.toHaveBeenCalled();
  });

  it("reuses prepared memo HTML on repeated taps and invalidates it when the memo changes", () => {
    const { runtime, dependencies, popup } = createRuntime();
    const layer = { on: vi.fn(), shapeName: "避難所", shapeMemo: "memo" };
    const latLng = { lat: 35, lng: 139 };
    runtime.openShapeMemoPopup(layer, latLng);
    runtime.openShapeMemoPopup(layer, latLng);
    expect(dependencies.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(popup.openOn).toHaveBeenCalledTimes(2);

    layer.shapeMemo = "updated memo";
    runtime.openShapeMemoPopup(layer, latLng);
    expect(dependencies.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(dependencies.renderMarkdown).toHaveBeenLastCalledWith("updated memo");
    layer.shapeName = "変更後";
    runtime.openShapeMemoPopup(layer, latLng);
    expect(popup.setContent).toHaveBeenLastCalledWith(expect.stringContaining("変更後"));
  });

  it("tracks manually opened popups and releases cached HTML when a layer is evicted", () => {
    const { runtime, dependencies, popup } = createRuntime();
    const layer = { on: vi.fn(), shapeName: "管路", shapeMemo: "memo" };
    const release = vi.spyOn(content, "releaseDeferredDetails");
    const remove = vi.fn(() => popup.isOpen.mockReturnValue(false));
    Object.assign(popup, { remove });
    expect(runtime.isShapePopupOpen(layer)).toBe(false);
    runtime.openShapeMemoPopup(layer, { lat: 35, lng: 139 });
    expect(runtime.isShapePopupOpen(layer)).toBe(true);
    runtime.releaseLayer(layer);
    expect(remove).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.stringContaining("md-detail-contents"));
    popup.isOpen.mockReturnValue(true);
    expect(runtime.isShapePopupOpen(layer)).toBe(false);
    runtime.openShapeMemoPopup(layer, { lat: 35, lng: 139 });
    expect(runtime.isShapePopupOpen(layer)).toBe(true);
    expect(dependencies.renderMarkdown).toHaveBeenCalledTimes(2);
  });

  it("unpins a closed popup and skips scheduled work after layer release", () => {
    const pending: Array<() => void> = [];
    const { runtime, dependencies, popup } = createRuntime(undefined, (callback) =>
      pending.push(callback),
    );
    const removals: Array<() => void> = [];
    Object.assign(popup, {
      once: (event: string, callback: () => void) => {
        if (event === "remove") removals.push(callback);
      },
    });
    const layer = { on: vi.fn(), shapeMemo: "memo" };
    runtime.openShapeMemoPopup(layer, { lat: 35, lng: 139 });
    expect(runtime.isShapePopupOpen(layer)).toBe(true);
    removals[0]!();
    expect(runtime.isShapePopupOpen(layer)).toBe(false);
    runtime.releaseLayer(layer);
    pending.forEach((callback) => callback());
    expect(dependencies.setupDetailsLazyImages).not.toHaveBeenCalled();
  });

  it("binds a shape click only once", () => {
    const { runtime, popup } = createRuntime();
    const listeners = new Map<string, (event?: { latlng?: unknown }) => void>();
    const layer = {
      on: vi.fn((eventName, listener) => listeners.set(eventName, listener)),
      shapeMemo: "memo",
      shapeName: "route",
    };

    runtime.attachShapeMemoPopup(layer);
    runtime.attachShapeMemoPopup(layer);
    expect(layer.on).toHaveBeenCalledTimes(1);

    const latLng = { lat: 1, lng: 2 };
    listeners.get("click")?.({ latlng: latLng });
    expect(popup.setLatLng).toHaveBeenCalledWith(latLng);
  });

  it("suppresses the click generated immediately after a label touch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    try {
      const { runtime, dependencies, popup } = createRuntime();
      const tooltipElement = document.createElement("button");
      const layer = {
        getTooltip: () => ({ getElement: () => tooltipElement }),
        on: vi.fn(),
        shapeMemo: "memo",
      };
      const latLng = { lat: 1, lng: 2 };

      runtime.attachShapeMemoTooltipOpen(layer, latLng);
      runtime.attachShapeMemoTooltipOpen(layer, latLng);
      const touchListener = dependencies.domListeners.get("touchend");
      const clickListener = dependencies.domListeners.get("click");
      touchListener?.({ type: "touchend" });
      clickListener?.({ type: "click" });

      expect(popup.openOn).toHaveBeenCalledTimes(1);
      expect(dependencies.stopEvent).toHaveBeenCalledTimes(2);
      expect(tooltipElement.dataset.shapeMemoOpenBound).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRuntime(
  onShapeClick?: Parameters<typeof createShapeMemoRuntime>[0]["onShapeClick"],
  schedule: (callback: () => void) => void = (callback) => callback(),
) {
  const element = document.createElement("div");
  const popup = {
    element,
    getElement: vi.fn<() => HTMLElement | null>(() => element),
    isOpen: vi.fn(() => true),
    openOn: vi.fn(function (this: typeof popup) {
      return this;
    }),
    setContent: vi.fn(function (this: typeof popup) {
      return this;
    }),
    setLatLng: vi.fn(function (this: typeof popup) {
      return this;
    }),
  };
  const domListeners = new Map<string, (event: unknown) => void>();
  const stopEvent = vi.fn();
  const map = {};
  const dependencies = {
    domListeners,
    map,
    renderMarkdown: vi.fn(() => "<b>案内</b>"),
    sanitizeHtml: vi.fn(() => "safe"),
    setupDetailsLazyImages: vi.fn(),
    stopEvent,
  };
  const runtime = createShapeMemoRuntime({
    onShapeClick,
    escapeHtml: (value) => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    getLeaflet: () => ({
      DomEvent: {
        on: (_target, eventName, listener) => {
          domListeners.set(eventName, listener);
        },
        stop: stopEvent,
      },
      popup: () => popup,
    }),
    getMap: () => map,
    renderIframe: (html) => `<iframe>${html}</iframe>`,
    renderMarkdown: dependencies.renderMarkdown,
    sanitizeHtml: dependencies.sanitizeHtml,
    schedule,
    setupDetailsLazyImages: dependencies.setupDetailsLazyImages,
  });

  return { dependencies, popup, runtime };
}
