import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSummaryDraggable } from "../src/map/common/draggable-summary";

afterEach(() => vi.unstubAllGlobals());

describe("draggable measurement summary", () => {
  it.each([1, 0.5, 0.25])(
    "floats within the map at preview scale %s and stops on cancellation",
    (scale) => {
      let resized = () => {};
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            resized = callback;
          }
          observe() {}
          disconnect = disconnect;
        },
      );
      const map = document.createElement("div");
      const corner = document.createElement("div");
      const panel = document.createElement("div");
      map.append(corner);
      corner.append(panel);
      let width = 500;
      Object.defineProperties(map, {
        clientWidth: { get: () => width },
        clientHeight: { value: 400 },
        offsetWidth: { get: () => width },
        offsetHeight: { value: 400 },
      });
      Object.defineProperties(panel, { offsetWidth: { value: 120 }, offsetHeight: { value: 80 } });
      map.getBoundingClientRect = () =>
        ({ left: 100, top: 50, width: width * scale, height: 400 * scale }) as DOMRect;
      panel.getBoundingClientRect = () =>
        ({ left: 100 + 10 * scale, top: 50 + 250 * scale }) as DOMRect;
      panel.setPointerCapture = vi.fn();
      panel.hasPointerCapture = () => true;
      panel.releasePointerCapture = vi.fn();
      const dispatch = (type: string, x: number, y: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, {
          pointerId: 1,
          button: 0,
          clientX: 100 + (x - 100) * scale,
          clientY: 50 + (y - 50) * scale,
        });
        panel.dispatchEvent(event);
      };
      const onPositionChange = vi.fn();
      const cleanup = makeSummaryDraggable(panel, map, onPositionChange);
      expect(panel.parentElement).toBe(corner);
      dispatch("pointerdown", 120, 310);
      expect(panel.parentElement).toBe(map);
      expect(panel.style.left).toBe("10px");
      expect(panel.style.top).toBe("250px");
      dispatch("pointermove", 310, 180);
      expect(panel.style.left).toBe("200px");
      expect(panel.style.top).toBe("120px");
      expect(onPositionChange).toHaveBeenCalledTimes(2);
      dispatch("pointermove", 1000, 1000);
      expect(panel.style.left).toBe("380px");
      expect(panel.style.top).toBe("320px");
      dispatch("pointercancel", 1000, 1000);
      dispatch("pointermove", 120, 80);
      expect(panel.style.left).toBe("380px");
      width = 300;
      resized();
      expect(panel.style.left).toBe("180px");
      cleanup();
      expect(disconnect).toHaveBeenCalledOnce();
      dispatch("pointerdown", 120, 310);
      expect(panel.setPointerCapture).toHaveBeenCalledOnce();
    },
  );
});
