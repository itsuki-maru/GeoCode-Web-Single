/** MJPEG URLs stay inert until their owning Leaflet popup is open. */
export function cameraUrl(raw: string): string | null {
  // URLに空白・バックスラッシュ・制御文字が含まれていたら、不正な入力として null を返す
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return raw;
  } catch {
    return null;
  }
}

export function renderCameraImage(
  token: { href: string; text?: string },
  printing = false,
): string | null {
  if (token.text !== "camera") return null;
  if (printing) return "<span>ライブカメラ（印刷には映像を含みません）</span>";
  const url = cameraUrl(token.href);
  if (!url)
    return "<span>ライブカメラには認証情報を含まないHTTPまたはHTTPS URLを指定してください。</span>";
  const escaped = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
  return `<app-camera data-camera-src="${escaped}">ライブカメラ（ポップアップを開くと表示します）</app-camera>`;
}

type PopupEvent = { popup?: { getElement?(): HTMLElement | undefined } };
interface PopupMap {
  on(name: string, listener: (event: PopupEvent) => void): unknown;
  off(name: string, listener: (event: PopupEvent) => void): unknown;
}

export function installMjpegCameras(map: PopupMap, root: Document = document): () => void {
  const view = root.defaultView!;
  const popups = new Set<HTMLElement>();
  const sessions = new Map<HTMLElement, { stop(): void; url: string }>();
  let printing = false;
  let suspended = false;
  let disposed = false;
  const style = root.createElement("style");
  style.textContent = `
    app-camera { display:block; width:320px; max-width:100%; white-space:normal; }
    app-camera img { display:block; width:100%; aspect-ratio:4/3; max-height:45dvh; object-fit:contain; background:#111; }
    app-camera p { font-size:12px; margin:6px 0; }
    app-camera button { padding:6px 12px; cursor:pointer; }
    @media print { app-camera img, app-camera button, app-camera p { display:none!important; } }
  `;
  root.head.append(style);

  function eligible(host: HTMLElement): boolean {
    if (disposed || printing || suspended || root.hidden || !host.isConnected) return false;
    if (![...popups].some((popup) => popup.isConnected && popup.contains(host))) return false;
    for (let node: HTMLElement | null = host; node; node = node.parentElement) {
      if (node.hidden || (node.tagName === "DETAILS" && !node.hasAttribute("open"))) return false;
    }
    return true;
  }

  function start(host: HTMLElement, url: string) {
    const status = root.createElement("p");
    status.setAttribute("role", "status");
    const retry = root.createElement("button");
    retry.type = "button";
    retry.textContent = "再接続";
    let image: HTMLImageElement | null = null;
    const cancel = () => {
      if (!image) return;
      image.onerror = null;
      image.removeAttribute("src");
      image.remove();
      image = null;
    };
    const connect = () => {
      cancel();
      if (!eligible(host)) return;
      status.textContent = "ライブカメラ（映像が止まった場合は再接続してください）";
      image = root.createElement("img");
      image.alt = "ライブカメラ";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => {
        cancel();
        status.textContent = "映像を取得できません。配信元を確認して再接続してください。";
      };
      host.prepend(image);
      image.src = url;
    };
    retry.onclick = (event) => {
      event.stopPropagation();
      connect();
    };
    host.replaceChildren(status, retry);
    sessions.set(host, {
      url,
      stop: () => {
        cancel();
        retry.onclick = null;
        host.textContent = printing
          ? "ライブカメラ（印刷には映像を含みません）"
          : "ライブカメラ（受信停止中）";
      },
    });
    connect();
  }

  function sync() {
    for (const popup of popups) {
      if (!popup.isConnected) popups.delete(popup);
    }
    for (const [host, session] of sessions) {
      if (!eligible(host) || host.getAttribute("data-camera-src") !== session.url) {
        session.stop();
        sessions.delete(host);
      }
    }
    if (disposed) return;
    for (const popup of popups) {
      for (const host of popup.querySelectorAll<HTMLElement>("app-camera[data-camera-src]")) {
        if (!sessions.has(host) && eligible(host)) {
          const url = cameraUrl(host.getAttribute("data-camera-src") ?? "");
          if (url) start(host, url);
        }
      }
    }
  }
  const open = (event: PopupEvent) => {
    const element = event.popup?.getElement?.();
    if (element) popups.add(element);
    sync();
  };
  const close = (event: PopupEvent) => {
    const element = event.popup?.getElement?.();
    if (element) popups.delete(element);
    sync();
  };
  const beforePrint = () => {
    printing = true;
    sync();
  };
  const afterPrint = () => {
    printing = false;
    sync();
  };
  const pageHide = () => {
    suspended = true;
    sync();
  };
  const pageShow = () => {
    suspended = false;
    sync();
  };
  const observer = new MutationObserver(sync);
  observer.observe(root.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "hidden", "data-camera-src"],
  });
  map.on("popupopen", open);
  map.on("popupclose", close);
  root.addEventListener("visibilitychange", sync);
  view.addEventListener("pagehide", pageHide);
  view.addEventListener("pageshow", pageShow);
  view.addEventListener("beforeprint", beforePrint);
  view.addEventListener("afterprint", afterPrint);
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    sync();
    popups.clear();
    style.remove();
    map.off("popupopen", open);
    map.off("popupclose", close);
    map.off("unload", dispose);
    root.removeEventListener("visibilitychange", sync);
    view.removeEventListener("pagehide", pageHide);
    view.removeEventListener("pageshow", pageShow);
    view.removeEventListener("beforeprint", beforePrint);
    view.removeEventListener("afterprint", afterPrint);
  }
  map.on("unload", dispose);
  return dispose;
}
