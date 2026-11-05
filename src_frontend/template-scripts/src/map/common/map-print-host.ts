import type { PrintMapState } from "./print-state";
import { isPrintMapState } from "./print-state";
import { action, node } from "./coloring-editor";
import type { ShareMapSnapshot } from "./share-snapshot";

export const READ_ONLY_MAP_PRINT_PATH = "/assets/read-only-map-print.html";

export function requestMapPrintState(
  source: HTMLIFrameElement,
  signal: AbortSignal,
): Promise<PrintMapState> {
  return new Promise((resolve, reject) => {
    const sourceWindow = source.contentWindow,
      origin = new URL(source.src, location.href).origin;
    const requestId = `print-state-${Date.now()}-${Math.random()}`;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(Error("地図状態の取得を中止しました。"));
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== sourceWindow ||
        event.origin !== origin ||
        event.data?.type !== "printStateResult" ||
        event.data.requestId !== requestId
      )
        return;
      cleanup();
      if (!isPrintMapState(event.data.state))
        reject(Error("現在の地図を取得できません。読み込み完了後に再試行してください。"));
      else resolve(event.data.state);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("印刷プレビューを読み込めませんでした。現在の地図を取得できません。"));
    }, 15000);
    if (signal.aborted || !sourceWindow) {
      abort();
      return;
    }
    window.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    sourceWindow.postMessage({ type: "printStateRequest", requestId }, origin);
  });
}

type PrintPreviewOptions = {
  url: string;
  container?: HTMLElement;
  close(): void;
} & (
  | {
      snapshot: true;
      getState(signal: AbortSignal): Promise<ShareMapSnapshot>;
      answer?: never;
    }
  | {
      snapshot?: false;
      getState(signal: AbortSignal): Promise<PrintMapState | Record<string, unknown>>;
      answer?: {
        initialize(
          frame: HTMLIFrameElement,
          requestId: string,
          fail: (message: string) => void,
        ): () => void;
      };
    }
);

export function openMapPrintPreview(options: PrintPreviewOptions) {
  const origin = new URL(options.url, location.href).origin;
  if (options.snapshot && origin !== location.origin)
    throw Error("印刷プレビューは地図と同じサイトで開いてください。");
  const correlated = Boolean(options.answer || options.snapshot);
  const previous = document.activeElement as HTMLElement | null;
  const dialog = node("dialog");
  dialog.className = "map-print-host print-dialog";
  dialog.setAttribute("aria-label", "地図の印刷プレビュー");
  const style = node("style");
  style.textContent = `
    .map-print-host {
      box-sizing: border-box;
      position: fixed;
      /* 地図ページのMarkdown用margin上書きに依存せず中央へ配置する。 */
      inset: 50% auto auto 50%;
      transform: translate(-50%, -50%);
      margin: 0;
      width: 96vw;
      height: 94vh;
      max-width: none;
      max-height: none;
      padding: 0;
      border: 0;
      border-radius: 12px;
      background: #edf1f5;
      color: #222;
      font: 16px/1.4 sans-serif;
    }
    .map-print-host[open] {
      display: flex;
      flex-direction: column;
    }
    .map-print-host::backdrop {
      background: #0f172aa6;
    }
    .map-print-host header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: white;
      padding: 10px 20px;
    }
    .map-print-host button {
      font: inherit;
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .map-print-host .print-header > button {
      border: 1px solid transparent;
      background-color: #5f5f5f;
      color: #fff;
      box-shadow: 0 2px 2px rgb(0 0 0 / 20%);
      transition: border-color 0.25s;
    }
    .map-print-host .print-header > button:hover,
    .map-print-host .print-header > button:active {
      border-color: #396cd8;
    }
    .map-print-host .print-header > button:active {
      background-color: #e8e8e8;
    }
    .map-print-host iframe {
      border: 0;
      width: 100%;
      flex: 1;
      min-height: 0;
    }
    .map-print-host [role="status"] {
      position: absolute;
      top: 45%;
      left: 10%;
      right: 10%;
      text-align: center;
    }
  `;
  const header = node("header");
  header.className = "print-header";
  header.append(
    node("span", "印刷プレビュー"),
    action("閉じる", () => dispose()),
  );
  dialog.append(header);
  const status = node("div");
  status.setAttribute("role", "status");
  status.className = "print-loading";
  dialog.append(status);
  document.head.append(style);
  (options.container || document.body).append(dialog);
  let frame: HTMLIFrameElement,
    timer: ReturnType<typeof setTimeout>,
    controller: AbortController,
    nativeDispose: (() => void) | undefined;
  let disposed = false,
    initialized = false,
    ready = false,
    snapshotSent = false,
    state: PrintMapState | ShareMapSnapshot | Record<string, unknown> | null = null,
    session = "",
    failed = false;
  const fail = (message: string) => {
    if (disposed) return;
    failed = true;
    clearTimeout(timer);
    if (options.snapshot) {
      controller.abort();
      state = null;
      frame.remove();
    }
    nativeDispose?.();
    status.hidden = false;
    status.replaceChildren(node("p", message), action("再試行", start));
  };
  const send = () => {
    if (!ready || !state || failed || (options.snapshot && snapshotSent)) return;
    try {
      frame.contentWindow?.postMessage(
        correlated
          ? { type: "printInitialize", requestId: session, snapshot: state }
          : { type: "printInitialize", state },
        origin,
      );
      if (options.snapshot) {
        snapshotSent = true;
        state = null;
      }
    } catch {
      fail("印刷データを転送できませんでした。対象を絞って再試行してください。");
    }
  };
  function start() {
    controller?.abort();
    nativeDispose?.();
    clearTimeout(timer);
    frame?.remove();
    controller = new AbortController();
    const signal = controller.signal;
    session = `print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    initialized = ready = failed = snapshotSent = false;
    state = null;
    status.hidden = false;
    if (!status.isConnected) dialog.append(status);
    status.textContent = "印刷プレビューを準備しています…";
    frame = node("iframe");
    frame.title = "地図の印刷プレビュー";
    frame.name = session;
    frame.setAttribute("allow", "web-share");
    if (options.snapshot) frame.setAttribute("referrerpolicy", "no-referrer");
    dialog.append(frame);
    timer = setTimeout(
      () => fail("印刷プレビューを読み込めませんでした。"),
      options.answer ? 60000 : 15000,
    );
    void options
      .getState(signal)
      .then((value) => {
        if (signal.aborted || disposed) return;
        state = options.snapshot ? value : JSON.parse(JSON.stringify(value));
        send();
      })
      .catch((e) => {
        if (!signal.aborted) fail((e as Error).message);
      });
    if (options.answer) nativeDispose = options.answer.initialize(frame, session, fail);
    else frame.src = options.url;
  }
  const receive = (event: MessageEvent) => {
    const source = frame?.contentWindow;
    if (
      disposed ||
      !source ||
      event.source !== source ||
      event.origin !== origin ||
      (correlated && event.data?.requestId !== session)
    )
      return;
    if (event.data?.type === "printReady") {
      ready = true;
      send();
    } else if (event.data?.type === "printInitialized") {
      if (options.snapshot && (!snapshotSent || failed || initialized)) return;
      initialized = true;
      clearTimeout(timer);
      nativeDispose?.();
      status.remove();
      frame.focus();
    } else if (event.data?.type === "printClose") {
      if (!options.snapshot || initialized) dispose();
    } else if (event.data?.type === "printError") {
      if (!options.snapshot || (snapshotSent && !initialized && !failed))
        fail("印刷用の地図を作成できませんでした。");
    }
  };
  const key = (event: KeyboardEvent) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.key.toLowerCase() !== "p" ||
      event.altKey ||
      event.shiftKey ||
      event.isComposing
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (initialized && !failed && !event.repeat)
      frame.contentWindow?.postMessage(
        { type: "printExecute", ...(correlated ? { requestId: session } : {}) },
        origin,
      );
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    controller?.abort();
    clearTimeout(timer);
    nativeDispose?.();
    window.removeEventListener("message", receive);
    window.removeEventListener("keydown", key, true);
    dialog.close();
    dialog.remove();
    style.remove();
    previous?.focus();
    options.close();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dispose();
  });
  window.addEventListener("message", receive);
  window.addEventListener("keydown", key, true);
  dialog.showModal();
  start();
  return { dispose };
}
