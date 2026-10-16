interface Shape {
  shapeType?: string;
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
  const touchTimes = new WeakMap<T, number>();
  let showSummary = false;
  let summary: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  const names: Record<string, string> = {
    polyline: "線",
    polygon: "ポリゴン",
    rectangle: "四角形",
    circle: "円",
  };
  const update = () => {
    button?.classList.toggle("is-hidden", !deps.getEnabled());
    button?.classList.toggle("is-active", showSummary);
    button?.setAttribute("aria-pressed", String(showSummary));
    if (!summary) return;
    summary.hidden = !deps.getEnabled() || !showSummary;
    summary.classList.toggle("has-selection", selected.size > 0);
    // Set の挿入順を使い、残っている最初の図形と同じタイプだけを集計する。
    const type = selected.values().next().value?.shapeType;
    let count = 0;
    let area = 0;
    let distance = 0;
    selected.forEach((layer) => {
      if (layer.shapeType !== type) return;
      count += 1;
      const value = deps.measure(layer);
      area += value.area;
      distance += value.distance;
    });
    const lines = type ? [`${names[type]} ${count}件の合計`] : ["計測する図形を選択してください"];
    if (type === "polyline") lines.push(`総延長 ${deps.formatDistance(distance)}`);
    else if (type) {
      lines.push(`面積 ${deps.formatArea(area)}`);
      if (type !== "circle") lines.push(`周長 ${deps.formatDistance(distance)}`);
    }
    summary.replaceChildren(
      ...lines.map((text) => {
        const element = document.createElement("div");
        element.textContent = text;
        return element;
      }),
    );
  };
  const clear = () => {
    selected.clear();
    showSummary = false;
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
      showSummary = !showSummary;
      deps.closePopup();
      update();
      deps.refresh();
    },
    select(layer: T, event: unknown): boolean {
      if (!deps.getEnabled() || !layer.shapeType || !names[layer.shapeType]) return false;
      deps.stopEvent(event);
      const original = (event as { originalEvent?: { type?: string } })?.originalEvent || event;
      const eventType = (original as { type?: string })?.type;
      const touchTime = touchTimes.get(layer);
      if (eventType === "click" && touchTime !== undefined && Date.now() - touchTime < 500)
        return true;
      if (eventType === "touchend") touchTimes.set(layer, Date.now());
      if (!selected.delete(layer)) selected.add(layer);
      deps.closePopup();
      update();
      deps.refresh();
      return true;
    },
    includes(layer: T) {
      return selected.has(layer);
    },
    prune() {
      selected.forEach((layer) => {
        if (!deps.isVisible(layer)) {
          selected.delete(layer);
        }
      });
      update();
      deps.refresh();
    },
  };
}
