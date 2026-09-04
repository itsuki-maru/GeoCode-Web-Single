import { beforeEach, describe, expect, it } from "vitest";

import { readMapBootstrap } from "../src/map/bootstrap";

const records = {
  layers: {},
  markers: {},
  tileServers: {},
};

describe("readMapBootstrap", () => {
  beforeEach(() => {
    delete window.__GEOCODE_MAP_BOOTSTRAP__;
  });

  it.each(["map", "map-mobile"] as const)("reads %s bootstrap data", (page) => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 35, longitude: 139, zoom: 8 },
      isMaster: true,
      markerId: "0",
      page,
      selectedLayer: "None",
      shapes: [],
    };

    expect(readMapBootstrap().page).toBe(page);
  });

  it("reads another-window bootstrap data", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 37.65, longitude: 138, zoom: 6 },
      isCluster: true,
      page: "map-anather",
      shapes: [],
    };

    expect(readMapBootstrap()).toMatchObject({ page: "map-anather", isCluster: true });
  });

  it.each(["temporary-map", "temporary-map-mobile"] as const)(
    "reads %s bootstrap data",
    (page) => {
      window.__GEOCODE_MAP_BOOTSTRAP__ = {
        ...records,
        initialView: { latitude: 35, longitude: 139, zoom: 8 },
        isChecked: true,
        isMapUiHidden: false,
        isMaster: false,
        page,
        shapes: {},
      };

      expect(readMapBootstrap().page).toBe(page);
    },
  );

  it("rejects page-specific data with the wrong shape", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 37.65, longitude: 138, zoom: 6 },
      isCluster: "yes",
      page: "map-anather",
      shapes: [],
    };

    expect(() => readMapBootstrap()).toThrow("Another-map bootstrap data is invalid");
  });

  it("rejects another-window bootstrap data without an initial view", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      isCluster: true,
      page: "map-anather",
      shapes: [],
    };

    expect(() => readMapBootstrap()).toThrow("Another-map bootstrap data is invalid");
  });
});
