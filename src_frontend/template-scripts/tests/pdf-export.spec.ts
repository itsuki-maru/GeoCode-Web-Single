import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMapPdf } from "../src/map/print/pdf-export";
const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  pdf: vi.fn(),
  link: vi.fn(),
  addImage: vi.fn(),
  properties: vi.fn(),
}));
vi.mock("html2canvas", () => ({ default: mocks.render }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) {
      mocks.pdf(options);
    }
    setProperties = mocks.properties;
    addImage = mocks.addImage;
    link = mocks.link;
    output = () => new Blob(["pdf"], { type: "application/pdf" });
  },
}));

const rect = (left = 0, top = 0, width = 400, height = 600) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});
let paper: HTMLElement, output: HTMLCanvasElement, clone: HTMLElement;
let loaded: string[], mode: "ok" | "error" | "empty" | "pending";
let images: any[];
beforeEach(() => {
  vi.clearAllMocks();
  loaded = [];
  images = [];
  mode = "ok";
  paper = document.createElement("section");
  document.body.append(paper);
  Object.defineProperties(paper, { offsetWidth: { value: 400 }, offsetHeight: { value: 600 } });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect());
  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 20;
      naturalHeight = 20;
      crossOrigin = "";
      onload: any = null;
      onerror: any = null;
      constructor() {
        images.push(this);
      }
      set src(value: string) {
        if (!value) return;
        loaded.push(value);
        if (mode === "empty") this.naturalWidth = 0;
        if (mode !== "pending")
          queueMicrotask(() => (mode === "error" ? this.onerror?.() : this.onload?.()));
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,TEST");
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
  });
  output = document.createElement("canvas");
  output.width = 400;
  output.height = 600;
  mocks.render.mockImplementation(async (_paper, options) => {
    clone = paper.cloneNode(true) as HTMLElement;
    await options.onclone(document, clone);
    return output;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const addImage = (src = "https://tiles.example/one.png") => {
  const img = document.createElement("img");
  img.src = src;
  Object.defineProperties(img, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 20, configurable: true },
  });
  paper.append(img);
  return img;
};
const generate = (controller = new AbortController(), format: any = "a4-portrait") =>
  generateMapPdf(paper, format, "地図タイトル", controller.signal);

describe("PDF export browser contracts", () => {
  it("captures marked WebGL backgrounds without disturbing raster image indexes", async () => {
    const raster = addImage();
    const unrelated = document.createElement("canvas");
    paper.append(unrelated);
    const background = document.createElement("canvas");
    background.dataset.geocodeMaplibreCanvas = "";
    background.style.cssText = "position:absolute;width:400px;height:300px";
    paper.append(background);
    const result = await generate();
    expect(result.type).toBe("application/pdf");
    expect(clone.querySelectorAll("img")).toHaveLength(2);
    expect(clone.querySelectorAll("canvas")).toHaveLength(1);
    expect(clone.querySelector("[data-geocode-maplibre-print-image]")?.getAttribute("src")).toBe(
      "data:image/png;base64,TEST",
    );
    expect(clone.querySelector<HTMLImageElement>("img")!.src).toBe("data:image/png;base64,TEST");
    expect(loaded).toEqual([raster.src]);
    expect(paper.contains(background)).toBe(true);
    expect(paper.querySelectorAll("img")).toHaveLength(1);
  });

  it("rejects WebGL capture failure instead of silently exporting a blank background", async () => {
    const background = document.createElement("canvas");
    background.dataset.geocodeMaplibreCanvas = "";
    paper.append(background);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue("data:,");
    await expect(generate()).rejects.toThrow("背景地図を画像化できません");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("removes only the cloned MapLibre overflow clip after a translated paper resize", async () => {
    const map = document.createElement("div");
    map.id = "map";
    map.style.overflow = "hidden";
    const pane = document.createElement("div");
    pane.style.transform = "translate3d(0px, 373px, 0px)";
    const container = document.createElement("div");
    container.className = "leaflet-gl-layer maplibregl-map";
    container.style.cssText =
      "position:relative;overflow:hidden;transform:translate3d(-100px, -500px, 0px)";
    const canvas = document.createElement("canvas");
    canvas.dataset.geocodeMaplibreCanvas = "";
    canvas.style.cssText = "position:absolute;width:480px;height:720px";
    container.append(canvas);
    pane.append(container);
    map.append(pane);
    const unrelated = document.createElement("div");
    unrelated.className = "maplibregl-map unrelated";
    unrelated.style.overflow = "hidden";
    map.append(unrelated);
    paper.append(map);
    const original = container.style.cssText;
    await generate();
    expect(clone.querySelector<HTMLElement>(".leaflet-gl-layer")!.style.overflow).toBe("visible");
    expect(clone.querySelector<HTMLElement>("#map")!.style.overflow).toBe("hidden");
    expect(clone.querySelector<HTMLElement>(".unrelated")!.style.overflow).toBe("hidden");
    expect(container.style.cssText).toBe(original);
    expect(paper.contains(canvas)).toBe(true);
  });

  it("converts duplicate tiles once, excludes controls and preserves safe source links", async () => {
    addImage();
    addImage();
    const hidden = addImage("https://tiles.example/hidden.png");
    hidden.style.display = "none";
    const excluded = document.createElement("div");
    excluded.className = "leaflet-control-zoom";
    excluded.append(addImage("https://tiles.example/control.png"));
    paper.append(excluded);
    const attribution = document.createElement("div");
    attribution.className = "leaflet-control-attribution";
    attribution.innerHTML =
      '<a href="https://source.example/data">出典</a><a href="javascript:void(0)">操作</a>';
    paper.append(attribution);
    const result = await generate();
    expect(result.type).toBe("application/pdf");
    expect(loaded).toEqual(["https://tiles.example/one.png"]);
    expect(clone.querySelectorAll("img")).toHaveLength(2);
    expect(
      [...clone.querySelectorAll("img")].every((img) => img.src.startsWith("data:image/png")),
    ).toBe(true);
    expect(clone.querySelector(".leaflet-control-zoom")).toBeNull();
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(mocks.link.mock.calls[0]![4]).toEqual({ url: "https://source.example/data" });
    expect(mocks.properties).toHaveBeenCalledWith({
      title: "地図タイトル",
      creator: "GeoCode-Web",
    });
    expect(mocks.addImage).toHaveBeenCalledTimes(1);
    expect(output.width).toBe(0);
    expect(output.height).toBe(0);
  });

  it("rasterizes SVG styles and CSS background images before cloning", async () => {
    paper.innerHTML =
      '<svg style="position:absolute"><path stroke="red" /></svg><svg style="display:none"></svg><div class="icon" style="background-image:url(https://tiles.example/icon.png)"></div><div class="geocode-content-popup"><div class="popup-content-toolbar">操作</div><div class="popup-content-print-label">ラベル</div></div>';
    const svg = paper.querySelector("svg")!;
    Object.defineProperties(svg, {
      width: { value: { baseVal: { value: 100 } } },
      height: { value: { baseVal: { value: 80 } } },
    });
    await generate();
    expect(loaded[0]).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(loaded[0]!)).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(loaded).toContain("https://tiles.example/icon.png");
    expect(clone.querySelectorAll("svg")).toHaveLength(0);
    expect(clone.querySelector("img")!.style.width).toBe("100px");
    expect(clone.querySelector<HTMLElement>(".icon")!.style.backgroundImage).toContain(
      "data:image/png",
    );
    expect(clone.querySelector<HTMLElement>(".popup-content-toolbar")!.style.display).toBe("none");
    expect(clone.querySelector<HTMLElement>(".popup-content-print-label")!.style.display).toBe(
      "block",
    );
  });

  it("rejects incomplete images before rendering", async () => {
    const img = addImage();
    Object.defineProperty(img, "complete", { value: false });
    await expect(generate()).rejects.toThrow("未取得の画像");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it.each(["error", "empty", "context", "tainted"])(
    "rejects image conversion failures without producing a PDF: %s",
    async (failure) => {
      addImage();
      if (failure === "error" || failure === "empty") mode = failure;
      if (failure === "context")
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
      if (failure === "tainted")
        vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue("data:,");
      await expect(generate()).rejects.toThrow();
      expect(mocks.render).not.toHaveBeenCalled();
      expect(mocks.addImage).not.toHaveBeenCalled();
      expect(images[0].onload).toBeNull();
      expect(images[0].onerror).toBeNull();
    },
  );

  it("aborts a pending image immediately and clears its deadline", async () => {
    vi.useFakeTimers();
    mode = "pending";
    addImage();
    const controller = new AbortController();
    const pending = generate(controller);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("times out a stalled image using an advanced fake clock", async () => {
    vi.useFakeTimers();
    mode = "pending";
    addImage();
    const rejected = expect(generate()).rejects.toThrow("画像をPDFに取り込めません");
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already aborted export before starting any work", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generate(controller)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("cleans the rendered canvas if cancellation arrives after rendering", async () => {
    const controller = new AbortController();
    mocks.render.mockImplementationOnce(async () => {
      controller.abort();
      return output;
    });
    await expect(generate(controller)).rejects.toMatchObject({ name: "AbortError" });
    expect(output.width).toBe(0);
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("removes html2canvas temporary frames when cloning fails", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    mocks.render.mockImplementationOnce(async (_paper, options) => {
      clone = paper.cloneNode(true) as HTMLElement;
      // 描画ライブラリは、複製用コールバックでフレームを作成した後に失敗する場合がある。
      await options.onclone(frame.contentDocument, clone);
      throw new Error("render failed");
    });
    await expect(generate()).rejects.toThrow("render failed");
    expect(frame.isConnected).toBe(false);
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
});
