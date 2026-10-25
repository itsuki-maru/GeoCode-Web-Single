import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnswerPrintLegend } from "../src/map/print/answer-print-legend";
import type { AnswerColoring } from "../src/map/answer-coloring";

let legend: ReturnType<typeof createAnswerPrintLegend> | undefined;
const disconnect = vi.fn();
let observers: (() => void)[];
beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
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

function fixture(coloring?: AnswerColoring) {
  const mapElement = document.createElement("div");
  const settings = document.createElement("aside");
  Object.defineProperties(mapElement, {
    clientWidth: { value: 900 },
    clientHeight: { value: 640 },
    offsetWidth: { value: 900 },
    offsetHeight: { value: 640 },
  });
  document.body.append(mapElement, settings);
  const hidden = vi.fn();
  const changed = vi.fn();
  legend = createAnswerPrintLegend({
    coloring: coloring || {
      version: 1,
      rules: [{ id: "r", label: '<img src="x" onerror="alert(1)">', color: "#ff0000" }],
      targets: { "marker:a": "r", "shape:a": "r" },
    },
    bootstrap: {
      markers: { a: { id: "a", marker_name: '<img src="x" onerror="alert(1)">' } },
      shapes: [{ id: "a", name: "区域" }],
    } as any,
    mapElement,
    settings,
    setHiddenTargets: hidden,
    onChange: changed,
  });
  const panel = mapElement.querySelector<HTMLElement>(".answer-print-legend")!;
  const inputs = [...settings.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const change = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  changed.mockClear();
  return { mapElement, settings, panel, inputs, change, hidden, changed };
}

describe("answer print legend", () => {
  it("groups marker and shape targets into one safe classification entry and toggles the whole group", () => {
    const f = fixture();
    expect(f.inputs.map((input) => input.checked)).toEqual([true, false, true]);
    expect(f.panel.querySelectorAll("li")).toHaveLength(1);
    expect(f.panel.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(f.panel.querySelector("img")).toBeNull();
    f.change(f.inputs[2], false);
    expect(f.panel.querySelectorAll("li")[0].hidden).toBe(true);
    expect(f.hidden).not.toHaveBeenCalled();
    f.change(f.inputs[1], true);
    expect(f.hidden).toHaveBeenLastCalledWith(["marker:a", "shape:a"]);
    f.change(f.inputs[0], false);
    expect(f.panel.hidden).toBe(true);
    expect(f.hidden).toHaveBeenLastCalledWith(["marker:a", "shape:a"]);
    f.change(f.inputs[1], false);
    expect(f.hidden).toHaveBeenLastCalledWith([]);
    expect(f.changed).toHaveBeenCalledTimes(4);
  });

  it("keeps classifications separate by ID even when labels match, excluding empty or outside groups", () => {
    const f = fixture({
      version: 1,
      rules: [
        { id: "r", label: "耐用年数50年以上", color: "#ff0000" },
        { id: "s", label: "耐用年数50年以上", color: "#0000ff" },
        { id: "empty", label: "対象なし", color: "#555555" },
      ],
      targets: { "marker:a": "r", "shape:a": "s", "marker:outside": "empty" },
    });
    expect(f.panel.querySelectorAll("li")).toHaveLength(2);
    expect(f.inputs).toHaveLength(4);
    f.change(f.inputs[1], true);
    f.change(f.inputs[2], false);
    expect(f.hidden).toHaveBeenLastCalledWith(["marker:a"]);
    expect(f.panel.querySelectorAll("li")[1].hidden).toBe(false);
    f.change(f.inputs[3], false);
    expect(f.hidden).toHaveBeenLastCalledWith(["marker:a", "shape:a"]);
  });

  it("changes font size and output without rebuilding the map, and preserves the selected size", () => {
    const f = fixture();
    const font = f.settings.querySelector<HTMLSelectElement>('[aria-label="凡例の文字サイズ"]')!;
    expect(font.value).toBe("12");
    expect([...font.options].map((option) => option.value)).toEqual(
      Array.from({ length: 25 }, (_, i) => String(i + 8)),
    );
    font.value = "18";
    font.dispatchEvent(new Event("change", { bubbles: true }));
    expect(f.panel.style.fontSize).toBe("18px");
    expect(f.hidden).not.toHaveBeenCalled();
    expect(f.changed).toHaveBeenCalledOnce();
    f.change(f.inputs[0], false);
    f.change(f.inputs[0], true);
    expect(f.panel.style.fontSize).toBe("18px");
  });

  it("invalidates output only for actual size changes, not repeated observer callbacks", () => {
    const f = fixture();
    observers.forEach((notify) => notify());
    expect(f.changed).not.toHaveBeenCalled();
    let width = 200;
    let height = 100;
    Object.defineProperties(f.panel, {
      offsetWidth: { get: () => width },
      offsetHeight: { get: () => height },
    });
    observers.forEach((notify) => notify());
    expect(f.changed).toHaveBeenCalledOnce();
    observers.forEach((notify) => notify());
    expect(f.changed).toHaveBeenCalledOnce();
    width = 320;
    height = 150;
    observers.forEach((notify) => notify());
    expect(f.changed).toHaveBeenCalledTimes(2);
    legend!.dispose();
    width = 350;
    observers.forEach((notify) => notify());
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it("detects overflow without dropping entries, and permits hiding the legend to resolve it", () => {
    const f = fixture();
    Object.defineProperties(f.panel, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 200 },
      clientWidth: { value: 200 },
      scrollWidth: { value: 200 },
    });
    expect(legend!.hasOverflow()).toBe(true);
    expect(f.settings.querySelector<HTMLElement>(".answer-print-legend-warning")!.hidden).toBe(
      false,
    );
    expect(f.panel.querySelectorAll("li")).toHaveLength(1);
    f.change(f.inputs[0], false);
    expect(legend!.hasOverflow()).toBe(false);
    expect(f.settings.querySelector<HTMLElement>(".answer-print-legend-warning")!.hidden).toBe(
      true,
    );
  });

  it("invalidates output on floating movement, stays inside the map and cleans up listeners", () => {
    const f = fixture();
    Object.defineProperties(f.panel, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
    f.mapElement.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 450, height: 320 }) as DOMRect;
    f.panel.getBoundingClientRect = () => ({ left: 5, top: 5 }) as DOMRect;
    f.panel.setPointerCapture = vi.fn();
    f.panel.hasPointerCapture = () => true;
    f.panel.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number, target: Element = f.panel) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
      target.dispatchEvent(event);
      return event;
    };
    // The panel body and native bottom-right resize handle retain their default behavior.
    expect(pointer("pointerdown", 10, 10).defaultPrevented).toBe(false);
    expect(f.panel.setPointerCapture).not.toHaveBeenCalled();
    pointer("pointerdown", 10, 10, f.panel.querySelector("strong")!);
    pointer("pointermove", 1000, 1000);
    expect(f.panel.style.left).toBe("700px");
    expect(f.panel.style.top).toBe("540px");
    expect(f.changed).toHaveBeenCalled();
    pointer("pointerup", 1000, 1000);
    legend!.dispose();
    f.hidden.mockClear();
    f.change(f.inputs[1], true);
    expect(f.hidden).not.toHaveBeenCalled();
    expect(f.mapElement.querySelector(".answer-print-legend")).toBeNull();
  });
});
