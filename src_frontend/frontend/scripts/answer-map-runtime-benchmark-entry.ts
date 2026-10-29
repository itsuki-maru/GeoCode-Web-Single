// @ts-nocheck -- diagnostics are bundled separately from the shipped application.
import "../../template-scripts/src/entries/form-answer-map";
import { createAnswerPrintSnapshot, isAnswerPrintSnapshot, MAX_ANSWER_PRINT_BYTES } from "../../template-scripts/src/map/print/answer-print-state";

const runtime = window.__answerMapRuntime;
const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__;
if (!runtime) throw new Error("Benchmark map initialization failed");
const painted = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
const settle = async () => {
  await runtime.shapeRenderer.whenIdle();
  await painted();
  if (runtime.shapeRenderer.getStats().pendingCount) await runtime.shapeRenderer.whenIdle();
  await painted();
};
const counts = () => {
  const stats = runtime.shapeRenderer.getStats();
  const coloring = runtime.answerColoring?.getState();
  const ruleCounts = coloring?.rules.map(() => 0) || [];
  const ruleIndexes = new Map(coloring?.rules.map((rule, index) => [rule.id, index]) || []);
  for (const ruleId of Object.values(coloring?.targets || {})) {
    const index = ruleIndexes.get(ruleId);
    if (index !== undefined) ruleCounts[index]++;
  }
  return {
    ...stats,
    logicalVisibleShapes: runtime.getVisibleShapeIds().length,
    logicalVisibleMarkers: runtime.visibleMarkerGroup.getLayers().length,
    svgPaths: document.querySelectorAll(".leaflet-overlay-pane path").length,
    markerElements: document.querySelectorAll(".leaflet-marker-icon").length,
    popupElements: document.querySelectorAll(".leaflet-popup").length,
    coloringRules: coloring?.rules.length || 0,
    coloredTargets: Object.keys(coloring?.targets || {}).length,
    coloringClassCounts: ruleCounts,
    mobileControls: document.body.classList.contains("map-mobile-controls"),
    zoom: runtime.map.getZoom(),
  };
};
window.__answerMapRuntimeBenchmark = {
  counts,
  pending: () => runtime.shapeRenderer.getStats().pendingCount,
  settle,
  async move(operation: string) {
    if (operation === "pan") runtime.map.panBy([160, 90], { animate: false });
    else if (operation === "zoomIn") runtime.map.setZoom(Math.min(18, runtime.map.getZoom() + 2), { animate: false });
    else if (operation === "zoomOut") runtime.map.setZoom(Math.max(6, runtime.map.getZoom() - 2), { animate: false });
    await settle();
  },
  async legendMask(enabled: boolean, limit = 1000) {
    runtime.setLegendHiddenTargets(enabled ? bootstrap.answerPreview.targets.slice(limit) : []);
    await settle();
  },
  async popup() {
    const layers = Object.values(runtime.shapeLayers).filter((layer: any) => runtime.map.hasLayer(layer));
    const layer: any = layers[0] || runtime.visibleMarkerGroup.getLayers()[0];
    if (!layer) return { available: false, opened: false };
    const center = layer.getBounds?.().getCenter?.() || layer.getLatLng?.();
    if (layers.length) layer.fire("click", { latlng: center });
    else layer.openPopup?.(center);
    await painted();
    await new Promise((done) => setTimeout(done, 100));
    const node = document.querySelector(".leaflet-popup-content");
    const details = node?.querySelector("details");
    if (details) {
      details.open = true;
      await painted();
      await new Promise((done) => setTimeout(done, 100));
    }
    const result = { available: true, opened: !!node, expandedDetails: details?.open || false, contentCharacters: node?.textContent?.length || 0 };
    runtime.map.closePopup();
    await settle();
    return result;
  },
  printProbe() {
    const started = performance.now();
    const keys = [...Object.keys(bootstrap.markers).map((id) => `marker:${id}`), ...runtime.getVisibleShapeIds().map((id) => `shape:${id}`)];
    const measurement = { active: true, bytes: null, structurallyValid: false };
    window.__answerPrintMeasurement = measurement;
    let accepted = false, capacityRejected = false;
    try {
      createAnswerPrintSnapshot(bootstrap, runtime, keys);
      accepted = true;
    } catch {
      capacityRejected = measurement.structurallyValid && measurement.bytes > MAX_ANSWER_PRINT_BYTES;
      if (!capacityRejected) throw new Error("Unexpected print snapshot rejection");
    } finally {
      delete window.__answerPrintMeasurement;
    }
    return { ms: performance.now() - started, targets: keys.length, accepted, bytes: measurement.bytes, structurallyValid: measurement.structurallyValid, capacityRejected, capacityBytes: MAX_ANSWER_PRINT_BYTES };
  },
  guardProbe() {
    // Synthetic overflow verifies the retained byte guard independently of the real file size.
    const keys = bootstrap.answerPreview.targets.slice(0, 1);
    const snapshot = createAnswerPrintSnapshot(bootstrap, runtime, keys);
    const firstMarker: any = Object.values(snapshot.bootstrap.markers)[0];
    if (firstMarker) firstMarker.detail = "x".repeat(MAX_ANSWER_PRINT_BYTES + 1);
    else snapshot.bootstrap.shapes[0].geojson.properties = { memo: "x".repeat(MAX_ANSWER_PRINT_BYTES + 1) };
    const measurement = { active: true, bytes: null, structurallyValid: false };
    window.__answerPrintMeasurement = measurement;
    try {
      return { rejected: !isAnswerPrintSnapshot(snapshot), ...measurement, capacityBytes: MAX_ANSWER_PRINT_BYTES };
    } finally {
      delete window.__answerPrintMeasurement;
    }
  },
};
