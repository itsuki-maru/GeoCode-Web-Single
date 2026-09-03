import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLayerBulkToggleControl,
  extractYouTubeId,
  type LayerMap,
} from "../src/map/common/base";

describe("map common base", () => {
  it.each([
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://example.com/watch?v=dQw4w9WgXcQ", null],
    ["not a URL", null],
  ])("extracts a supported YouTube ID from %s", (url, expected) => {
    expect(extractYouTubeId(url)).toBe(expected);
  });

  describe("layer bulk toggle", () => {
    beforeEach(() => {
      Object.assign(window, {
        L: {
          Control: {
            extend: (definition: { onAdd(): HTMLElement }) =>
              class {
                onAdd = definition.onAdd;
              },
          },
          DomUtil: {
            create: (tagName: string, className: string, parent?: HTMLElement) => {
              const element = document.createElement(tagName);
              element.className = className;
              parent?.append(element);
              return element;
            },
          },
          DomEvent: {
            on: (
              element: HTMLElement,
              eventName: string,
              listener: (event: Event) => void,
            ) => element.addEventListener(eventName, listener),
            stop: vi.fn(),
            disableClickPropagation: vi.fn(),
            disableScrollPropagation: vi.fn(),
          },
        },
      });
    });

    it("selects and clears all overlay layers", () => {
      const firstLayer = {};
      const secondLayer = {};
      const visibleLayers = new Set<object>();
      let overlayListener: ((event: { layer: object }) => void) | undefined;
      const map: LayerMap = {
        addLayer: (layer) => void visibleLayers.add(layer),
        hasLayer: (layer) => visibleLayers.has(layer),
        on: (_events, listener) => {
          overlayListener = listener;
        },
        removeLayer: (layer) => void visibleLayers.delete(layer),
      };

      const control = createLayerBulkToggleControl({
        map,
        overlayLayers: [firstLayer, null, secondLayer],
      }) as { onAdd(): HTMLElement };
      const container = control.onAdd();
      const button = container.querySelector<HTMLButtonElement>("button")!;

      expect(button.textContent).toBe("全選択");
      button.click();
      expect(visibleLayers).toEqual(new Set([firstLayer, secondLayer]));
      expect(button.textContent).toBe("全解除");

      button.click();
      expect(visibleLayers.size).toBe(0);
      expect(button.textContent).toBe("全選択");

      visibleLayers.add(firstLayer);
      overlayListener?.({ layer: firstLayer });
      expect(button.textContent).toBe("全解除");
    });
  });
});
