import { escapeHtml } from "./common/marker";
import { isAnswerShapeVisible } from "./answer-shapes";

export interface AnswerAnalysis {
  active: boolean;
  forms: { id: string; label: string }[];
  forms_overflow: boolean;
  fields: { id: string; label: string; field_type: string; choices: string[] }[];
  field_label: string;
  legend: { label: string; color: string; count: number }[];
  targets: Record<string, { bucket: number; value: string | null; answered_at: string | null }>;
}

/** 分析用スタイルはこの iframe 内だけで有効とし、分析なしで再読み込みすると保存済みのスタイルに戻る。 */
export function installAnswerAnalysis(
  runtime: any,
  data: AnswerAnalysis,
  leaflet: any,
  notify: (counts: number[]) => void,
) {
  const visibleCounts = () => {
    const counts = data.legend.map(() => 0);
    for (const [key, target] of Object.entries(data.targets)) {
      const [kind, id] = key.split(":");
      const layer =
        kind === "marker" ? runtime.markers[`marker-${id}`] : runtime.shapeLayers[`shape-${id}`];
      const visible =
        kind === "shape"
          ? isAnswerShapeVisible(runtime, id)
          : !!layer &&
            runtime.map.hasLayer(runtime.visibleMarkerGroup) &&
            runtime.visibleMarkerGroup.hasLayer(layer);
      if (visible && counts[target.bucket] !== undefined) counts[target.bucket]++;
    }
    return counts;
  };
  if (!data.active) return { visibleCounts };
  const applyTarget = (key: string, layer: any) => {
    const target = data.targets[key];
    if (!target) return;
    const [kind] = key.split(":");
    const bucket = data.legend[target.bucket];
    if (!bucket || !/^#[0-9a-f]{6}$/i.test(bucket.color)) return;
    const value = target.value;
    const text = `${data.field_label}: ${value ?? bucket.label}（${bucket.label}）`;
    const date = target.answered_at
      ? `使用した回答: ${target.answered_at}`
      : "選択フォームの該当回答なし";
    const html = `<section class="answer-analysis-value"><strong>${escapeHtml(text)}</strong><br>${escapeHtml(date)}</section>`;
    runtime.popupContent?.setAnalysis(key, html);
    if (!layer) return;
    if (kind === "marker") {
      layer.setIcon(
        leaflet.divIcon({
          className: "answer-value-marker",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          popupAnchor: [0, -12],
          html: `<span style="display:block;width:20px;height:20px;border:2px solid white;border-radius:50%;background:${bucket.color};box-shadow:0 0 3px #222"></span>`,
        }),
      );
      const popup = layer.getPopup?.();
      const content = popup?.getContent?.();
      if (!runtime.popupContent)
        layer.bindPopup(html + (typeof content === "string" ? content : ""));
    } else {
      const style = { ...(layer.shapeStyle || {}), color: bucket.color, fillColor: bucket.color };
      if (layer.shapeType !== "polyline") Object.assign(style, { fill: true, fillOpacity: 0.3 });
      layer.shapeStyle = style; // ホバー状態から戻すときは、分析用スタイルも復元する。
      layer.setStyle?.(style);
      runtime.shapeNameLabelManager?.invalidate(layer);
      const markdownEscape = (s: string) => s.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, "\\$&");
      if (!runtime.popupContent)
        layer.shapeMemo = `### 分析に使用した回答\n\n${markdownEscape(text)}\n\n${markdownEscape(date)}\n\n---\n\n${layer.shapeMemo || ""}`;
    }
  };
  for (const key of Object.keys(data.targets)) {
    const [kind, id] = key.split(":");
    applyTarget(
      key,
      kind === "marker" ? runtime.markers[`marker-${id}`] : runtime.shapeLayers[`shape-${id}`],
    );
  }
  // 旧形式の分析結果を基本スタイルとし、新しい分類処理はその後に適用する。
  const stopCreated = runtime.onShapeLayerCreated?.(
    (layer: any, record: { id: string }) => applyTarget(`shape:${record.id}`, layer),
    true,
  );
  const cluster = runtime.visibleMarkerGroup;
  if (cluster?.refreshClusters) {
    cluster.options.iconCreateFunction = (group: any) =>
      leaflet.divIcon({
        className: "answer-neutral-cluster",
        iconSize: [38, 38],
        html: `<span style="display:grid;place-items:center;width:36px;height:36px;border:1px solid white;border-radius:50%;background:#555;color:white">${group.getChildCount()}</span>`,
      });
    cluster.refreshClusters();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => notify(visibleCounts()), 50);
  };
  runtime.map.on("layeradd layerremove overlayadd overlayremove moveend", update);
  runtime.map.on("answerfilterchange", update);
  runtime.map.on("unload", () => {
    clearTimeout(timer);
    stopCreated?.();
    runtime.map.off("layeradd layerremove overlayadd overlayremove moveend", update);
    runtime.map.off("answerfilterchange", update);
  });
  return { visibleCounts };
}
