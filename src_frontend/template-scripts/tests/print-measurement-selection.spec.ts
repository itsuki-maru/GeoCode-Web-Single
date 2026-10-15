import { describe, expect, it, vi } from "vitest";
import { createMeasurementSelection } from "../src/map/common/measurement-selection";

vi.mock("../src/map/read-only-page", () => ({ initializeReadOnlyMapPage: vi.fn() }));
vi.mock("../src/map/print/pdf-controls", () => ({ createPdfControls: vi.fn() }));
import { movePrintMapControls } from "../src/map/print/print-preview";

describe("measurement selection in print preview", () => {
  it("keeps live totals inside the printed map while moving operation buttons to settings", () => {
    const map = document.createElement("div");
    const settings = document.createElement("aside");
    map.innerHTML = `<div class="leaflet-control measurement-control"><button>図形の計測</button><button>辺を結合</button><button>複数選択</button></div>
      <div class="leaflet-control measurement-selection-summary"></div>
      <div class="leaflet-control leaflet-control-attribution">出典</div>`;
    const summary = map.querySelector<HTMLElement>(".measurement-selection-summary")!;
    const selection = createMeasurementSelection({
      getEnabled: () => true,
      isVisible: () => true,
      measure: () => ({ area: 10, distance: 5 }),
      formatArea: (n) => `${n} m²`,
      formatDistance: (n) => `${n} m`,
      refresh: vi.fn(),
      closePopup: vi.fn(),
      stopEvent: vi.fn(),
    });
    selection.bindSummary(summary);
    movePrintMapControls(map, settings);
    expect(settings.querySelectorAll("button")).toHaveLength(3);
    expect(map.contains(summary)).toBe(true);
    expect(map.querySelector(".leaflet-control-attribution")?.textContent).toBe("出典");
    selection.toggle();
    expect(summary.classList.contains("has-selection")).toBe(false);
    const a = { shapeType: "circle" };
    selection.select(a, {});
    selection.select({ shapeType: "circle" }, {});
    expect(summary.textContent).toContain("面積 20 m²");
    expect(summary.textContent).not.toContain("半径");
    expect(summary.classList.contains("has-selection")).toBe(true);
    expect(summary.textContent).not.toMatch(/タップ|クリック|解除/);
    selection.select(a, {});
    expect(summary.textContent).toContain("面積 10 m²");
    selection.clear();
    expect(summary.hidden).toBe(true);
  });
});
