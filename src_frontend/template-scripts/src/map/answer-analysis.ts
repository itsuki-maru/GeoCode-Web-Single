import { escapeHtml } from "./common/marker";

export interface AnswerAnalysis {
  active: boolean;
  forms: { id: string; label: string }[];
  forms_overflow: boolean;
  fields: { id: string; label: string; field_type: string; choices: string[] }[];
  field_label: string;
  legend: { label: string; color: string; count: number }[];
  targets: Record<string, { bucket: number; value: string | null; answered_at: string | null }>;
}

/** Analysis styles only live in this iframe. Reloading without analysis restores saved styles. */
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
        !!layer &&
        (kind === "marker"
          ? runtime.map.hasLayer(runtime.visibleMarkerGroup) &&
            runtime.visibleMarkerGroup.hasLayer(layer)
          : runtime.map.hasLayer(layer));
      if (visible && counts[target.bucket] !== undefined) counts[target.bucket]++;
    }
    return counts;
  };
  if (!data.active) return { visibleCounts };
  for (const [key, target] of Object.entries(data.targets)) {
    const [kind, id] = key.split(":");
    const bucket = data.legend[target.bucket];
    if (!bucket || !/^#[0-9a-f]{6}$/i.test(bucket.color)) continue;
    const layer =
      kind === "marker" ? runtime.markers[`marker-${id}`] : runtime.shapeLayers[`shape-${id}`];
    if (!layer) continue;
    const value = target.value;
    const text = `${data.field_label}: ${value ?? bucket.label}（${bucket.label}）`;
    const date = target.answered_at
      ? `使用した回答: ${target.answered_at}`
      : "選択フォームの該当回答なし";
    const html = `<section class="answer-analysis-value"><strong>${escapeHtml(text)}</strong><br>${escapeHtml(date)}</section>`;
    runtime.popupContent?.setAnalysis(key, html);
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
      layer.shapeStyle = style; // Hover restoration must restore the analysis style too.
      layer.setStyle?.(style);
      runtime.shapeNameLabelManager?.invalidate(layer);
      const markdownEscape = (s: string) => s.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, "\\$&");
      if (!runtime.popupContent)
        layer.shapeMemo = `### 分析に使用した回答\n\n${markdownEscape(text)}\n\n${markdownEscape(date)}\n\n---\n\n${layer.shapeMemo || ""}`;
    }
  }
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
  runtime.map.on("unload", () => {
    clearTimeout(timer);
    runtime.map.off("layeradd layerremove overlayadd overlayremove moveend", update);
  });
  return { visibleCounts };
}
