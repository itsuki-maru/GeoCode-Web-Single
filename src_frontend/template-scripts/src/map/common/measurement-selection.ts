interface Shape {
  shapeType?: string;
  getElement?(): Element | null;
}

interface Dependencies<T extends Shape> {
  getEnabled(): boolean;
  isVisible(layer: T): boolean;
  measure(layer: T): { area: number; distance: number };
  formatArea(value: number): string;
  formatDistance(value: number): string;
  refresh(): void;
  closePopup(): void;
  stopEvent(event: unknown): void;
}

// 表示範囲ではなく選択集合から集計する。画面外へ移動しても合計を維持する。
export function createMeasurementSelection<T extends Shape>(deps: Dependencies<T>) {
  const selected = new Set<T>();
  let active = false;
  let type: string | null = null;
  let summary: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let notice = "";
  const names: Record<string, string> = {
    polyline: "線",
    polygon: "ポリゴン",
    rectangle: "四角形",
    circle: "円",
  };
  const update = () => {
    button?.classList.toggle("is-hidden", !deps.getEnabled());
    button?.classList.toggle("is-active", active);
    button?.setAttribute("aria-pressed", String(active));
    selected.forEach((layer) => layer.getElement?.()?.classList.add("is-measurement-selected"));
    if (!summary) return;
    summary.hidden = !deps.getEnabled() || !active;
    summary.classList.toggle("has-selection", selected.size > 0);
    let area = 0;
    let distance = 0;
    selected.forEach((layer) => {
      const value = deps.measure(layer);
      area += value.area;
      distance += value.distance;
    });
    const lines = type
      ? [`${names[type]} ${selected.size}件の合計`]
      : ["計測する図形を選択してください"];
    if (type === "polyline") lines.push(`総延長 ${deps.formatDistance(distance)}`);
    else if (type) {
      lines.push(`面積 ${deps.formatArea(area)}`);
      if (type !== "circle") lines.push(`周長 ${deps.formatDistance(distance)}`);
    }
    if (notice) lines.push(notice);
    summary.replaceChildren(
      ...lines.map((text) => {
        const element = document.createElement("div");
        element.textContent = text;
        return element;
      }),
    );
  };
  const clear = () => {
    selected.forEach((layer) => layer.getElement?.()?.classList.remove("is-measurement-selected"));
    selected.clear();
    type = null;
    active = false;
    notice = "";
    update();
    deps.refresh();
  };
  return {
    clear,
    update,
    bindButton(element: HTMLButtonElement) {
      button = element;
      update();
    },
    bindSummary(element: HTMLElement) {
      summary = element;
      update();
    },
    toggle() {
      if (!deps.getEnabled()) return;
      if (active) clear();
      else {
        active = true;
        deps.closePopup();
        update();
        deps.refresh();
      }
    },
    select(layer: T, event: unknown): boolean {
      if (!active || !deps.getEnabled() || !layer.shapeType || !names[layer.shapeType])
        return false;
      deps.stopEvent(event);
      if (type && type !== layer.shapeType) {
        notice = "最初に選択した図形と同じタイプだけを選択できます。";
        update();
        return true;
      }
      notice = "";
      if (selected.delete(layer)) layer.getElement?.()?.classList.remove("is-measurement-selected");
      else selected.add(layer);
      type = selected.size ? layer.shapeType : null;
      deps.closePopup();
      update();
      deps.refresh();
      return true;
    },
    includes(layer: T) {
      return !active || selected.has(layer);
    },
    summaryOnly(layer: T) {
      return selected.size > 1 && selected.has(layer);
    },
    prune() {
      selected.forEach((layer) => {
        if (!deps.isVisible(layer)) {
          selected.delete(layer);
          layer.getElement?.()?.classList.remove("is-measurement-selected");
        }
      });
      if (!selected.size) type = null;
      update();
      deps.refresh();
    },
  };
}
