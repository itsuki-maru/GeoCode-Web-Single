import { describe, expect, it, vi } from "vitest";

import { createMapUiVisibilityRuntime } from "../src/map/common/map-ui-visibility";

function createLeafletMock() {
  const disableClickPropagation = vi.fn();
  const disableScrollPropagation = vi.fn();
  const stop = vi.fn();
  const leaflet = {
    Control: {
      extend: vi.fn(
        (definition: { options: unknown; onAdd(): HTMLElement }) =>
          class {
            options = definition.options;
            onAdd = definition.onAdd;
          },
      ),
    },
    DomEvent: {
      disableClickPropagation,
      disableScrollPropagation,
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

  return { disableClickPropagation, disableScrollPropagation, leaflet, stop };
}

describe("map UI visibility runtime", () => {
  it("toggles every registered control and updates the accessible button state", () => {
    const mock = createLeafletMock();
    const runtime = createMapUiVisibilityRuntime({
      initialHidden: false,
      leaflet: mock.leaflet as never,
    });
    const firstContainer = document.createElement("div");
    const firstControl = { getContainer: () => firstContainer };

    expect(runtime.registerHideableMapControl(firstControl)).toBe(firstControl);
    expect(firstContainer.classList.contains("temporary-map-hideable-ui")).toBe(
      true,
    );
    expect(firstContainer.classList.contains("is-hidden")).toBe(false);

    const toggleControl = new runtime.MapUiVisibilityToggleControl() as {
      onAdd(): HTMLElement;
    };
    const toggleContainer = toggleControl.onAdd();
    const button = toggleContainer.querySelector("button");
    expect(button?.textContent).toBe("地図だけを表示");
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(mock.disableClickPropagation).toHaveBeenCalledWith(toggleContainer);
    expect(mock.disableScrollPropagation).toHaveBeenCalledWith(toggleContainer);

    button?.click();
    expect(firstContainer.classList.contains("is-hidden")).toBe(true);
    expect(button?.textContent).toBe("機能を表示");
    expect(button?.getAttribute("aria-label")).toBe("機能を表示");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(mock.stop).toHaveBeenCalledOnce();

    const laterContainer = document.createElement("div");
    runtime.registerHideableMapControl({ getContainer: () => laterContainer });
    expect(laterContainer.classList.contains("is-hidden")).toBe(true);

    button?.click();
    expect(firstContainer.classList.contains("is-hidden")).toBe(false);
    expect(laterContainer.classList.contains("is-hidden")).toBe(false);
  });

  it("ignores controls without a rendered container", () => {
    const mock = createLeafletMock();
    const runtime = createMapUiVisibilityRuntime({
      initialHidden: true,
      leaflet: mock.leaflet as never,
    });
    const control = { getContainer: () => null };

    expect(runtime.registerHideableMapControl(control)).toBe(control);
  });
});
