import { describe, expect, it, vi } from "vitest";
import { createMeasurementSelection } from "../src/map/common/measurement-selection";

function setup() {
  let enabled = true;
  const hidden = new Set<object>();
  const summary = document.createElement("div");
  const button = document.createElement("button");
  const refresh = vi.fn();
  const runtime = createMeasurementSelection({
    getEnabled: () => enabled,
    isVisible: (layer) => !hidden.has(layer),
    measure: () => ({ area: 10, distance: 20 }),
    formatArea: (n) => `${n} m²`,
    formatDistance: (n) => `${n} m`,
    refresh,
    closePopup: vi.fn(),
    stopEvent: vi.fn(),
  });
  runtime.bindButton(button);
  runtime.bindSummary(summary);
  return {
    runtime,
    summary,
    button,
    hidden,
    refresh,
    disable: () => {
      enabled = false;
      runtime.clear();
    },
  };
}
function shape(shapeType: string) {
  const element = document.createElement("div");
  return { shapeType, getElement: () => element };
}

describe("shared measurement selection for read-only maps", () => {
  it.each(["polyline", "polygon", "rectangle", "circle"])(
    "aggregates %s and excludes other types",
    (type) => {
      const { runtime, summary } = setup();
      const a = shape(type);
      const b = shape(type);
      expect(runtime.includes(a)).toBe(false);
      runtime.select(a, {});
      runtime.select(b, {});
      expect(summary.hidden).toBe(true);
      runtime.toggle();
      expect(summary.textContent).toContain("2件の合計");
      expect(summary.textContent).toContain(type === "polyline" ? "総延長 40 m" : "面積 20 m²");
      if (type === "circle") {
        expect(summary.textContent).not.toMatch(/半径|周長/);
      } else if (type !== "polyline") expect(summary.textContent).toContain("周長 40 m");
      expect(a.getElement().classList.contains("is-measurement-selected")).toBe(false);
      const other = shape(type === "circle" ? "polygon" : "circle");
      runtime.select(other, {});
      expect(runtime.includes(other)).toBe(true);
      expect(summary.textContent).toContain("2件の合計");
      expect(summary.textContent).not.toContain("同じタイプ");
      runtime.select(a, {});
      expect(summary.textContent).toContain("1件の合計");
      runtime.select(b, {});
      expect(summary.textContent).toContain(type === "circle" ? "ポリゴン 1件" : "円 1件");
    },
  );

  it("keeps summary mode after the last removal and hides only totals on toggle", () => {
    const { runtime, button, summary } = setup();
    const a = shape("polygon");
    runtime.toggle();
    runtime.select(a, {});
    runtime.select(a, {});
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(summary.textContent).toContain("選択してください");
    const b = shape("rectangle");
    runtime.select(b, {});
    expect(runtime.includes(b)).toBe(true);
    runtime.toggle();
    expect(b.getElement().classList.contains("is-measurement-selected")).toBe(false);
    expect(summary.hidden).toBe(true);
    expect(runtime.includes(a)).toBe(false);
    expect(runtime.includes(b)).toBe(true);
    runtime.toggle();
    expect(summary.textContent).toContain("四角形 1件");
  });

  it("prunes hidden shapes and disables selection when measurement closes", () => {
    const { runtime, hidden, summary, button, disable } = setup();
    const a = shape("polyline");
    const b = shape("polyline");
    runtime.toggle();
    runtime.select(a, {});
    runtime.select(b, {});
    hidden.add(a);
    runtime.prune();
    expect(summary.textContent).toContain("1件の合計");
    expect(a.getElement().classList.contains("is-measurement-selected")).toBe(false);
    disable();
    expect(summary.hidden).toBe(true);
    expect(button.classList.contains("is-hidden")).toBe(true);
    expect(runtime.select(a, {})).toBe(false);
    expect(runtime.includes(b)).toBe(false);
  });

  it("switches aggregate type after hiding the first measured shape without losing other types", () => {
    const { runtime, hidden, summary } = setup();
    const a = shape("polyline"),
      b = shape("circle"),
      c = shape("polyline");
    runtime.select(a, {});
    runtime.select(b, {});
    runtime.select(c, {});
    runtime.toggle();
    expect(summary.textContent).toContain("線 2件");
    hidden.add(a);
    runtime.prune();
    expect(summary.textContent).toContain("円 1件");
    expect(runtime.includes(c)).toBe(true);
    // 解除した図形を再選択した場合は、選択順の末尾に追加する。
    runtime.select(a, {});
    expect(summary.textContent).toContain("円 1件");
  });

  it("handles taps once and rejects non-measurable shapes", () => {
    const { runtime } = setup();
    const a = shape("circle");
    runtime.select(a, { originalEvent: new Event("touchend") });
    runtime.select(a, { originalEvent: new Event("click") });
    expect(runtime.includes(a)).toBe(true);
    runtime.select(a, new Event("touchend"));
    runtime.select(a, new Event("click"));
    expect(runtime.includes(a)).toBe(false);
    expect(runtime.select(shape("marker"), {})).toBe(false);
  });
});
