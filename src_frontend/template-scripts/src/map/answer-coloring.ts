export interface AnswerColoring {
  version: 1;
  rules: { id: string; label: string; color: string }[];
  targets: Record<string, string>;
}

export interface AnswerColoringController {
  apply(state: AnswerColoring | null): void;
  getState(): AnswerColoring | null;
  dispose(): void;
}

export const MAX_COLORING_RULES = 20;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Accept only bounded, declarative styles; no HTML, arbitrary CSS, or outside objects. */
export function isAnswerColoring(
  value: unknown,
  allowedTargets?: ReadonlySet<string>,
): value is AnswerColoring {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.rules) ||
    value.rules.length === 0 ||
    value.rules.length > MAX_COLORING_RULES ||
    !record(value.targets)
  )
    return false;
  const ids = new Set<string>();
  for (const rule of value.rules) {
    if (
      !record(rule) ||
      typeof rule.id !== "string" ||
      !rule.id.trim() ||
      rule.id.length > 100 ||
      ids.has(rule.id) ||
      typeof rule.label !== "string" ||
      !rule.label.trim() ||
      rule.label.length > 100 ||
      typeof rule.color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(rule.color)
    )
      return false;
    ids.add(rule.id);
  }
  const targets = Object.entries(value.targets);
  return targets.every(
    ([key, rule]) =>
      /^(marker|shape):[^:]{1,128}$/.test(key) &&
      (!allowedTargets || allowedTargets.has(key)) &&
      typeof rule === "string" &&
      ids.has(rule),
  );
}

const clone = (state: AnswerColoring | null): AnswerColoring | null =>
  state ? JSON.parse(JSON.stringify(state)) : null;

/** Styles belong to the answer iframe. Persisted records and popups are never modified. */
export function installAnswerColoring(runtime: any, leaflet: any): AnswerColoringController {
  if (runtime.answerColoring) return runtime.answerColoring;
  let current: AnswerColoring | null = null;
  let disposed = false;
  const originals = new Map<
    string,
    { layer: any; icon?: any; style?: Record<string, unknown>; options?: Record<string, unknown> }
  >();
  const cluster = runtime.visibleMarkerGroup;
  const layerFor = (key: string) => {
    const [kind, id] = key.split(":");
    return kind === "marker" ? runtime.markers[`marker-${id}`] : runtime.shapeLayers[`shape-${id}`];
  };
  const updateShape = (layer: any, style: Record<string, unknown>) => {
    layer.shapeStyle = style;
    layer.setStyle?.(style);
    runtime.applyShapeArrowStyle?.(layer);
    runtime.shapeNameLabelManager?.invalidate(layer);
  };
  const restore = () => {
    for (const [key, original] of originals) {
      if (key.startsWith("marker:")) original.layer.setIcon(original.icon);
      else {
        // Leaflet merges styles, so reset fillColor even if the original style omitted it.
        original.layer.setStyle?.(original.options);
        updateShape(original.layer, { ...original.style });
      }
    }
  };
  const applyToLayer = (
    key: string,
    layer: any,
    rule: AnswerColoring["rules"][number],
    icons: Map<string, unknown>,
  ) => {
    if (!originals.has(key)) {
      originals.set(
        key,
        key.startsWith("marker:")
          ? { layer, icon: layer.options?.icon }
          : {
              layer,
              style: { ...layer.shapeStyle },
              options: {
                color: layer.options?.color ?? layer.shapeStyle?.color,
                fillColor: layer.options?.fillColor ?? layer.shapeStyle?.fillColor ?? null,
              },
            },
      );
    }
    if (key.startsWith("marker:")) {
      if (!icons.has(rule.color)) {
        icons.set(
          rule.color,
          leaflet.divIcon({
            className: "answer-value-marker",
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -12],
            html: `<span style="display:block;width:20px;height:20px;border:2px solid white;border-radius:50%;background:${rule.color};box-shadow:0 0 3px #222"></span>`,
          }),
        );
      }
      layer.setIcon(icons.get(rule.color));
    } else {
      updateShape(layer, {
        ...originals.get(key)!.style,
        color: rule.color,
        fillColor: rule.color,
      });
    }
  };
  const render = (state: AnswerColoring | null) => {
    restore();
    const rules = new Map(state?.rules.map((rule) => [rule.id, rule]) || []);
    const icons = new Map<string, unknown>();
    for (const [key, id] of Object.entries(state?.targets || {})) {
      const layer = layerFor(key);
      if (!layer) continue;
      applyToLayer(key, layer, rules.get(id)!, icons);
    }
    // Classification colors belong to individual objects. Keep the existing
    // cluster renderer so its size, count colors, and any custom styling survive.
    cluster?.refreshClusters?.();
  };
  const stopCreated = runtime.onShapeLayerCreated?.((layer: any, record: { id: string }) => {
    if (disposed || !current) return;
    const key = `shape:${record.id}`;
    const ruleId = current.targets[key];
    const rule = current.rules.find((rule) => rule.id === ruleId);
    if (rule) applyToLayer(key, layer, rule, new Map());
  });
  const stopEvicted = runtime.onShapeLayerEvicted?.((layer: any, record: { id: string }) => {
    const key = `shape:${record.id}`;
    if (originals.get(key)?.layer === layer) originals.delete(key);
  });
  const controller: AnswerColoringController = {
    apply(state: AnswerColoring | null) {
      if (disposed) throw new Error("色分け画面は終了しています。");
      // Invalid geometries may still be present in the answer scope; message validation
      // checks that scope, while this controller simply skips their absent layers.
      if (state !== null && !isAnswerColoring(state)) throw new Error("色分けの設定が不正です。");
      const next = clone(state);
      try {
        render(next);
        current = next;
      } catch (error) {
        render(current);
        throw error;
      }
    },
    getState: () => clone(current),
    dispose() {
      if (disposed) return;
      render(null);
      current = null;
      originals.clear();
      disposed = true;
      stopCreated?.();
      stopEvicted?.();
      runtime.map.off("unload", controller.dispose);
      if (runtime.answerColoring === controller) delete runtime.answerColoring;
    },
  };
  runtime.answerColoring = controller;
  runtime.map.on("unload", controller.dispose);
  return controller;
}
