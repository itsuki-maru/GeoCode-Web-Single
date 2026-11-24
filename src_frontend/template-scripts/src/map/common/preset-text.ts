import type { PresetTarget } from "./local-preset";

type Transport = (
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
// 大小文字・結合記号・case-ignorable にまたがる単語は、前後の文脈によって
// Σ やトルコ語の I などの小文字形が変わる。空白・漢字等の安全な境界だけで切る。
const words = /[\p{Cased}\p{Case_Ignorable}\p{M}]+/gu;
const cased = /\p{Cased}/u;
const combining = /\p{M}/u;
const needsCase = /[\p{Cased}\p{M}]/u;
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const lookupError = () =>
  Error("文字列の照合情報を取得できませんでした。条件を呼び出し直してください。");

function foldWord(word: string, lookup: (fragment: string) => string): string {
  if (word.includes("Σ") || (/[IJĮ]/u.test(word) && combining.test(word))) {
    if (word.length <= 4096) return lookup(word);
    // 区切りのない長文も、前の文字に依存しない基底文字の手前で分割できる。
    // 左片には次の基底文字も付け、Σの末尾判定を保存する。連続するΣの
    // 右片にも直前のΣを付ける。付加した文字は小文字化してから取り除く。
    const boundary = /(?=[\p{Cased}])[^\p{Case_Ignorable}\p{M}Σ]|(?<=Σ)Σ/gu;
    const parts: string[] = [];
    let start = 0,
      prefix = "";
    while (start + 4096 < word.length) {
      boundary.lastIndex = start + 4096;
      const next = boundary.exec(word);
      if (!next) break;
      const guard = next[0];
      const guardLength = guard.length === 1 && /^[A-Z]$/i.test(guard) ? 1 : lookup(guard).length;
      parts.push(
        lookup(prefix + word.slice(start, next.index) + guard).slice(prefix.length, -guardLength),
      );
      start = next.index;
      prefix = next[0] === "Σ" ? "Σ" : "";
    }
    parts.push(lookup(prefix + word.slice(start)).slice(prefix.length));
    return parts.join("");
  }
  // 文脈に依存しない部分では個々の文字を使い、名前や本文を送信しない。
  return word.replace(/[A-Z]|[^\x00-\x7f]/gu, (ch) =>
    ch === "I" || (ch.charCodeAt(0) > 127 && cased.test(ch)) ? lookup(ch) : ch.toLowerCase(),
  );
}
function fragments(text: string, add: (part: string) => void) {
  if (!/I|[^\x00-\x7f]/u.test(text)) return;
  for (const match of text.matchAll(words))
    foldWord(match[0], (part) => {
      add(part);
      return part;
    });
}

/** 地物や検索結果は送信せず、DBロケールに依存する断片だけを準備時にまとめて解決する。 */
export class PresetText {
  private folded = new Map<string, string>();
  private targetFragments?: Set<string>;
  private targetsReady = false;
  private nativeCase = true;
  private asciiCase = true;
  constructor(private readonly targets: readonly PresetTarget[]) {}

  private requirements(terms: ReadonlySet<string>) {
    const needed = new Set<string>();
    if (![...terms].some((t) => needsCase.test(t))) return needed;
    if (!this.targetsReady) {
      if (!this.targetFragments) {
        this.targetFragments = new Set();
        for (const { name, detail } of this.targets) {
          fragments(name, (part) => this.targetFragments!.add(part));
          fragments(detail, (part) => this.targetFragments!.add(part));
        }
      }
      for (const part of this.targetFragments) if (!this.folded.has(part)) needed.add(part);
    }
    for (const term of terms)
      fragments(term, (part) => {
        if (!this.folded.has(part)) needed.add(part);
      });
    return needed;
  }

  ready(terms: ReadonlySet<string>) {
    return !this.requirements(terms).size;
  }

  async prepare(terms: ReadonlySet<string>, transport: Transport, signal: AbortSignal) {
    const needed = this.requirements(terms);
    if (!needed.size) return;
    const staged = new Map<string, string>();
    let batch: string[] = [],
      size = 0;
    const flush = async () => {
      signal.throwIfAborted();
      const values = await transport(
        "/form-answers/map-presets/text-fold",
        { fragments: batch },
        signal,
      );
      signal.throwIfAborted();
      if (
        !Array.isArray(values) ||
        values.length !== batch.length ||
        values.some((v) => typeof v !== "string")
      )
        throw lookupError();
      batch.forEach((part, i) => staged.set(part, values[i]));
      batch = [];
      size = 0;
    };
    for (const fragment of needed) {
      if (batch.length && (batch.length === 2048 || size + fragment.length > 32768)) await flush();
      batch.push(fragment);
      size += fragment.length;
    }
    if (batch.length) await flush();
    return () => {
      for (const [part, value] of staged) {
        this.folded.set(part, value);
        this.nativeCase &&= part.toLowerCase() === value;
        this.asciiCase &&= asciiLower(part) === value;
      }
      this.targetFragments = undefined;
      this.targetsReady = true;
    };
  }

  matcher(terms: string[]) {
    const fold = this.nativeCase
      ? (s: string) => s.toLowerCase()
      : this.asciiCase
        ? asciiLower
        : (text: string) =>
            text.replace(words, (word) =>
              foldWord(word, (part) => {
                const result = this.folded.get(part);
                if (result === undefined) throw lookupError();
                return result;
              }),
            );
    const useCase = terms.some((t) => needsCase.test(t));
    const needles = useCase ? terms.map(fold) : terms;
    return (target: PresetTarget) => {
      const name = useCase ? fold(target.name) : target.name;
      const detail = useCase ? fold(target.detail) : target.detail;
      return needles.every((q) => name.includes(q) || detail.includes(q));
    };
  }
}
