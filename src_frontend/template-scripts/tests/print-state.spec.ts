import { describe, expect, it } from "vitest";
import { isPrintMapState, type PrintMapState } from "../src/map/common/print-state";

const state: PrintMapState = {
  view: { latitude: 35.68, longitude: 139.76, zoom: 15 },
  tileServerId: "1",
  overlays: {},
  markersVisible: true,
  shapesVisible: true,
  shapeNamesVisible: false,
  layerIds: null,
};

describe("print clustering state validation", () => {
  it.each(["markerIds", "shapeIds"])("validates optional %s filters", (key) => {
    for (const value of [undefined, null, [], ["a", "b"]])
      expect(isPrintMapState({ ...state, [key]: value })).toBe(true);
    for (const value of ["a", 0, {}, [1], [null]])
      expect(isPrintMapState({ ...state, [key]: value })).toBe(false);
  });

  it("continues accepting print requests without the new settings", () => {
    expect(isPrintMapState(state)).toBe(true);
  });

  it("accepts a manual release and a fixed-off setting", () => {
    expect(isPrintMapState({ ...state, clusteringEnabled: false, clusteringAllowed: true })).toBe(
      true,
    );
    expect(isPrintMapState({ ...state, clusteringEnabled: false, clusteringAllowed: false })).toBe(
      true,
    );
  });

  it.each(["clusteringEnabled", "clusteringAllowed"])(
    "rejects non-boolean %s in messages from another frame",
    (key) => {
      for (const value of [null, "false", 0, [], {}]) {
        expect(isPrintMapState({ ...state, [key]: value })).toBe(false);
      }
    },
  );
});
