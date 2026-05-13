/**
 * ファイルタイプ判定ユーティリティ
 */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "application/pdf",
];

export function isMP4(filename: string): boolean {
  return /\.mp4$/i.test(filename);
}

export function isPDF(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}
