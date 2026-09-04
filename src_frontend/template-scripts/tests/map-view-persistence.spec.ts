import { describe, expect, it, vi } from "vitest";

import {
  LAST_MAP_VIEW_STORAGE_KEY,
  loadLastMapView,
  observeMapView,
  saveLastMapView,
} from "../src/map/common/map-view-persistence";

describe("map view persistence", () => {
  it("loads a valid saved view", () => {
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({ latitude: 35.6812, longitude: 139.7671, zoom: 14 }),
      ),
      setItem: vi.fn(),
    };

    expect(loadLastMapView(storage)).toEqual({
      latitude: 35.6812,
      longitude: 139.7671,
      zoom: 14,
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ latitude: 91, longitude: 139, zoom: 10 }),
    JSON.stringify({ latitude: 35, longitude: 181, zoom: 10 }),
    JSON.stringify({ latitude: 35, longitude: 139, zoom: 31 }),
    JSON.stringify({ latitude: "35", longitude: 139, zoom: 10 }),
  ])("ignores an invalid saved view", (serialized) => {
    const storage = { getItem: vi.fn(() => serialized), setItem: vi.fn() };

    expect(loadLastMapView(storage)).toBeNull();
  });

  it("saves the center and zoom after map movement finishes", () => {
    let moveEnd: (() => void) | undefined;
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    const map = {
      getCenter: () => ({ lat: 34.6937, lng: 135.5023 }),
      getZoom: () => 12,
      on: (_eventName: "moveend", listener: () => void) => {
        moveEnd = listener;
      },
    };

    observeMapView(map, storage);
    moveEnd?.();

    expect(storage.setItem).toHaveBeenCalledWith(
      LAST_MAP_VIEW_STORAGE_KEY,
      JSON.stringify({ latitude: 34.6937, longitude: 135.5023, zoom: 12 }),
    );
  });

  it("does not throw when storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("unavailable");
      }),
      setItem: vi.fn(() => {
        throw new Error("unavailable");
      }),
    };

    expect(loadLastMapView(storage)).toBeNull();
    expect(() =>
      saveLastMapView({ latitude: 35, longitude: 139, zoom: 10 }, storage),
    ).not.toThrow();
  });
});
