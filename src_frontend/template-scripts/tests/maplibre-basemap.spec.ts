import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error LeafletのEventedには型定義が同梱されていない。
import L from "leaflet";
import type { TileServerRecord } from "../src/map/common/basemap-definition";

const dependencies = vi.hoisted(() => ({ bridge: vi.fn(), worker: vi.fn() }));
vi.mock("../src/map/common/maplibre-bridge.mjs", () => ({ maplibreGL: dependencies.bridge }));
vi.mock("maplibre-gl", () => ({ setWorkerUrl: dependencies.worker }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
  default: "/assets/test-worker.mjs",
}));

const record: TileServerRecord = {
  id: 2,
  kind: "vector",
  style_url: "/assets/background/style.json",
  url: "/tile/{z}/{x}/{y}.png",
  attribution: "Base attribution",
  label: "背景",
  layer_name: "background",
  include_foreign_tiles: false,
  min_zoom: null,
  max_zoom: null,
};

let createMaplibreBasemap: typeof import("../src/map/common/maplibre-basemap").createMaplibreBasemap;
let layer: any;
let gl: any;
let canvas: HTMLCanvasElement;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn<() => void>>;
let onAttribution: ReturnType<typeof vi.fn<(attribution: string) => void>>;
let onFatal: ReturnType<typeof vi.fn<() => void>>;
let remove: ReturnType<typeof vi.fn<(map: unknown) => void>>;
let handle: ReturnType<typeof createMaplibreBasemap> | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dependencies.worker.mockClear();
  canvas = document.createElement("canvas");
  container = document.createElement("div");
  container.append(canvas);
  document.body.append(container);
  gl = Object.assign(new L.Evented(), {
    getCanvas: () => canvas,
    loaded: vi.fn(() => true),
    areTilesLoaded: vi.fn(() => true),
    getStyle: () => ({ sources: { roads: {}, labels: {} } }),
    getSource: (id: string) => ({
      attribution: id === "roads" ? "Provider <script>unsafe()</script>" : "Base attribution",
    }),
    triggerRepaint: vi.fn(),
  });
  vi.spyOn(gl, "off");
  remove = vi.fn<(map: unknown) => void>();
  layer = Object.assign(new L.Evented(), {
    onRemove: remove,
    getMaplibreMap: () => gl,
    getContainer: () => container,
  });
  dependencies.bridge.mockReset().mockReturnValue(layer);
  onChange = vi.fn<() => void>();
  onAttribution = vi.fn<(attribution: string) => void>();
  onFatal = vi.fn<() => void>();
  ({ createMaplibreBasemap } = await import("../src/map/common/maplibre-basemap"));
});

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("MapLibre background lifecycle", () => {
  it("uses the bundled worker and resolves only after a completed frame with safe source attribution", async () => {
    handle = createMaplibreBasemap(record, onChange, onAttribution, onFatal);
    expect(dependencies.worker).toHaveBeenCalledWith("/assets/test-worker.mjs");
    expect(dependencies.bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        style: record.style_url,
        interactive: false,
        attributionControl: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
      }),
    );
    const ready = vi.fn();
    void handle.ready.then(ready);
    expect(handle.status()).toEqual({ loading: true, failed: false });
    layer.fire("add");
    expect(container.style.pointerEvents).toBe("none");
    expect(canvas.hasAttribute("data-geocode-maplibre-canvas")).toBe(true);
    gl.fire("dataloading");
    expect(onChange).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    gl.fire("idle");
    await handle.ready;
    expect(ready).toHaveBeenCalledOnce();
    expect(handle.status()).toEqual({ loading: false, failed: false });
    expect(onAttribution).toHaveBeenLastCalledWith("Base attribution · Provider ");
    gl.areTilesLoaded.mockReturnValue(false);
    expect(handle.status()).toEqual({ loading: true, failed: false });
    handle.retry();
    expect(gl.triggerRepaint).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("fails an initial frame at 30 seconds without exposing provider error details", async () => {
    handle = createMaplibreBasemap(record, onChange, onAttribution, onFatal);
    layer.fire("add");
    await vi.advanceTimersByTimeAsync(29999);
    expect(onFatal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.ready).rejects.toThrow("背景地図を読み込めませんでした");
    expect(handle.status()).toEqual({ loading: false, failed: true });
    expect(onFatal).toHaveBeenCalledOnce();
    gl.fire("error", { error: Error("https://provider.test/?token=secret") });
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onChange.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it.each(["provider", "context"])(
    "reports an active %s failure and removes listeners on disposal",
    async (failure) => {
      handle = createMaplibreBasemap(record, onChange, onAttribution, onFatal);
      layer.fire("add");
      gl.fire("idle");
      await handle.ready;
      if (failure === "provider") gl.fire("error", { error: Error("provider failed") });
      else canvas.dispatchEvent(new Event("webglcontextlost"));
      expect(handle.status()).toEqual({ loading: false, failed: true });
      expect(onFatal).toHaveBeenCalledOnce();
      handle.dispose();
      handle.dispose();
      expect(gl.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(gl.off).toHaveBeenCalledWith("dataloading", expect.any(Function));
      expect(gl.off).toHaveBeenCalledWith("idle", expect.any(Function));
      const changes = onChange.mock.calls.length;
      gl.fire("dataloading");
      canvas.dispatchEvent(new Event("webglcontextlost"));
      expect(onChange).toHaveBeenCalledTimes(changes);
      expect(onFatal).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels pending readiness when removed, including after a failed GL constructor", async () => {
    handle = createMaplibreBasemap(record, onChange, onAttribution, onFatal);
    layer.fire("add");
    layer.fire("remove");
    await expect(handle.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(gl.listens("idle")).toBe(false);
    gl = undefined;
    expect(() => layer.onRemove({})).not.toThrow();
    expect(container.isConnected).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});
