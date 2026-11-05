import css from "./map-presets-table.css?inline";
import { node, action } from "./coloring-editor";
import { describeMapPreset, mapPresetKindLabel, type SavedMapPreset } from "./answer-map-presets";

export function renderMapPresetsTable(
  host: HTMLElement,
  options: {
    items: SavedMapPreset[];
    disabled: boolean;
    restoreDisabledReason?(preset: SavedMapPreset): string | undefined;
    restore(preset: SavedMapPreset): void;
    remove(preset: SavedMapPreset): void;
  },
) {
  if (!document.getElementById("map-presets-table-style")) {
    const style = node("style");
    style.id = "map-presets-table-style";
    style.textContent = css;
    document.head.append(style);
  }
  host.classList.add("table-scroll", "map-presets-table");
  const table = node("table");
  table.setAttribute("aria-label", "保存した検索条件一覧");
  const head = node("thead"),
    headers = node("tr");
  for (const name of ["種別", "名前", "共通フォーム", "条件概要", "保存日時", "操作"])
    headers.append(node("th", name));
  head.append(headers);
  const body = node("tbody");
  for (const preset of options.items) {
    const row = node("tr"),
      date = new Date(
        /(?:Z|[+-]\d\d:\d\d)$/i.test(preset.create_at) ? preset.create_at : `${preset.create_at}Z`,
      );
    const values = [
      mapPresetKindLabel(preset.kind),
      preset.name,
      preset.display.form_label || "一覧と同じ範囲",
      describeMapPreset(preset),
      Number.isNaN(date.valueOf()) ? preset.create_at : date.toLocaleString("ja-JP"),
    ];
    values.forEach((value, index) => {
      const cell = node("td", value);
      if (index === 3) cell.className = "preset-description";
      row.append(cell);
    });
    const cell = node("td"),
      controls = node("div");
    controls.className = "row-actions";
    for (const [label, handler] of [
      ["呼び出し", options.restore],
      ["削除", options.remove],
    ] as const) {
      const button = action(label, () => handler(preset));
      button.className = "btn-close";
      const reason = label === "呼び出し" ? options.restoreDisabledReason?.(preset) : undefined;
      button.disabled = options.disabled || !!reason;
      if (reason) {
        button.title = reason;
        button.setAttribute("aria-label", `${label}（${reason}）`);
      }
      controls.append(button);
    }
    cell.append(controls);
    row.append(cell);
    body.append(row);
  }
  table.append(head, body);
  host.replaceChildren(table);
}
