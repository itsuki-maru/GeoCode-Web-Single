import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMaplibreCanvases,
  prepareMaplibreCanvasPrint,
  replaceMaplibreCanvasClones,
} from "../src/map/print/canvas-snapshot";

let root: HTMLElement;
const signal = () => new AbortController().signal;
const addCanvas = (marked = true) => {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.style.cssText =
    "position:absolute;left:0;top:0;width:400px;height:300px;transform:translate(3px, 4px)";
  if (marked) canvas.dataset.geocodeMaplibreCanvas = "";
  root.append(canvas);
  return canvas;
};

beforeEach(() => {
  root = document.createElement("section");
  document.body.append(root);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,CAPTURE",
  );
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("MapLibre canvas print snapshots", () => {
  it("captures only marked visible canvases and preserves CSS pixel size and order", () => {
    addCanvas(false);
    const hidden = addCanvas();
    hidden.style.display = "none";
    const canvas = addCanvas();
    canvas.className = "maplibregl-canvas";
    const snapshots = captureMaplibreCanvases(root, signal());
    expect(snapshots.map((snapshot) => snapshot.index)).toEqual([1]);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1);
    const clone = root.cloneNode(true) as HTMLElement;
    replaceMaplibreCanvasClones(clone, snapshots);
    expect(clone.querySelectorAll("canvas")).toHaveLength(2);
    const image = clone.querySelector("img")!;
    expect(image.style.width).toBe("400px");
    expect(image.style.height).toBe("300px");
    expect(image.style.transform).toBe("translate(3px, 4px)");
    expect(image.className).toBe("maplibregl-canvas");
    expect(root.querySelectorAll("img")).toHaveLength(0);
  });

  it.each(["empty", "invalid", "tainted"])("rejects an unusable background: %s", (failure) => {
    const canvas = addCanvas();
    if (failure === "empty") canvas.width = 0;
    if (failure === "invalid") vi.mocked(canvas.toDataURL).mockReturnValue("data:,");
    if (failure === "tainted")
      vi.mocked(canvas.toDataURL).mockImplementation(() => {
        throw new DOMException("tainted", "SecurityError");
      });
    expect(() => captureMaplibreCanvases(root, signal())).toThrow("背景地図");
  });

  it("restores the original canvas style and context node after browser printing", async () => {
    const canvas = addCanvas();
    canvas.style.setProperty("display", "block", "important");
    const originalStyle = canvas.style.cssText;
    const restore = await prepareMaplibreCanvasPrint(root, signal());
    expect(canvas.isConnected).toBe(true);
    expect(canvas.style.display).toBe("none");
    expect(root.querySelectorAll("img")).toHaveLength(1);
    restore();
    restore();
    expect(canvas.style.cssText).toBe(originalStyle);
    expect(root.querySelectorAll("img")).toHaveLength(0);
  });

  it("cleans every inserted image when decoding a later canvas fails", async () => {
    const first = addCanvas();
    const second = addCanvas();
    vi.mocked(HTMLImageElement.prototype.decode)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("decode failed"));
    await expect(prepareMaplibreCanvasPrint(root, signal())).rejects.toThrow("印刷画像");
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(first.style.display).toBe("");
    expect(second.style.display).toBe("");
  });

  it("aborts pending image decoding and immediately restores the canvas", async () => {
    const canvas = addCanvas();
    vi.mocked(HTMLImageElement.prototype.decode).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = prepareMaplibreCanvasPrint(root, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(canvas.style.display).toBe("");
  });

  it("restores the canvas when image decoding stalls", async () => {
    vi.useFakeTimers();
    const canvas = addCanvas();
    vi.mocked(HTMLImageElement.prototype.decode).mockReturnValue(new Promise(() => {}));
    const pending = expect(prepareMaplibreCanvasPrint(root, signal())).rejects.toThrow("印刷画像");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(canvas.style.display).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects before touching canvases when already cancelled", async () => {
    addCanvas();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareMaplibreCanvasPrint(root, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });
});
