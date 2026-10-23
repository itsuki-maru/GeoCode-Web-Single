import type { FormAnswerMapBootstrap } from "./types";
import { createAnswerPrintSnapshot } from "./print/answer-print-state";

/** Only this dedicated iframe accepts answer filters. Cached layers are retained. */
export function installAnswerFilter(
  runtime: any,
  preview: FormAnswerMapBootstrap["answerPreview"],
  leaflet: any,
  bootstrap?: FormAnswerMapBootstrap,
) {
  const initial = new Set(preview.targets || []);
  let allowed = initial;
  let lastUpdate = "";
  let printEnabled = false;
  const layerFor = (key: string) => {
    const [kind, id] = key.split(":");
    return kind === "marker" ? runtime.markers[`marker-${id}`] : runtime.shapeLayers[`shape-${id}`];
  };
  const isVisible = (key: string) => {
    const layer = layerFor(key);
    return (
      !!layer &&
      (key.startsWith("marker:")
        ? runtime.map.hasLayer(runtime.visibleMarkerGroup) &&
          runtime.visibleMarkerGroup.hasLayer(layer)
        : runtime.map.hasLayer(layer))
    );
  };
  const counts = () => ({
    renderable: [...allowed].filter((key) => !!layerFor(key)).length,
    visible: [...allowed].filter(isVisible).length,
  });
  const send = (type: string, extra: Record<string, unknown> = {}) =>
    window.parent.postMessage(
      { type, requestId: preview.requestId, ...extra },
      preview.parentOrigin,
    );
  const visibleTargets = () => [...allowed].filter(isVisible);
  const fit = () => {
    const bounds = leaflet.latLngBounds([]);
    for (const key of allowed) {
      if (!isVisible(key)) continue;
      const layer = layerFor(key),
        extent = layer.getBounds?.(),
        point = layer.getLatLng?.();
      if (extent?.isValid()) bounds.extend(extent);
      else if (point) bounds.extend(point);
    }
    if (bounds.isValid()) runtime.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
  };
  const onMessage = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== preview.parentOrigin ||
      event.data?.requestId !== preview.requestId
    )
      return;
    if (event.data.type === "answer-map-print-enable") {
      printEnabled = event.data.enabled === true;
      return;
    }
    if (event.data.type === "answer-map-csv-request") {
      const csvRequestId = event.data.csvRequestId;
      if (typeof csvRequestId !== "string" || csvRequestId.length > 128) return;
      try {
        if (!printEnabled || event.data.updateId !== lastUpdate)
          throw new Error("地図の更新完了後に再試行してください。");
        const targets = visibleTargets();
        if (!targets.length || targets.length > 10000)
          throw new Error("CSVの表示対象がありません。地図の表示を確認してください。");
        send("answer-map-csv-targets", { csvRequestId, updateId: lastUpdate, targets });
      } catch (error) {
        send("answer-map-csv-error", {
          csvRequestId,
          message: error instanceof Error ? error.message : "CSV対象を取得できませんでした。",
        });
      }
      return;
    }
    if (event.data.type === "answer-map-print-request") {
      const printRequestId = event.data.printRequestId;
      if (typeof printRequestId !== "string" || printRequestId.length > 128) return;
      try {
        if (!printEnabled || !bootstrap || event.data.updateId !== lastUpdate)
          throw new Error("地図の更新完了後に再試行してください。");
        const snapshot = createAnswerPrintSnapshot(bootstrap, runtime, visibleTargets());
        send("answer-map-print-state", { printRequestId, updateId: lastUpdate, snapshot });
      } catch (error) {
        send("answer-map-print-error", {
          printRequestId,
          message: error instanceof Error ? error.message : "印刷対象を取得できませんでした。",
        });
      }
      return;
    }
    if (event.data.type === "answer-map-fit") {
      fit();
      return;
    }
    if (event.data.type !== "answer-map-filter") return;
    const { targets, updateId } = event.data;
    if (typeof updateId !== "string" || updateId.length > 128) return;
    if (
      !Array.isArray(targets) ||
      targets.length > 10000 ||
      targets.some((k) => typeof k !== "string" || !initial.has(k)) ||
      new Set(targets).size !== targets.length
    ) {
      send("answer-map-filter-error", { updateId, message: "地図の対象情報が不正です。" });
      return;
    }
    try {
      runtime.setAnswerTargets(targets);
      allowed = new Set(targets);
      lastUpdate = updateId;
      send("answer-map-filter-applied", { updateId, ...counts() });
    } catch {
      send("answer-map-filter-error", { updateId, message: "地図の表示を更新できませんでした。" });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => send("answer-map-filter-visible", { updateId: lastUpdate, ...counts() }),
      50,
    );
  };
  window.addEventListener("message", onMessage);
  const onKey = (event: KeyboardEvent) => {
    if (
      !printEnabled ||
      !(event.ctrlKey || event.metaKey) ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      event.key.toLowerCase() !== "p"
    )
      return;
    event.preventDefault();
    if (!event.repeat) send("answer-map-print-open");
  };
  window.addEventListener("keydown", onKey);
  runtime.map.on("layeradd layerremove overlayadd overlayremove answerfilterchange", update);
  runtime.map.on("unload", () => {
    clearTimeout(timer);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("message", onMessage);
    runtime.map.off("layeradd layerremove overlayadd overlayremove answerfilterchange", update);
  });
  return { counts };
}
