import { describe, expect, it, vi } from "vitest";

import {
  createMeasurementVisibilityControl,
  createTooltipVisibilityControl,
} from "../src/map/common/visibility-controls";

function createLeafletMock() {
  const disableClickPropagation = vi.fn();
  const stop = vi.fn();
  const leaflet = {
    Control: {
      extend: vi.fn(
        (definition: {
          options: { position: string };
          onAdd(): HTMLElement;
        }) =>
          class {
            options = definition.options;
            onAdd = definition.onAdd;
          },
      ),
    },
    DomEvent: {
      disableClickPropagation,
      on: (element: HTMLElement, eventName: string, handler: EventListener) =>
        element.addEventListener(eventName, handler),
      stop,
    },
    DomUtil: {
      create: (
        tagName: string,
        className: string,
        container?: HTMLElement,
      ) => {
        const element = document.createElement(tagName);
        element.className = className;
        container?.append(element);
        return element;
      },
    },
  };

  return { disableClickPropagation, leaflet, stop };
}

describe("read-only visibility controls", () => {
  it("creates the tooltip toggle at the requested position", () => {
    const mock = createLeafletMock();
    const onToggle = vi.fn();
    const control = createTooltipVisibilityControl({
      leaflet: mock.leaflet as never,
      onToggle,
      position: "topleft",
    }) as ReturnType<typeof createTooltipVisibilityControl> & {
      options: { position: string };
    };

    const container = control.onAdd();
    const button = container.querySelector("button");
    expect(control.options.position).toBe("topleft");
    expect(button?.textContent).toBe("マーカー名表示");
    expect(mock.disableClickPropagation).toHaveBeenCalledWith(container);

    button?.click();
    expect(mock.stop).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("creates measurement and segment-merge actions and initializes their state", () => {
    const mock = createLeafletMock();
    const onToggle = vi.fn();
    const onMergeToggle = vi.fn();
    const onUpdateState = vi.fn();
    const control = createMeasurementVisibilityControl({
      leaflet: mock.leaflet as never,
      onMergeToggle,
      onToggle,
      onUpdateState,
      position: "topright",
    }) as ReturnType<typeof createMeasurementVisibilityControl> & {
      options: { position: string };
    };

    const container = control.onAdd();
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(control.options.position).toBe("topright");
    expect(container.classList.contains("measurement-control")).toBe(true);
    expect(buttons[0]?.textContent).toBe("図形の計測");
    expect(buttons[1]?.textContent).toBe("辺を結合");
    expect(buttons[1]?.id).toBe("measurement-merge-toggle-btn");
    expect(buttons[1]?.classList.contains("is-hidden")).toBe(true);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(onUpdateState).toHaveBeenCalledOnce();

    buttons[0]?.click();
    buttons[1]?.click();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onMergeToggle).toHaveBeenCalledOnce();
    expect(mock.stop).toHaveBeenCalledTimes(2);
  });
});
