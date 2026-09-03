import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHAPE_MEMO_MAX_LENGTH,
  createShapeMemoRuntime,
  getShapeMemoFromGeoJson,
  normalizeShapeMemo,
  normalizeShapeName,
} from "../src/map/common/shape-memo";

describe("map common shape memo", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("normalizes shape metadata and reads a GeoJSON memo", () => {
    expect(SHAPE_MEMO_MAX_LENGTH).toBe(10_000);
    expect(normalizeShapeName("  避難経路  ")).toBe("避難経路");
    expect(normalizeShapeName(null)).toBe("");
    expect(normalizeShapeMemo(123)).toBe("");
    expect(getShapeMemoFromGeoJson({ properties: { memo: "note" } })).toBe(
      "note",
    );
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
      runtime.openShapeMemoPopup(
        { on: vi.fn(), shapeName: "避難所", shapeMemo: "memo" },
        latLng,
      ),
    ).toBe(true);
    expect(popup.setLatLng).toHaveBeenCalledWith(latLng);
    expect(popup.openOn).toHaveBeenCalledWith(dependencies.map);
    expect(dependencies.setupDetailsLazyImages).toHaveBeenCalledWith(
      popup.element,
    );
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

function createRuntime() {
  const element = document.createElement("div");
  const popup = {
    element,
    getElement: vi.fn(() => element),
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
    escapeHtml: (value) =>
      value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
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
    schedule: (callback) => callback(),
    setupDetailsLazyImages: dependencies.setupDetailsLazyImages,
  });

  return { dependencies, popup, runtime };
}
