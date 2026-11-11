import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leafletのブラウザー実装には型定義が同梱されていない。
import L from "leaflet";
import type { TileServerRecord } from "../src/map/common/basemap-definition";

const { factory } = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../src/map/common/basemap-layer", () => ({ createBasemapLayer: factory }));
import {
  createBasemapController,
  getBasemapController,
} from "../src/map/common/basemap-controller";

const prelude = readFileSync("vite.config.ts", "utf8");
const selectionHandlers = prelude.slice(
  prelude.indexOf("function syncEditorBasemapSelection"),
  prelude.indexOf("const {\n  getDefaultShapeStyle"),
);
const tileServers: Record<string, TileServerRecord> = {
  "1": {
    id: 1,
    url: "/tile/{z}/{x}/{y}.png",
    attribution: "",
    label: "ラスタ",
    layer_name: "raster",
    include_foreign_tiles: false,
    min_zoom: null,
    max_zoom: null,
  },
  "2": {
    id: 2,
    kind: "vector",
    style_url: "/style.json",
    url: "/fallback.png",
    attribution: "",
    label: "ベクタ",
    layer_name: "vector",
    include_foreign_tiles: false,
    min_zoom: null,
    max_zoom: null,
  },
};
let map: any;
let resolveVector!: () => void;

beforeEach(() => {
  document.body.innerHTML = '<div id="map"></div>';
  map = L.map("map").setView([35, 139], 10);
  const ready = new Promise<void>((resolve) => {
    resolveVector = resolve;
  });
  factory.mockReset().mockImplementation((_leaflet, _map, record: TileServerRecord) => ({
    layer: L.layerGroup(),
    ready: record.kind === "vector" ? ready : undefined,
    setVisible: vi.fn(),
    dispose: vi.fn(),
  }));
});
afterEach(() => {
  map.remove();
  document.body.replaceChildren();
});

describe("editable basemap radio cancellation", () => {
  it.each(["map-editor-base.ts", "map-editor-mobile-base.ts"])(
    "%s respects A → pending B → A clicks without starting B twice",
    async (filename) => {
      const source = readFileSync(`src/map/editor/${filename}`, "utf8");
      const controls = source.slice(
        source.indexOf("// タイルレイヤーの制御"),
        source.indexOf("// 確定した背景だけ"),
      );
      const context = createContext({
        L,
        map,
        document,
        tileServers,
        initialTileServerId: "1",
        getBasemapController,
        escapeHtml: (value: string) => value,
        registerHideableMapControl: vi.fn(),
      });
      runInContext(selectionHandlers + "\n" + controls, context);
      const controller = createBasemapController({
        leaflet: L,
        map,
        tileServers,
        bounds: L.latLngBounds([20, 122], [46, 154]),
        onCommit: (id) => context.syncEditorBasemapSelection(id),
      });
      const initialLayer = controller.getLayer();
      factory.mockClear();
      document.querySelector<HTMLInputElement>('.tile-radio[value="2"]')!.click();
      expect(controller.isPending()).toBe(true);
      expect(factory).toHaveBeenCalledOnce();
      expect(document.querySelector<HTMLInputElement>(".tile-radio:checked")!.value).toBe("1");
      const waiting = controller.whenReady();
      document.querySelector<HTMLInputElement>('.tile-radio[value="1"]')!.click();
      expect(controller.isPending()).toBe(false);
      resolveVector();
      await waiting;
      expect(controller.getLayer()).toBe(initialLayer);
      expect(controller.getSelectedId()).toBe("1");
      expect(document.querySelector<HTMLInputElement>(".tile-radio:checked")!.value).toBe("1");
      expect(factory).toHaveBeenCalledOnce();
    },
  );
});
