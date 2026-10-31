// 元のファイルのバイト列から SHA-256 を求め、転送用 JSON は JavaScript で解析しない。
// この実装は、crypto.subtle のない HTTP オリジンでも動作する。
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

export function sha256(bytes: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!,
        y = words[i - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [...state] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + ROUND_CONSTANTS[i]! + words[i]!) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const block = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < state.length; i++) state[i] = (state[i]! + block[i]!) >>> 0;
  }
  return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("JSONファイルを読み込めませんでした。"));
    reader.onabort = () => reject(new Error("JSONファイルの読み込みが中断されました。"));
    reader.readAsArrayBuffer(file);
  });
}

export interface JsonImportAttempt {
  storageKey: string;
  key: string;
}
const completedKeys = new Set<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function beginJsonImport(
  accountScope: string,
  file: File,
): Promise<JsonImportAttempt> {
  if (!accountScope) throw new Error("アカウントの情報を取得してから再試行してください。");
  const fingerprint = sha256(new Uint8Array(await readFile(file)));
  const storageKey = `geocode-web:json-import:${encodeURIComponent(accountScope)}:${fingerprint}`;
  try {
    const previous = sessionStorage.getItem(storageKey);
    const key =
      previous && UUID.test(previous) && !completedKeys.has(previous) ? previous : randomUuid();
    // 応答が不確かな場合も再読み込み後に安全に再開できるよう、POST の前に永続化する。
    sessionStorage.setItem(storageKey, key);
    return { storageKey, key };
  } catch {
    throw new Error(
      "再試行に必要な情報をブラウザーに保存できません。ブラウザーの設定を確認してください。",
    );
  }
}

export function completeJsonImport(attempt: JsonImportAttempt): void {
  // 後処理の失敗を理由に、確定済みのインポートを失敗として扱わない。
  completedKeys.add(attempt.key);
  try {
    if (sessionStorage.getItem(attempt.storageKey) === attempt.key) {
      sessionStorage.removeItem(attempt.storageKey);
    }
  } catch {
    console.warn("インポート済みの再試行情報を削除できませんでした。");
  }
}
