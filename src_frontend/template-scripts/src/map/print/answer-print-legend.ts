import type { AnswerColoring } from "../answer-coloring";
import { makeSummaryDraggable } from "../common/draggable-summary";
import type { FormAnswerMapBootstrap } from "../types";

/** 凡例は独立した表示マスクを管理し、元のオブジェクトは変更しない。 */
export function createAnswerPrintLegend(options: {
  coloring: AnswerColoring;
  bootstrap: FormAnswerMapBootstrap;
  mapElement: HTMLElement;
  settings: HTMLElement;
  setHiddenTargets: (keys: string[]) => void;
  onChange: () => void;
}) {
  const { coloring, bootstrap, mapElement, settings, setHiddenTargets, onChange } = options;
  const controls = document.createElement("section");
  controls.className = "answer-print-legend-settings";
  controls.setAttribute("aria-label", "色分けの凡例設定");
  const heading = document.createElement("h2");
  heading.textContent = "色分けの凡例";
  controls.append(heading);
  const toggle = (text: string, checked: boolean) => {
    const label = document.createElement("label");
    label.className = "answer-print-legend-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    label.append(input, document.createTextNode(text));
    return { label, input };
  };
  const show = toggle("凡例を表示", true);
  const link = toggle("地図と連動", false);
  const fontLabel = document.createElement("label");
  fontLabel.className = "print-field";
  fontLabel.append(document.createTextNode("凡例の文字サイズ"));
  const fontSize = document.createElement("select");
  fontSize.setAttribute("aria-label", "凡例の文字サイズ");
  for (let value = 8; value <= 32; value++) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value}px`;
    fontSize.append(option);
  }
  fontSize.value = "12";
  fontLabel.append(fontSize);
  const help = document.createElement("p");
  help.className = "print-help";
  help.textContent =
    "凡例の見出しをドラッグして移動し、右下をドラッグして大きさを変更できます。地図との連動は分類ごとのチェックに適用します。";
  const warning = document.createElement("p");
  warning.className = "answer-print-legend-warning";
  warning.setAttribute("role", "status");
  warning.hidden = true;
  warning.textContent =
    "凡例が枠に収まりません。枠を広げるか、文字を小さくするか、分類を減らしてください。";
  const choices = document.createElement("div");
  choices.className = "answer-print-legend-choices";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "凡例の項目");
  controls.append(show.label, link.label, fontLabel, help, warning, choices);
  settings.append(controls);

  const panel = document.createElement("section");
  panel.className = "answer-print-legend";
  panel.setAttribute("aria-label", "色分けの凡例");
  panel.style.fontSize = "12px";
  const title = document.createElement("strong");
  title.className = "answer-print-legend-handle";
  title.textContent = "凡例";
  const entries = document.createElement("ul");
  panel.append(title, entries);
  mapElement.append(panel);

  const available = new Set([
    ...Object.values(bootstrap.markers).map((m) => `marker:${m.id}`),
    ...bootstrap.shapes.map((s) => `shape:${s.id}`),
  ]);
  const rows: { keys: string[]; input: HTMLInputElement; entry: HTMLLIElement }[] = [];
  const entryFragment = document.createDocumentFragment();
  const choiceFragment = document.createDocumentFragment();
  for (const rule of coloring.rules) {
    const keys = Object.entries(coloring.targets)
      .filter(([key, ruleId]) => ruleId === rule.id && available.has(key))
      .map(([key]) => key);
    if (!keys.length) continue;
    const entry = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "answer-print-legend-swatch";
    swatch.style.backgroundColor = rule.color;
    entry.append(swatch, document.createTextNode(rule.label));
    entryFragment.append(entry);
    const choice = toggle(rule.label, true);
    choice.label.prepend(swatch.cloneNode());
    choiceFragment.append(choice.label);
    rows.push({ keys, input: choice.input, entry });
  }
  entries.append(entryFragment);
  choices.append(choiceFragment);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "print-help";
    empty.textContent = "印刷対象に色分けされた地図オブジェクトはありません。";
    controls.append(empty);
  }
  const updatePanel = () => {
    let any = false;
    for (const row of rows) {
      row.entry.hidden = !row.input.checked;
      any ||= row.input.checked;
    }
    panel.hidden = !show.input.checked || !any;
  };
  let disposed = false;
  let previousHidden = "[]";
  const hasOverflow = () => {
    const overflow =
      !disposed &&
      !panel.hidden &&
      (panel.scrollHeight > panel.clientHeight + 1 || panel.scrollWidth > panel.clientWidth + 1);
    warning.hidden = !overflow;
    return overflow;
  };
  const update = () => {
    updatePanel();
    panel.style.fontSize = `${fontSize.value}px`;
    const hidden = link.input.checked
      ? rows.filter((r) => !r.input.checked).flatMap((r) => r.keys)
      : [];
    const signature = JSON.stringify(hidden);
    if (signature !== previousHidden) {
      setHiddenTargets(hidden);
      previousHidden = signature;
    }
    hasOverflow();
    onChange();
  };
  controls.addEventListener("change", update);
  // 凡例のドラッグで、その下の地図が移動やズームされることを防ぐ。
  const stop = (event: Event) => event.stopPropagation();
  for (const event of ["click", "dblclick", "wheel", "mousedown", "touchstart"])
    panel.addEventListener(event, stop);
  updatePanel();
  const stopDrag = makeSummaryDraggable(panel, mapElement, onChange, { x: 10, y: 10 }, title);
  let previousSize = `${panel.offsetWidth}:${panel.offsetHeight}`;
  const resize = new ResizeObserver(() => {
    if (disposed) return;
    hasOverflow();
    const nextSize = `${panel.offsetWidth}:${panel.offsetHeight}`;
    if (nextSize !== previousSize) {
      previousSize = nextSize;
      onChange();
    }
  });
  resize.observe(mapElement);
  resize.observe(panel);
  return {
    hasOverflow,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopDrag();
      resize.disconnect();
      controls.removeEventListener("change", update);
      for (const event of ["click", "dblclick", "wheel", "mousedown", "touchstart"])
        panel.removeEventListener(event, stop);
      controls.remove();
      panel.remove();
    },
  };
}
