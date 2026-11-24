import { afterEach, expect, it, vi } from "vitest";
import { createRoutePanel } from "../src/map/common/route-panel";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "帰属表示を避けて専用ハンドルで経路パネルを移動できる (print: %s)",
  (print) => {
    const sizeChanges: (() => void)[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          sizeChanges.push(callback);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const map = document.createElement("div");
    const attribution = document.createElement("div");
    attribution.className = "leaflet-control-attribution";
    let attributionHeight = 28;
    Object.defineProperty(attribution, "offsetHeight", { get: () => attributionHeight });
    map.append(attribution);
    document.body.append(map);

    const onPositionChange = vi.fn();
    const panel = createRoutePanel({ mapElement: map, print, onPositionChange });
    panel.show();
    panel.show();
    const overlay = map.querySelector<HTMLElement>(".route-search-overlay")!;
    const handle = panel.element.querySelector<HTMLElement>(".route-search-handle")!;
    expect(map.querySelectorAll(".route-search-panel")).toHaveLength(1);
    expect(overlay.classList.contains("route-search-overlay-print")).toBe(print);
    expect(overlay.style.getPropertyValue("--route-attribution-height")).toBe("28px");

    attributionHeight = 42;
    sizeChanges[0]!();
    expect(overlay.style.getPropertyValue("--route-attribution-height")).toBe("42px");

    const onMapClick = vi.fn();
    const onButtonClick = vi.fn();
    const button = document.createElement("button");
    button.addEventListener("click", onButtonClick);
    panel.actions.append(button);
    map.addEventListener("click", onMapClick);
    button.click();
    expect(onButtonClick).toHaveBeenCalledOnce();
    expect(onMapClick).not.toHaveBeenCalled();

    Object.defineProperties(overlay, {
      clientWidth: { value: 400 },
      clientHeight: { value: 350 },
      offsetWidth: { value: 400 },
      offsetHeight: { value: 350 },
    });
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 350 }) as DOMRect;
    const element = panel.element;
    Object.defineProperties(element, { offsetWidth: { value: 100 }, offsetHeight: { value: 120 } });
    element.getBoundingClientRect = () => ({ left: 8, top: 222 }) as DOMRect;
    element.setPointerCapture = vi.fn();
    element.hasPointerCapture = () => true;
    element.releasePointerCapture = vi.fn();
    const dispatch = (target: HTMLElement, type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
      target.dispatchEvent(event);
    };
    dispatch(button, "pointerdown", 10, 250);
    expect(element.setPointerCapture).not.toHaveBeenCalled();
    dispatch(handle, "pointerdown", 10, 225);
    dispatch(element, "pointermove", 380, 370);
    expect(element.style.left).toBe("300px");
    expect(element.style.top).toBe("230px");
    expect(onPositionChange).toHaveBeenCalled();

    panel.hide();
    expect(element.isConnected).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(2);
    panel.show();
    expect(element.style.left).toBe(print ? "300px" : "");
    expect(element.style.top).toBe(print ? "230px" : "");
    panel.dispose();
  },
);
