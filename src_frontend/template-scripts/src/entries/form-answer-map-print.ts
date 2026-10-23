import { createPrintPreview } from "../map/print/print-preview";
import { isAnswerPrintSnapshot } from "../map/print/answer-print-state";

const session = (window as any).__ANSWER_PRINT_SESSION__ as {
  parentOrigin: string;
  requestId: string;
};
const send = (type: string) =>
  window.parent.postMessage({ type, requestId: session.requestId }, session.parentOrigin);
const receive = (event: MessageEvent) => {
  if (
    event.source !== window.parent ||
    event.origin !== session.parentOrigin ||
    event.data?.type !== "printInitialize" ||
    event.data.requestId !== session.requestId
  )
    return;
  if (!isAnswerPrintSnapshot(event.data.snapshot)) {
    send("printError");
    return;
  }
  window.removeEventListener("message", receive);
  try {
    const snapshot = event.data.snapshot;
    window.__GEOCODE_MAP_BOOTSTRAP__ = snapshot.bootstrap;
    createPrintPreview(snapshot.state, () => send("printClose"), "form-answer-map", session);
    send("printInitialized");
  } catch {
    send("printError");
  }
};
window.addEventListener("message", receive);
window.addEventListener("pagehide", () => window.removeEventListener("message", receive), {
  once: true,
});
send("printReady");
