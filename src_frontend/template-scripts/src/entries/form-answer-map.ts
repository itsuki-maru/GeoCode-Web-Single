import { readMapBootstrap } from "../map/bootstrap";
import { initializeReadOnlyMapPage } from "../map/read-only-page";
import { finishAnswerPreview } from "../map/answer-preview";
import { installAnswerFilter } from "../map/answer-filter";

const bootstrap = readMapBootstrap();
if (bootstrap.page !== "form-answer-map") throw new Error("Unexpected answer map page");
try {
  const runtime = initializeReadOnlyMapPage("form-answer-map");
  installAnswerFilter(runtime, bootstrap.answerPreview, (window as any).L, bootstrap);
  finishAnswerPreview(runtime, bootstrap, (window as any).L);
} catch {
  window.parent.postMessage(
    {
      type: "answer-map-error",
      requestId: bootstrap.answerPreview.requestId,
      message: "地図を表示できませんでした。もう一度お試しください。",
    },
    bootstrap.answerPreview.parentOrigin,
  );
}
