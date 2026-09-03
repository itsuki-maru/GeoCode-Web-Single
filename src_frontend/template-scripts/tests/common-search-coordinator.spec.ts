import { describe, expect, it, vi } from "vitest";

import { createMapObjectSearchCoordinator } from "../src/map/common/search";

describe("map object search coordinator", () => {
  it("keeps marker and shape search state synchronized", () => {
    const markerDisplay = {
      clearSearch: vi.fn(),
      setSearchQuery: vi.fn(),
    };
    const shapeDisplay = {
      clearSearch: vi.fn(),
      setSearchQuery: vi.fn(),
    };
    const syncShapeVisibility = vi.fn();
    const coordinator = createMapObjectSearchCoordinator({
      markerDisplay,
      shapeDisplay,
      syncShapeVisibility,
    });

    coordinator.setMapObjectSearchQuery("station");
    expect(markerDisplay.setSearchQuery).toHaveBeenCalledWith("station");
    expect(shapeDisplay.setSearchQuery).toHaveBeenCalledWith("station");
    expect(syncShapeVisibility).toHaveBeenCalledOnce();

    coordinator.clearMapObjectSearch({ clearInput: false });
    expect(markerDisplay.clearSearch).toHaveBeenCalledWith({
      clearInput: false,
    });
    expect(shapeDisplay.clearSearch).toHaveBeenCalledWith();
    expect(syncShapeVisibility).toHaveBeenCalledTimes(2);
  });
});
