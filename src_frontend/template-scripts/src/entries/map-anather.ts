import { initializeReadOnlyMapPage } from "../map/read-only-page";
import { initializePrintPreview } from "../map/print/print-preview";

if (new URLSearchParams(window.location.search).get("print") === "1") {
  initializePrintPreview();
} else {
  initializeReadOnlyMapPage("map-anather");
}
