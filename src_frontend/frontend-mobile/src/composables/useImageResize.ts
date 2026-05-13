/**
 * Canvas画像リサイズロジック
 * 最大2560x1440、品質80%
 */
export function useImageResize() {
  const resizeImageWithCanvas = (file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxWidth = 2560;
        const maxHeight = 1440;

        const { width, height } = calculateDimensions(img.width, img.height, maxWidth, maxHeight);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas contextの取得に失敗しました。"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Blobの生成に失敗しました。"));
            }
          },
          file.type,
          0.8,
        );
      };
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
      img.src = URL.createObjectURL(file);
    });
  };

  const calculateDimensions = (
    width: number,
    height: number,
    maxWidth: number,
    maxHeight: number,
  ) => {
    // 横長画像の場合
    if (height < width) {
      if (width > maxWidth || height > maxHeight) {
        const widthRatio = maxWidth / width;
        const heightRatio = maxHeight / height;
        const ratio = Math.min(widthRatio, heightRatio);
        return {
          width: Math.floor(width * ratio),
          height: Math.floor(height * ratio),
        };
      }
      return { width, height };

      // 縦長画像の場合
    } else {
      if (height > maxWidth || width > maxHeight) {
        const widthRatio = maxWidth / height;
        const heightRatio = maxHeight / width;
        const ratio = Math.min(widthRatio, heightRatio);
        return {
          width: Math.floor(width * ratio),
          height: Math.floor(height * ratio),
        };
      }
      return { width, height };
    }
  };

  return { resizeImageWithCanvas, calculateDimensions };
}
