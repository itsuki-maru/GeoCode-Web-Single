import { describe, expect, it } from "vitest";

import type { ShapeData } from "@/interface";
import { ALLOWED_MIME_TYPES, isMP4, isPDF } from "@/composables/useFileTypeCheck";
import { useImageResize } from "@/composables/useImageResize";
import { getShapeCenter } from "@/composables/useShapeCenter";

const shape = (type: string, coordinates: unknown): ShapeData =>
  ({ geojson: { geometry: { type, coordinates } } }) as unknown as ShapeData;

describe("ファイル種別ユーティリティ", () => {
  it("MP4とPDFの拡張子を大文字小文字を区別せず判定する", () => {
    expect(isMP4("movie.MP4")).toBe(true);
    expect(isMP4("movie.mp4.txt")).toBe(false);
    expect(isPDF("manual.PdF")).toBe(true);
    expect(isPDF("manual.pdfx")).toBe(false);
  });

  it("対応する画像・動画・PDFのMIMEタイプを含む", () => {
    expect(ALLOWED_MIME_TYPES).toEqual(
      expect.arrayContaining(["image/jpeg", "image/png", "video/mp4", "application/pdf"]),
    );
  });
});

describe("図形中心座標の計算", () => {
  it("Point座標を緯度と経度として返す", () => {
    expect(getShapeCenter(shape("Point", [139.7, 35.6]))).toEqual({
      latitude: 35.6,
      longitude: 139.7,
    });
  });

  it("有効なLineString座標の平均を計算する", () => {
    expect(
      getShapeCenter(
        shape("LineString", [
          [0, 10],
          [10, 20],
          [Number.NaN, 5],
        ]),
      ),
    ).toEqual({
      latitude: 15,
      longitude: 5,
    });
  });

  it("Polygonの重複した終端座標を計算対象に含めない", () => {
    expect(
      getShapeCenter(
        shape("Polygon", [
          [
            [0, 0],
            [6, 0],
            [6, 6],
            [0, 6],
            [0, 0],
          ],
        ]),
      ),
    ).toEqual({
      latitude: 3,
      longitude: 3,
    });
  });

  it("未対応または空のジオメトリではnullを返す", () => {
    expect(getShapeCenter(shape("LineString", []))).toBeNull();
    expect(getShapeCenter(shape("MultiPoint", [[1, 2]]))).toBeNull();
  });
});

describe("画像サイズの計算", () => {
  const { calculateDimensions } = useImageResize();

  it("上限内の画像サイズを維持する", () => {
    expect(calculateDimensions(800, 600, 2560, 1440)).toEqual({ width: 800, height: 600 });
  });

  it("横長画像をアスペクト比を維持して縮小する", () => {
    expect(calculateDimensions(4000, 2000, 2560, 1440)).toEqual({ width: 2560, height: 1280 });
  });

  it("縦長画像を長辺と短辺の上限に合わせて縮小する", () => {
    expect(calculateDimensions(2000, 4000, 2560, 1440)).toEqual({ width: 1280, height: 2560 });
  });
});
