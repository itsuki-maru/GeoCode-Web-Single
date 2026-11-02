import css from "./progress-spinner.css?inline";

// 既存のProgressSpinnerとテンプレートのdialogで同じ図形・アニメーションを使う。
export const progressSpinnerTransform = "rotate(-90 25 25)";
export const progressSpinnerCircle = {
  cx: "25",
  cy: "25",
  r: "20",
  fill: "none",
  stroke: "#76c7c0",
  "stroke-width": "5",
  "stroke-linecap": "round",
  "stroke-dasharray": "31.4 31.4",
} as const;

/** Abort非対応のアダプターでも、待機表示とイベント購読を終了できるようにする。 */
export async function awaitWithAbort<T>(
  value: PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  const abortError = () =>
    Object.assign(new Error("処理が中断されたか、時間がかかりすぎました。再試行してください。"), {
      name: "AbortError",
    });
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(abortError());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve(value)]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** native dialogの最前面にも表示できる、既存スピナーの表示先。 */
export function createProgressDialog() {
  if (!document.getElementById("shared-progress-spinner-style")) {
    const style = document.createElement("style");
    style.id = "shared-progress-spinner-style";
    style.textContent = css;
    document.head.append(style);
  }
  const dialog = document.createElement("dialog");
  dialog.className = "map-progress-dialog";
  dialog.setAttribute("aria-label", "処理中");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spinner shared-progress-spinner");
  svg.setAttribute("width", "50");
  svg.setAttribute("height", "50");
  svg.setAttribute("viewBox", "0 0 50 50");
  svg.setAttribute("aria-hidden", "true");
  const group = document.createElementNS(svg.namespaceURI, "g");
  group.setAttribute("transform", progressSpinnerTransform);
  const circle = document.createElementNS(svg.namespaceURI, "circle");
  for (const [key, value] of Object.entries(progressSpinnerCircle)) circle.setAttribute(key, value);
  group.append(circle);
  svg.append(group);
  dialog.append(svg);
  document.body.append(dialog);
  const tokens = new Set<symbol>();
  const clear = () => {
    tokens.clear();
    if (dialog.open) dialog.close();
  };
  const key = (event: KeyboardEvent) => {
    if (
      dialog.open &&
      (event.key === "Escape" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p"))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  window.addEventListener("keydown", key, true);
  return {
    show(label: string) {
      const token = Symbol();
      tokens.add(token);
      dialog.setAttribute("aria-label", label);
      if (!dialog.open) dialog.showModal();
      return () => {
        tokens.delete(token);
        if (!tokens.size && dialog.open) dialog.close();
      };
    },
    clear,
    dispose() {
      clear();
      window.removeEventListener("keydown", key, true);
      dialog.remove();
    },
  };
}
