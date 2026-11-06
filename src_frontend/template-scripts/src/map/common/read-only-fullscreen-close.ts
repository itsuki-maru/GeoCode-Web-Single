import { resolveShareParentOrigin } from "./share-snapshot";

const isMessageId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function installReadOnlyFullscreenClose(trustedOrigins: readonly string[]) {
  const parent = window.parent;
  if (parent === window) return;
  const origin = resolveShareParentOrigin(document.referrer, location.origin, trustedOrigins);
  if (!origin) return;

  let sessionId: number | undefined;
  let lastModalOpen: boolean | undefined;
  const hasOpenDialog = () => document.querySelector("dialog[open]") !== null;
  const publishState = (modalOpen: boolean, force = false) => {
    if (sessionId === undefined || (!force && lastModalOpen === modalOpen)) return;
    lastModalOpen = modalOpen;
    parent.postMessage({ type: "readOnlyFullscreenCloseState", sessionId, modalOpen }, origin);
  };

  // ダイアログは body 直下に追加されるため、地図レイヤの描画更新は監視しない。
  const observeDialogs = () => {
    observer.observe(document.body, { childList: true });
    for (const dialog of document.querySelectorAll("dialog")) {
      observer.observe(dialog, { attributeFilter: ["open"] });
    }
  };
  const observer = new MutationObserver((changes) => {
    if (changes.some((change) => change.type === "childList")) {
      observer.disconnect();
      observeDialogs();
    }
    publishState(hasOpenDialog());
  });

  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== origin) return;
    const data = event.data;
    if (!isMessageId(data?.sessionId)) return;
    if (data.type === "readOnlyFullscreenCloseConnect") {
      if (sessionId === undefined) observeDialogs();
      sessionId = data.sessionId;
      publishState(hasOpenDialog(), true);
      return;
    }
    if (
      data.type !== "readOnlyFullscreenCloseRequest" ||
      data.sessionId !== sessionId ||
      !isMessageId(data.requestId)
    )
      return;

    const modalOpen = hasOpenDialog();
    parent.postMessage(
      { type: "readOnlyFullscreenCloseResult", sessionId, requestId: data.requestId, modalOpen },
      origin,
    );
    publishState(modalOpen);
  };
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) dispose();
  };
  const dispose = () => {
    observer.disconnect();
    window.removeEventListener("message", receive);
    window.removeEventListener("pagehide", onPageHide);
  };
  window.addEventListener("message", receive);
  window.addEventListener("pagehide", onPageHide);
  return dispose;
}
