const MAX_SOURCE_SIZE = 15 * 1024 * 1024;
const MAX_OUTPUT_SIZE = 1_500_000;
const MAX_DIMENSION = 1600;

export function resizeImage(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_SIZE) {
    return Promise.reject(new Error("元画像は15MB以内にしてください。"));
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const ratio = Math.min(
        1,
        MAX_DIMENSION / image.naturalWidth,
        MAX_DIMENSION / image.naturalHeight,
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("画像を処理できませんでした。"));
        return;
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("画像を変換できませんでした。"));
          } else if (blob.size > MAX_OUTPUT_SIZE) {
            reject(
              new Error(
                "縮小後の画像が1.5MBを超えています。別の画像を選択してください。",
              ),
            );
          } else {
            resolve(blob);
          }
        },
        "image/jpeg",
        0.78,
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("画像を読み込めませんでした。"));
    };
    image.src = objectUrl;
  });
}
