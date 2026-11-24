import type { PresetTarget } from "./local-preset";

let readSequence = 0;

// 保存条件の先読みを始めるときに、同じ地図から選択レイヤー内の地物と本文を受け取る。
// 呼び出しの切り替えに使えるよう、現在の絞り込みで非表示になった地物も含める。
export function readAnswerPresetScope(
  frame: Window,
  origin: string,
  requestId: string,
  knownTargets: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<PresetTarget[]> {
  return new Promise((resolve, reject) => {
    const scopeId = String(++readSequence);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      window.removeEventListener("message", receive);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== frame ||
        event.origin !== origin ||
        data?.requestId !== requestId ||
        data.type !== "answer-map-preset-scope" ||
        data.scopeId !== scopeId
      )
        return;
      cleanup();
      const seen = new Set<string>();
      if (
        !Array.isArray(data.targets) ||
        !data.targets.every((target: PresetTarget) => {
          if (
            !target ||
            !knownTargets.has(target.key) ||
            seen.has(target.key) ||
            typeof target.name !== "string" ||
            typeof target.detail !== "string"
          )
            return false;
          seen.add(target.key);
          return true;
        })
      )
        return reject(Error("地図の対象データを確認できませんでした。"));
      resolve(data.targets);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("地図の対象データを取得できませんでした。再試行してください。"));
    }, 10000);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    window.addEventListener("message", receive);
    frame.postMessage({ type: "answer-map-preset-scope-request", requestId, scopeId }, origin);
  });
}
