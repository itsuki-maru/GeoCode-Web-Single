import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resizeImage } from "../form-image-resize";

let loaded: {
  naturalWidth: number;
  naturalHeight: number;
  onload: () => void;
  onerror: () => void;
  src: string;
};
let canvas: HTMLCanvasElement;
const drawImage = vi.fn();
const revoke = vi.fn();
const createUrl = vi.fn();
const blob = new Blob(["jpeg"], { type: "image/jpeg" });

beforeEach(() => {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 3200;
      naturalHeight = 1600;
      onload = () => {};
      onerror = () => {};
      src = "";
      constructor() {
        loaded = this;
      }
    },
  );
  // 画像のデコードと canvas のエンコードは、jsdom では使えないブラウザー API である。
  createUrl.mockReturnValue("blob:fixture");
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revoke }),
  );
  canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(blob));
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "canvas" ? canvas : createElement(tag)) as typeof document.createElement);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("フォーム添付画像の縮小", () => {
  it.each([
    [3200, 1600, 1600, 800],
    [800, 3200, 400, 1600],
    [1600, 1600, 1600, 1600],
    [200, 100, 200, 100],
    [1, 4000, 1, 1600],
  ])(
    "縦横比を保ち、小画像を拡大せず、最小1pxを確保する: %s x %s",
    async (width, height, expectedWidth, expectedHeight) => {
      const file = new File(["source"], "photo.png", { type: "image/png" });
      const result = resizeImage(file);
      expect(createUrl).toHaveBeenCalledExactlyOnceWith(file);
      expect(loaded.src).toBe("blob:fixture");
      loaded.naturalWidth = width;
      loaded.naturalHeight = height;
      loaded.onload();
      expect(await result).toBe(blob);
      expect([canvas.width, canvas.height]).toEqual([expectedWidth, expectedHeight]);
      expect(drawImage).toHaveBeenCalledExactlyOnceWith(
        loaded,
        0,
        0,
        expectedWidth,
        expectedHeight,
      );
      expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.78);
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    },
  );

  it("15MiBを超える元画像をデコード前に拒否する", async () => {
    const file = new File([], "large.png");
    Object.defineProperty(file, "size", { value: 15 * 1024 * 1024 + 1 });
    await expect(resizeImage(file)).rejects.toThrow("元画像は15MB以内");
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("元画像15MiBと出力1.5MBの境界を許可する", async () => {
    const file = new File([], "limit.png");
    Object.defineProperty(file, "size", { value: 15 * 1024 * 1024 });
    const output = new Blob([new Uint8Array(1_500_000)]);
    vi.mocked(canvas.toBlob).mockImplementation((callback) => callback(output));
    const result = resizeImage(file);
    loaded.onload();
    expect(await result).toBe(output);
  });

  it("壊れた画像を拒否し、オブジェクトURLを解放する", async () => {
    const result = resizeImage(new File(["bad"], "bad.png"));
    const rejected = expect(result).rejects.toThrow("画像を読み込めませんでした");
    loaded.onerror();
    await rejected;
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("描画コンテキスト取得失敗を通知し、URLを解放する", async () => {
    vi.mocked(canvas.getContext).mockReturnValue(null);
    const result = resizeImage(new File(["source"], "photo.png"));
    const rejected = expect(result).rejects.toThrow("画像を処理できませんでした");
    loaded.onload();
    await rejected;
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });

  it.each([null, new Blob([new Uint8Array(1_500_001)])])(
    "変換失敗または出力サイズ超過を拒否する",
    async (output) => {
      vi.mocked(canvas.toBlob).mockImplementation((callback) => callback(output));
      const result = resizeImage(new File(["source"], "photo.png"));
      const rejected = expect(result).rejects.toThrow(
        output ? "1.5MBを超えています" : "画像を変換できませんでした",
      );
      loaded.onload();
      await rejected;
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    },
  );
});
