import { afterEach, describe, expect, it, vi } from "vitest";

import { useImageResize } from "@/composables/useImageResize";
import { useVideoPoster } from "@/composables/useVideoPoster";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Canvasを使用した画像リサイズ", () => {
  it("リサイズした画像を描画してエンコード済みBlobを返す", async () => {
    const drawImage = vi.fn();
    const output = new Blob(["resized"], { type: "image/jpeg" });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(output);
    });
    vi.stubGlobal(
      "Image",
      class {
        width = 4000;
        height = 2000;
        onload: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const createObjectURL = vi.fn(() => "blob:image");
    vi.stubGlobal("URL", { ...URL, createObjectURL });

    const result = await useImageResize().resizeImageWithCanvas(
      new File(["image"], "photo.jpg", { type: "image/jpeg" }),
    );

    expect(result).toBe(output);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1280);
  });

  it("Canvasコンテキストを生成できない場合はエラーにする", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal(
      "Image",
      class {
        width = 100;
        height = 100;
        onload: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:image") });

    await expect(
      useImageResize().resizeImageWithCanvas(
        new File(["image"], "photo.jpg", { type: "image/jpeg" }),
      ),
    ).rejects.toThrow("Canvas context");
  });
});

describe("動画ポスター画像の生成", () => {
  it("縮小したフレームを取得して動画由来の名前を付けリソースを解放する", async () => {
    const nativeCreateElement = document.createElement.bind(document);
    const video = nativeCreateElement("video");
    const canvas = nativeCreateElement("canvas");
    const drawImage = vi.fn();
    const output = new Blob(["poster"], { type: "image/jpeg" });
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 900 },
      videoHeight: { configurable: true, value: 600 },
      duration: { configurable: true, value: 5 },
      currentTime: {
        configurable: true,
        set() {
          queueMicrotask(() => video.onseeked?.(new Event("seeked")));
        },
      },
    });
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as never);
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(output));
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName === "video") return video;
      if (tagName === "canvas") return canvas;
      return nativeCreateElement(tagName, options);
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:video"),
      revokeObjectURL,
    });

    const promise = useVideoPoster().generateVideoPoster(
      new File(["video"], "sample.clip.mp4", { type: "video/mp4" }),
    );
    video.onloadedmetadata?.(new Event("loadedmetadata"));
    const result = await promise;

    expect(result).toEqual({ blob: output, fileName: "sample.clip.jpg" });
    expect(canvas.width).toBe(450);
    expect(canvas.height).toBe(300);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 450, 300);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:video");
  });
});
