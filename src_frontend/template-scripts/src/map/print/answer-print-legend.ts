import type { AnswerColoring } from "../answer-coloring";
import { createColorLegend } from "../common/color-legend";
import type { AnotherMapBootstrap } from "../types";

/** 凡例は独立した表示マスクを管理し、元のオブジェクトは変更しない。 */
export function createAnswerPrintLegend(options: {
  coloring: AnswerColoring;
  bootstrap: Pick<AnotherMapBootstrap, "markers" | "shapes">;
  getAvailableTargetKeys?: () => ReadonlySet<string>;
  subscribe?: (refresh: () => void) => () => void;
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

  const available =
    options.getAvailableTargetKeys?.() ||
    new Set([
      ...Object.values(bootstrap.markers).map((m) => `marker:${m.id}`),
      ...bootstrap.shapes.map((s) => `shape:${s.id}`),
    ]);
  const rows: {
    keys: string[];
    input: HTMLInputElement;
    label: HTMLLabelElement;
    ruleId: string;
    text: string;
    color: string;
  }[] = [];
  const choiceFragment = document.createDocumentFragment();
  for (const rule of coloring.rules) {
    const keys = Object.entries(coloring.targets)
      .filter(([key, ruleId]) => ruleId === rule.id && available.has(key))
      .map(([key]) => key);
    if (!keys.length && !options.subscribe) continue;
    const swatch = document.createElement("span");
    swatch.className = "answer-print-legend-swatch";
    swatch.style.backgroundColor = rule.color;
    swatch.setAttribute("aria-hidden", "true");
    const choice = toggle(rule.label, true);
    choice.label.prepend(swatch);
    choiceFragment.append(choice.label);
    rows.push({
      keys,
      input: choice.input,
      label: choice.label,
      ruleId: rule.id,
      text: rule.label,
      color: rule.color,
    });
  }
  choices.append(choiceFragment);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "print-help";
    empty.textContent = "印刷対象に色分けされた地図オブジェクトはありません。";
    controls.append(empty);
  }
  const legend = createColorLegend({
    mapElement,
    mode: "print",
    onChange: () => {
      hasOverflow();
      onChange();
    },
  });
  let disposed = false;
  let previousHidden = "[]";
  const hasOverflow = () => {
    const overflow = legend.hasOverflow();
    warning.hidden = !overflow;
    return overflow;
  };
  const updatePanel = () => {
    for (const row of rows) row.label.hidden = !row.keys.length;
    legend.setVisible(show.input.checked);
    legend.setEntries(
      rows.map((row) => ({
        id: row.ruleId,
        label: row.text,
        color: row.color,
        hidden: !row.input.checked || !row.keys.length,
      })),
    );
    legend.setFontSize(Number(fontSize.value));
  };
  const update = () => {
    updatePanel();
    const hidden = link.input.checked
      ? rows.filter((r) => !r.input.checked).flatMap((r) => r.keys)
      : [];
    const signature = JSON.stringify(hidden);
    if (signature !== previousHidden) {
      const previous = previousHidden;
      previousHidden = signature;
      try {
        setHiddenTargets(hidden);
      } catch (error) {
        previousHidden = previous;
        throw error;
      }
    }
    hasOverflow();
    onChange();
  };
  const refresh = () => {
    const keys = options.getAvailableTargetKeys?.() || available;
    let changed = false;
    for (const row of rows) {
      const next = Object.entries(coloring.targets)
        .filter(([key, rule]) => rule === row.ruleId && keys.has(key))
        .map(([key]) => key);
      if (next.length !== row.keys.length || next.some((key, i) => key !== row.keys[i])) {
        row.keys = next;
        changed = true;
      }
    }
    if (changed) update();
  };
  const stopSubscription = options.subscribe?.(refresh);
  controls.addEventListener("change", update);
  updatePanel();
  return {
    hasOverflow,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSubscription?.();
      controls.removeEventListener("change", update);
      controls.remove();
      legend.dispose();
    },
  };
}
