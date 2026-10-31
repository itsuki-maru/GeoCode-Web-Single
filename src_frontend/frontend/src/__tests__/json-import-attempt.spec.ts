import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginJsonImport, completeJsonImport, sha256 } from "@/utils/json-import-attempt";

const file = (text: string, name = "export.json") => {
  const bytes = new TextEncoder().encode(text);
  const value = new File([text], name, { type: "application/json" });
  Object.defineProperty(value, "arrayBuffer", { value: async () => bytes.buffer });
  return value;
};

beforeEach(() => sessionStorage.clear());

describe("HTTPでも使用できるファイル識別とUUID", () => {
  it.each([0, 1, 3, 55, 56, 63, 64, 65, 1000, 1024 * 1024 + 7])(
    "SHA-256のブロック境界と長さ %i を検証する",
    (size) => {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 13) % 256);
      expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    },
  );

  it("Unicodeと大きな整数を含むJSONも元のUTF-8バイトで識別する", () => {
    const bytes = new TextEncoder().encode('{"地図":"東京都🗺️","n":9007199254740993123456789}');
    expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("安全なコンテキスト専用APIを使わずUUID v4を生成する", async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      const attempt = await beginJsonImport("account", file("{}"));
      expect(attempt.key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("取込操作の保存と再試行", () => {
  it("同じ内容の再試行は名前が違っても同じキーで、別内容・別アカウントは別のキーになる", async () => {
    const first = await beginJsonImport("account-a", file('{"n":9007199254740993}'));
    const other = await beginJsonImport("account-a", file('{"n":9007199254740994}'));
    const retry = await beginJsonImport(
      "account-a",
      file('{"n":9007199254740993}', "renamed.json"),
    );
    const account = await beginJsonImport("account-b", file('{"n":9007199254740993}'));
    expect(retry).toEqual(first);
    expect(other.key).not.toBe(first.key);
    expect(account.key).not.toBe(first.key);
  });

  it("同じタブの再読み込み相当でも未確認のキーを復元する", async () => {
    const first = await beginJsonImport("account", file("{}"));
    vi.resetModules();
    const reloaded = await import("@/utils/json-import-attempt");
    expect(await reloaded.beginJsonImport("account", file("{}"))).toEqual(first);
  });

  it("成功確認後の同じファイルの取り込みは新しい操作になる", async () => {
    const first = await beginJsonImport("account", file("{}"));
    completeJsonImport(first);
    expect(sessionStorage.getItem(first.storageKey)).toBeNull();
    expect((await beginJsonImport("account", file("{}"))).key).not.toBe(first.key);
  });

  it("保存できない場合は送信可能な操作を返さない", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(beginJsonImport("account", file("{}"))).rejects.toThrow("保存できません");
  });

  it("成功後の保存情報削除失敗でも成功を覆さず、次の操作に古いキーを使わない", async () => {
    const first = await beginJsonImport("account", file("{}"));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => completeJsonImport(first)).not.toThrow();
    expect((await beginJsonImport("account", file("{}"))).key).not.toBe(first.key);
  });
});

describe("FileReaderによる取込操作の識別", () => {
  it("代替の読み込み経路でも同じバイト列を同じ再試行キーへ対応付ける", async () => {
    const bytes = new TextEncoder().encode('{"記録":"点検"}');
    const original = await beginJsonImport("reader-account", file('{"記録":"点検"}'));
    let reader: any;
    class Reader {
      result = bytes.buffer;
      onload: any;
      readAsArrayBuffer = vi.fn(() => queueMicrotask(() => this.onload()));
      constructor() {
        reader = this;
      }
    }
    vi.stubGlobal("FileReader", Reader);
    try {
      const value = new File(["unused"], "renamed.json");
      Object.defineProperty(value, "arrayBuffer", { value: undefined });
      const retry = await beginJsonImport("reader-account", value);
      expect(retry).toEqual(original);
      expect(reader.readAsArrayBuffer).toHaveBeenCalledExactlyOnceWith(value);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(["onerror", "onabort"])(
    "読み込みの%sでは再試行情報を作成せず、既存の未解決操作も消さない",
    async (event) => {
      const original = await beginJsonImport("reader-account", file("unresolved"));
      const before = Object.entries(sessionStorage);
      class Reader {
        onerror: any;
        onabort: any;
        readAsArrayBuffer() {
          queueMicrotask(() => (this as any)[event]());
        }
      }
      vi.stubGlobal("FileReader", Reader);
      try {
        const value = new File(["bad"], "bad.json");
        Object.defineProperty(value, "arrayBuffer", { value: undefined });
        await expect(beginJsonImport("reader-account", value)).rejects.toThrow(
          event === "onerror" ? "読み込めません" : "中断されました",
        );
        expect(Object.entries(sessionStorage)).toEqual(before);
        expect(sessionStorage.getItem(original.storageKey)).toBe(original.key);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
