import { Parser, parseDocument, DomUtils } from "htmlparser2";
import { capturePopupScroll } from "./popup-layout";
import {
  ownContentResource,
  releaseContentResources,
  withContentResources,
  type ContentResources,
} from "./content-resources";

export const CONTENT_ELEMENT_BUDGET = 400;
export const CONTENT_TEXT_BUDGET = 24_000;
const INPUT_CHUNK_SIZE = 4096;
const OPERATION_BUDGET = 2048;
const FRAME_TIME_BUDGET = 24;
type SanitizeHtml = (html: string) => string;
type HtmlSource = () => IterableIterator<string>;
type SafeNode = ReturnType<typeof parseDocument>["children"][number];
type Operation =
  | { type: "open"; tag: string; attributes: Record<string, string> }
  | { type: "close"; tag: string }
  | { type: "text"; text: string }
  | { type: "checkpoint" };
interface Source {
  create: HtmlSource;
  sanitize: SanitizeHtml;
  instances: Set<Instance>;
}
interface Instance {
  resume(): void;
  dispose(): void;
}
const sources = new Map<string, Source>();
const instances = new WeakMap<HTMLElement, Instance>();

export function registerProgressiveContent(create: HtmlSource, sanitize: SanitizeHtml): string {
  const key = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(16).padStart(8, "0"),
  ).join("");
  sources.set(key, { create, sanitize, instances: new Set() });
  ownContentResource(() => releaseSource(key));
  return `<div class="geocode-progressive-content" data-progressive-content="${key}"></div>`;
}

function releaseSource(key: string): void {
  const source = sources.get(key);
  if (!source) return;
  sources.delete(key);
  for (const instance of [...source.instances]) instance.dispose();
}

export function releaseProgressiveContent(html: string): void {
  for (const match of html.matchAll(/\bdata-progressive-content="([a-f0-9]{32})"/g))
    releaseSource(match[1]!);
}

export function disposeProgressiveContent(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>(".geocode-progressive-content"))
    instances.get(element)?.dispose();
}

function visible(root: HTMLElement): boolean {
  for (let element = root.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement && !element.open) return false;
  }
  return true;
}

function installStyles(documentRoot: Document): void {
  if (documentRoot.getElementById("geocode-progressive-style")) return;
  const style = documentRoot.createElement("style");
  style.id = "geocode-progressive-style";
  style.textContent = `
    .geocode-progressive-content, .geocode-content-scroll { overflow-anchor:none; }
    .geocode-content-controls { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:10px 0; padding:8px 0; font-size:12px; line-height:1.5; }
    .geocode-content-load-more, .geocode-content-load-all { min-height:44px; padding:4px 10px; border:1px solid #94a3b8; border-radius:5px; color:#1e293b; background:#f8fafc; font:inherit; cursor:pointer; touch-action:manipulation; }
    .geocode-content-load-more:focus-visible, .geocode-content-load-all:focus-visible { outline:2px solid #597ba7; outline-offset:2px; }
    @media print { .geocode-content-load-more, .geocode-content-load-all { display:none; } }
  `;
  documentRoot.head.append(style);
}

function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 未表示の HTML の解析にはブラウザーの DOM を使わない。ストリームパーサーは、複数の Markdown ブロックをまたぐ
// 生の HTML の親要素も保持し、script の本文は出力しない。
function operationStream(create: HtmlSource, resources: ContentResources) {
  const iterator = create();
  const queue: Operation[] = [];
  let head = 0;
  let pending = "";
  let offset = 0;
  let ended = false;
  let blocked = 0;
  const parser = new Parser(
    {
      onopentag(tag, attributes) {
        if (blocked || tag === "script") {
          blocked++;
          return;
        }
        queue.push({ type: "open", tag, attributes });
      },
      onclosetag(tag) {
        if (blocked) {
          blocked--;
          return;
        }
        queue.push({ type: "close", tag });
      },
      ontext(text) {
        if (!blocked) queue.push({ type: "text", text });
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  return {
    peek(): Operation | undefined {
      while (head >= queue.length && !ended) {
        queue.length = 0;
        head = 0;
        if (offset >= pending.length) {
          const next = withContentResources(resources, () => iterator.next());
          if (next.done) {
            parser.end();
            ended = true;
            break;
          }
          pending = next.value;
          offset = 0;
        }
        let end = Math.min(pending.length, offset + INPUT_CHUNK_SIZE);
        if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1]!)) end--;
        parser.write(pending.slice(offset, end));
        offset = end;
        // 大きな script 本文など、全体が削除される内容であっても、
        // ソース全体を同期的に走査せず、途中で制御を戻す。
        queue.push({ type: "checkpoint" });
      }
      return queue[head];
    },
    take() {
      const operation = this.peek();
      if (operation) head++;
      return operation;
    },
    dispose() {
      iterator.return?.();
      queue.length = 0;
      pending = "";
      ended = true;
    },
  };
}

export function setupProgressiveContent(
  root: ParentNode,
  setupAddedContent: (root: ParentNode) => void,
): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    ".geocode-progressive-content[data-progressive-content]",
  )) {
    if (!visible(element)) continue;
    const existing = instances.get(element);
    if (existing) {
      existing.resume();
      continue;
    }
    const source = sources.get(element.dataset.progressiveContent!);
    if (!source) continue;
    const documentRoot = element.ownerDocument;
    installStyles(documentRoot);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.matches(".md-detail-contents, .leaflet-popup-content"))
        ancestor.classList.add("geocode-content-scroll");
      if (ancestor.classList.contains("leaflet-popup")) break;
    }
    const body = documentRoot.createElement("div");
    body.className = "geocode-content-body";
    body.id = `geocode-content-${element.dataset.progressiveContent}`;
    const controls = documentRoot.createElement("div");
    controls.className = "geocode-content-controls";
    const button = documentRoot.createElement("button");
    button.className = "geocode-content-load-more";
    button.type = "button";
    button.textContent = "さらに読み込む";
    button.setAttribute("aria-controls", body.id);
    const allButton = documentRoot.createElement("button");
    allButton.className = "geocode-content-load-all";
    allButton.type = "button";
    allButton.textContent = "続きを全て読み込む";
    allButton.setAttribute("aria-controls", body.id);
    const status = documentRoot.createElement("span");
    status.className = "geocode-content-progress";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.tabIndex = -1;
    controls.append(button, allButton, status);
    element.replaceChildren(body);
    const resources: ContentResources = new Set();
    const stream = operationStream(source.create, resources);
    const parents: Array<{ tag: string; parent: HTMLElement }> = [];
    const safeTags = new Map<string, SafeNode[]>();
    let currentParent: HTMLElement = body;
    let disposed = false;
    let loading = false;
    let complete = false;
    let loadAllRequested = false;
    let needsContinuation = false;
    let continuationUserInitiated = false;
    let framePending = false;
    let frameId: number | undefined;
    let continuationFrame: number | undefined;
    let continuationTimer: ReturnType<typeof setTimeout> | undefined;
    let hadMore = false;
    const dimensions = new WeakMap<Element, string>();
    const notify = () => {
      if (disposed || !element.isConnected) return;
      element.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
    };
    const mediaLoaded = (event: Event) => {
      const media = event.target;
      if (!(media instanceof Element) || media.closest(".geocode-progressive-content") !== element)
        return;
      const size =
        media instanceof HTMLImageElement
          ? `${media.naturalWidth}:${media.naturalHeight}`
          : media instanceof HTMLVideoElement
            ? `${media.videoWidth}:${media.videoHeight}`
            : media instanceof HTMLIFrameElement
              ? `${media.width}:${media.height}`
              : undefined;
      if (size === undefined || dimensions.get(media) === size) return;
      dimensions.set(media, size);
      if (framePending) return;
      framePending = true;
      const callback = () => {
        framePending = false;
        notify();
      };
      frameId = documentRoot.defaultView?.requestAnimationFrame(callback) ?? undefined;
      if (frameId === undefined) setTimeout(callback, 0);
    };
    body.addEventListener("load", mediaLoaded, true);
    body.addEventListener("error", mediaLoaded, true);
    body.addEventListener("loadedmetadata", mediaLoaded, true);
    const scheduleContinuation = (): void => {
      if (
        disposed ||
        loading ||
        !needsContinuation ||
        !visible(element) ||
        continuationFrame !== undefined ||
        continuationTimer !== undefined
      )
        return;
      const continueReading = () => {
        continuationFrame = undefined;
        continuationTimer = undefined;
        if (!disposed && needsContinuation) appendBatch(continuationUserInitiated);
      };
      if (documentRoot.defaultView?.requestAnimationFrame)
        continuationFrame = documentRoot.defaultView.requestAnimationFrame(continueReading);
      else continuationTimer = setTimeout(continueReading, 0);
    };
    const appendBatch = (userInitiated = false): void => {
      if (disposed || loading || complete || !visible(element)) return;
      const controlFocused =
        documentRoot.activeElement === button || documentRoot.activeElement === allButton;
      loading = true;
      needsContinuation = false;
      button.disabled = allButton.disabled = true;
      body.setAttribute("aria-busy", "true");
      const restoreScroll = userInitiated ? capturePopupScroll(element) : undefined;
      let elements = 0;
      let characters = 0;
      let operations = 0;
      let yielded = false;
      const started = performance.now();
      const appendSafeNode = (node: SafeNode, parent: HTMLElement): HTMLElement | undefined => {
        if (DomUtils.isTag(node)) {
          const child = documentRoot.createElement(node.name);
          for (const [name, value] of Object.entries(node.attribs)) child.setAttribute(name, value);
          parent.append(child);
          elements += 1 + child.querySelectorAll("*").length;
          for (const nested of node.children) appendSafeNode(nested, child);
          return child;
        }
        if (node.type === "text") {
          parent.append(documentRoot.createTextNode(node.data));
          characters += node.data.length;
        }
        return undefined;
      };
      try {
        for (;;) {
          if (
            operations >= OPERATION_BUDGET ||
            (operations % 32 === 0 && performance.now() - started >= FRAME_TIME_BUDGET)
          ) {
            yielded = true;
            break;
          }
          const operation = stream.peek();
          if (!operation) break;
          operations++;
          if (operation.type === "checkpoint") {
            stream.take();
            continue;
          }
          if (operation.type === "open") {
            if (elements >= CONTENT_ELEMENT_BUDGET || characters >= CONTENT_TEXT_BUDGET) break;
            stream.take();
            const markup = `<${operation.tag}${Object.entries(operation.attributes)
              .map(([name, value]) => ` ${name}="${attribute(value)}"`)
              .join("")}>`;
            let sanitized = safeTags.get(markup);
            if (!sanitized) {
              sanitized = parseDocument(source.sanitize(markup), { decodeEntities: true }).children;
              if (safeTags.size < 128) safeTags.set(markup, sanitized);
            }
            const parent = currentParent;
            let target: HTMLElement | undefined;
            for (const node of sanitized) {
              const child = appendSafeNode(node, parent);
              target ??= child;
            }
            parents.push({ tag: operation.tag, parent });
            if (target) currentParent = target;
          } else if (operation.type === "close") {
            stream.take();
            const index = parents.findLastIndex((parent) => parent.tag === operation.tag);
            if (index !== -1) {
              currentParent = parents[index]!.parent;
              parents.length = index;
            }
          } else {
            const remaining = CONTENT_TEXT_BUDGET - characters;
            if (remaining <= 0) break;
            let end = Math.min(remaining, operation.text.length);
            if (end < operation.text.length && /[\uD800-\uDBFF]/.test(operation.text[end - 1]!))
              end--;
            if (!end) break;
            const text = operation.text.slice(0, end);
            const previous = currentParent.lastChild;
            if (previous?.nodeType === Node.TEXT_NODE) previous.textContent += text;
            else currentParent.append(documentRoot.createTextNode(text));
            characters += text.length;
            if (end === operation.text.length) stream.take();
            else operation.text = operation.text.slice(end);
          }
        }
        complete = !stream.peek();
        needsContinuation =
          !complete && (loadAllRequested || (yielded && elements === 0 && characters === 0));
        continuationUserInitiated = userInitiated;
        if (complete) loadAllRequested = false;
        button.hidden = allButton.hidden = complete;
        const statusText = needsContinuation ? "読み込み中…" : complete ? "すべて表示しました" : "";
        if (status.textContent !== statusText) status.textContent = statusText;
        if (!complete || hadMore) {
          if (controls.parentElement !== element) element.append(controls);
        }
        hadMore ||= !complete;
        if ((complete || needsContinuation) && controlFocused)
          status.focus({ preventScroll: true });
        setupAddedContent(element);
        element.dispatchEvent(new Event("change", { bubbles: true }));
        notify();
      } catch (error) {
        loadAllRequested = false;
        needsContinuation = false;
        throw error;
      } finally {
        restoreScroll?.();
        loading = false;
        button.disabled = allButton.disabled = needsContinuation;
        if (!needsContinuation) body.removeAttribute("aria-busy");
        scheduleContinuation();
      }
    };
    const instance: Instance = {
      resume: scheduleContinuation,
      dispose() {
        if (disposed) return;
        disposed = true;
        needsContinuation = false;
        loadAllRequested = false;
        if (frameId !== undefined) documentRoot.defaultView?.cancelAnimationFrame(frameId);
        if (continuationFrame !== undefined)
          documentRoot.defaultView?.cancelAnimationFrame(continuationFrame);
        if (continuationTimer !== undefined) clearTimeout(continuationTimer);
        body.removeEventListener("load", mediaLoaded, true);
        body.removeEventListener("error", mediaLoaded, true);
        body.removeEventListener("loadedmetadata", mediaLoaded, true);
        stream.dispose();
        releaseContentResources(resources);
        source.instances.delete(instance);
        instances.delete(element);
        safeTags.clear();
      },
    };
    instances.set(element, instance);
    source.instances.add(instance);
    const canRequest = () => !disposed && !loading && !needsContinuation && !complete;
    button.addEventListener("click", () => {
      if (canRequest()) appendBatch(true);
    });
    allButton.addEventListener("click", () => {
      if (!canRequest() || !visible(element)) return;
      loadAllRequested = true;
      appendBatch(true);
    });
    for (const type of ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "wheel"])
      controls.addEventListener(type, (event) => event.stopPropagation());
    appendBatch();
  }
}
