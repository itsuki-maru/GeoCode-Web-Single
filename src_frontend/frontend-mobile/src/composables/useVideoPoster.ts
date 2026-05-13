type PosterResult = {
  blob: Blob;
  fileName: string;
};

export function useVideoPoster() {
  const generateVideoPoster = (file: File): Promise<PosterResult> => {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = objectUrl;

      const cleanup = () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
      };

      const rejectWithCleanup = (error: Error) => {
        cleanup();
        reject(error);
      };

      const renderPoster = () => {
        const canvas = document.createElement("canvas");
        const maxLongSide = 450;
        const width = video.videoWidth;
        const height = video.videoHeight;
        const scale = Math.min(1, maxLongSide / Math.max(width, height));

        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          rejectWithCleanup(new Error("Canvas contextの取得に失敗しました。"));
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              rejectWithCleanup(new Error("動画posterの生成に失敗しました。"));
              return;
            }

            const stem = file.name.replace(/\.[^.]+$/, "");
            cleanup();
            resolve({
              blob,
              fileName: `${stem}.jpg`,
            });
          },
          "image/jpeg",
          0.8,
        );
      };

      video.onloadedmetadata = () => {
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          rejectWithCleanup(new Error("動画サイズを取得できませんでした。"));
          return;
        }

        const captureTime =
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.min(1, Math.max(0.1, video.duration * 0.1))
            : 0;

        if (captureTime === 0) {
          renderPoster();
          return;
        }
        video.currentTime = captureTime;
      };

      video.onseeked = renderPoster;
      video.onerror = () => {
        rejectWithCleanup(new Error("動画の読み込みに失敗しました。"));
      };
    });
  };

  return { generateVideoPoster };
}
