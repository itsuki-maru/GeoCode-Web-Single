import { createReadOnlySnapshotPrintPreview } from "../map/print/print-preview";
import { isReadOnlyPrintSnapshot } from "../map/print/read-only-print-snapshot";

const parent = window.parent;
const parentOrigin = location.origin;
const requestId = window.name;

if (parent !== window && requestId.startsWith("print-")) {
  const session = { parentOrigin, requestId };
  const send = (type: string) => parent.postMessage({ type, requestId }, parentOrigin);
  const cleanup = () => window.removeEventListener("message", receive);
  const receive = (event: MessageEvent) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      event.data?.type !== "printInitialize" ||
      event.data.requestId !== requestId
    )
      return;
    cleanup();
    try {
      const snapshot = event.data.snapshot;
      if (!isReadOnlyPrintSnapshot(snapshot)) {
        send("printError");
        return;
      }
      createReadOnlySnapshotPrintPreview(snapshot, () => send("printClose"), session);
      send("printInitialized");
    } catch {
      send("printError");
    }
  };
  window.addEventListener("message", receive);
  window.addEventListener("pagehide", cleanup, { once: true });
  send("printReady");
}
