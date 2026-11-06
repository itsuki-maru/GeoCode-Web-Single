import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createColorLegend } from "../src/map/common/color-legend";

const classification = { id: "a", label: "分類A", color: "#ff0000" };
let legend: ReturnType<typeof createColorLegend> | undefined;
let resizeObservers: (() => void)[];
const disconnect = vi.fn();

beforeEach(() => {
  resizeObservers = [];
  disconnect.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeObservers.push(callback);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  legend?.dispose();
  legend = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture(mode: "map" | "print" = "map", scale = 1) {
  const map = document.createElement("div");
  document.body.append(map);
  let width = 640;
  let height = 480;
  Object.defineProperties(map, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
    offsetWidth: { get: () => width },
    offsetHeight: { get: () => height },
  });
  map.getBoundingClientRect = () => ({ width: width * scale, height: height * scale }) as DOMRect;
  const bottomControls = document.createElement("div");
  bottomControls.className = "leaflet-bottom";
  Object.defineProperty(bottomControls, "offsetHeight", { value: 56 });
  map.append(bottomControls);
  const changed = vi.fn();
  const instance = createColorLegend({ mapElement: map, mode, onChange: changed });
  legend = instance;
  const panel = map.querySelector<HTMLElement>(".map-color-legend")!;
  const grip = panel.querySelector<HTMLButtonElement>(".map-color-legend-resize")!;
  Object.defineProperties(panel, {
    offsetWidth: { get: () => Math.min(parseFloat(panel.style.width) || 240, width - 20) },
    offsetHeight: { get: () => Math.min(parseFloat(panel.style.height) || 90, height - 20) },
  });
  grip.setPointerCapture = vi.fn();
  grip.hasPointerCapture = () => true;
  grip.releasePointerCapture = vi.fn();
  const changeMapSize = (nextWidth: number, nextHeight: number) => {
    width = nextWidth;
    height = nextHeight;
    resizeObservers.forEach((notify) => notify());
  };
  const pointer = (type: string, x: number, y: number, pointerType: string, pointerId = 1) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId, pointerType, clientX: x, clientY: y });
    grip.dispatchEvent(event);
    return event;
  };
  return { instance, map, panel, grip, changed, changeMapSize, pointer };
}

describe("共通の色分け凡例", () => {
  it("凡例の位置と既存行を保持し、分類名をテキストとして更新する", () => {
    const f = fixture();
    expect(f.panel.hidden).toBe(true);
    const label = '<img src="x" onerror="alert(1)">';
    const second = { id: "b", label: "分類B", color: "#0000ff" };
    f.instance.setEntries([{ ...classification, label }, second]);
    const firstRow = f.panel.querySelector("li");
    expect(f.panel.hidden).toBe(false);
    expect(f.panel.style.left).toBe("390px");
    expect(f.panel.style.top).toBe("326px");
    expect(firstRow?.textContent).toBe(label);
    expect(f.panel.querySelector("img")).toBeNull();
    f.panel.style.left = "20px";
    f.panel.style.width = "220px";
    f.instance.setEntries([second, { ...classification, label: "変更した分類" }]);
    expect(f.panel.querySelectorAll("li")[1]).toBe(firstRow);
    expect(firstRow?.textContent).toBe("変更した分類");
    expect(f.panel.style.left).toBe("20px");
    expect(f.panel.style.width).toBe("220px");
    f.instance.setEntries([]);
    expect(f.panel.hidden).toBe(true);
    f.instance.setEntries([classification]);
    expect(f.map.querySelector(".map-color-legend-live")).toBe(f.panel);
    expect(f.panel.style.width).toBe("220px");
  });

  it.each([
    ["マウス", "mouse", "map", 1],
    ["タッチ", "touch", "map", 1],
    ["縮小された印刷", "mouse", "print", 0.5],
  ] as const)("%sで右下からサイズを変え、背面の地図を動かさない", (_, pointerType, mode, scale) => {
    const f = fixture(mode, scale);
    f.instance.setEntries([classification]);
    const mapDown = vi.fn();
    const mapWheel = vi.fn();
    f.map.addEventListener("pointerdown", mapDown);
    f.map.addEventListener("wheel", mapWheel);
    f.changed.mockClear();
    expect(f.pointer("pointerdown", 100, 100, pointerType).defaultPrevented).toBe(true);
    expect(f.grip.setPointerCapture).toHaveBeenCalledWith(1);
    expect(mapDown).not.toHaveBeenCalled();
    f.pointer("pointermove", 110, 120, pointerType, 2);
    expect(f.changed).not.toHaveBeenCalled();
    f.pointer("pointermove", 100 + 80 * scale, 100 + 60 * scale, pointerType);
    expect(f.panel.style.width).toBe("320px");
    expect(f.panel.style.height).toBe("150px");
    expect(f.changed).toHaveBeenCalledOnce();
    f.pointer("pointermove", 100 + 80 * scale, 100 + 60 * scale, pointerType);
    expect(f.changed).toHaveBeenCalledOnce();
    f.pointer("pointercancel", 180, 160, pointerType);
    expect(f.grip.releasePointerCapture).toHaveBeenCalledWith(1);
    f.pointer("pointermove", 400, 400, pointerType);
    expect(f.panel.style.width).toBe("320px");
    f.changeMapSize(300, 200);
    expect(parseFloat(f.panel.style.left) + f.panel.offsetWidth).toBeLessThanOrEqual(300);
    expect(parseFloat(f.panel.style.top) + f.panel.offsetHeight).toBeLessThanOrEqual(200);
    const wheel = new Event("wheel", { bubbles: true, cancelable: true });
    f.panel.querySelector("ul")!.dispatchEvent(wheel);
    expect(mapWheel).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("一覧のはみ出しを検出し、非表示や破棄の際は操作を終了する", () => {
    const f = fixture("print");
    f.instance.setEntries([classification]);
    expect(f.grip.hasAttribute("data-html2canvas-ignore")).toBe(true);
    const list = f.panel.querySelector("ul")!;
    Object.defineProperties(list, { clientHeight: { value: 80 }, scrollHeight: { value: 160 } });
    expect(f.instance.hasOverflow()).toBe(true);
    f.pointer("pointerdown", 100, 100, "touch");
    f.instance.setVisible(false);
    expect(f.grip.releasePointerCapture).toHaveBeenCalledOnce();
    expect(f.instance.hasOverflow()).toBe(false);
    f.instance.setVisible(true);
    f.pointer("pointerdown", 100, 100, "touch");
    f.instance.dispose();
    expect(f.grip.releasePointerCapture).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(f.map.querySelector(".answer-print-legend")).toBeNull();
    f.changed.mockClear();
    f.pointer("pointermove", 180, 160, "touch");
    resizeObservers.forEach((notify) => notify());
    expect(f.changed).not.toHaveBeenCalled();
  });
});
