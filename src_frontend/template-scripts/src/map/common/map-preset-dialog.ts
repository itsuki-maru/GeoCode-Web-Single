import { action, node } from "./coloring-editor";
import { createMapMessageDialog } from "./map-message-dialog";
import { renderMapPresetsTable } from "./map-presets-table";
import {
  toV2PresetDraft,
  cloneSavedMapPreset,
  isSavedMapPreset,
  type AnyMapPresetDraft,
  type SavedMapPreset,
} from "./answer-map-presets";
import type { AttributeTransport } from "./advanced-map-search";
import { mapOperationMessages } from "./map-analysis";
import { createProgressDialog, awaitWithAbort } from "./progress-spinner";

export function createMapPresetDialogs(
  transport: AttributeTransport,
  restore: (preset: SavedMapPreset, signal: AbortSignal) => Promise<void>,
  options: {
    filterOnly?: boolean;
    apply?(preset: SavedMapPreset, signal: AbortSignal): Promise<void>;
    preparePage?(items: SavedMapPreset[], signal: AbortSignal): Promise<void>;
  } = {},
) {
  const noticeDialog = createMapMessageDialog(() => syncBusy());
  const dialog = node("dialog"),
    confirmation = node("dialog"),
    notice = noticeDialog.dialog;
  const progressDialog = createProgressDialog();
  dialog.className = "map-preset-dialog form-settings";
  confirmation.className = "map-preset-dialog is-confirm common-form-confirm";
  dialog.setAttribute("aria-label", "保存した検索条件");
  confirmation.setAttribute("aria-label", "検索条件の削除確認");
  document.body.append(dialog, confirmation, notice);
  let controller: AbortController | undefined,
    seq = 0,
    busy = false,
    lockClose = false,
    previous: HTMLElement | null = null;
  let items: SavedMapPreset[] = [],
    total = 0,
    page = 1;
  let preparation: AbortController | undefined;
  const endpoint = "/form-answers/map-presets";
  const button = (text: string, run: () => void, disabled = false) => {
    const b = action(text, run);
    b.className = "btn-close";
    b.disabled = disabled;
    b.dataset.disabled = String(disabled);
    return b;
  };
  const syncBusy = () => {
    dialog.setAttribute("aria-busy", String(busy));
    for (const el of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "button,input",
    )) {
      if (el.textContent === "閉じる") {
        el.disabled = lockClose || confirmation.open || notice.open;
        continue;
      }
      el.dataset.disabled ??= String(el.disabled);
      el.disabled = busy || confirmation.open || notice.open || el.dataset.disabled === "true";
    }
    for (const b of confirmation.querySelectorAll<HTMLButtonElement>("button")) b.disabled = busy;
  };
  const close = () => {
    ++seq;
    controller?.abort();
    preparation?.abort();
    busy = false;
    lockClose = false;
    if (confirmation.open) confirmation.close();
    noticeDialog.close(false);
    progressDialog.clear();
    if (dialog.open) {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    }
  };
  const dismiss = () => {
    if (!lockClose && !confirmation.open && !notice.open) close();
  };
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    dismiss();
  });
  confirmation.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!busy) {
      confirmation.close();
      syncBusy();
    }
  });
  const closeNotice = () => {
    noticeDialog.close();
  };
  const key = (event: KeyboardEvent) => {
    if (!dialog.open) return;
    if (
      event.key === "Escape" ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        if (notice.open) closeNotice();
        else if (confirmation.open) {
          if (!busy) {
            confirmation.close();
            syncBusy();
          }
        } else dismiss();
      }
    }
  };
  window.addEventListener("keydown", key, true);
  const open = (title: string, mode: "list" | "save") => {
    close();
    previous = document.activeElement as HTMLElement;
    dialog.classList.toggle("is-save", mode === "save");
    dialog.setAttribute("aria-label", title);
    const heading = node("h2", title);
    if (mode === "list") {
      const header = node("header");
      header.className = "preset-list-header";
      header.append(heading, button("閉じる", dismiss));
      dialog.replaceChildren(header);
    } else {
      dialog.replaceChildren(heading);
    }
    dialog.showModal();
  };
  const request = async (
    fn: (signal: AbortSignal) => Promise<void>,
    message = "読み込み中…",
    settings: {
      preventClose?: boolean;
      useSpinner?: boolean;
      timeout?: number;
      restoreFocus?: () => void;
    } = {},
  ) => {
    if (busy) return;
    const current = ++seq;
    busy = true;
    lockClose = !!settings.preventClose;
    controller = new AbortController();
    const signal = controller.signal,
      timer = setTimeout(
        () => controller?.signal === signal && controller.abort(),
        settings.timeout ?? 60000,
      );
    dialog.querySelector(".preset-error")?.remove();
    const progress = node("p", message);
    progress.setAttribute("role", "status");
    dialog.insertBefore(progress, dialog.querySelector(".table-scroll"));
    syncBusy();
    const finishProgress = settings.useSpinner ? progressDialog.show(message) : () => {};
    try {
      await awaitWithAbort(fn(signal), signal);
    } catch (e) {
      if (current === seq && dialog.open) {
        if (confirmation.open) confirmation.close();
        const p = node("p", e instanceof Error ? e.message : "処理に失敗しました。");
        p.className = "preset-error";
        p.setAttribute("role", "alert");
        dialog.append(p);
      }
    } finally {
      clearTimeout(timer);
      finishProgress();
      progress.remove();
      if (current === seq) {
        busy = false;
        lockClose = false;
        syncBusy();
        if (!notice.open) settings.restoreFocus?.();
      }
    }
  };
  const load = async (requestedPage: number, signal: AbortSignal) => {
    const current = seq;
    const previous = preparation;
    previous?.abort();
    dialog.querySelector(".preset-preparation")?.remove();
    try {
      const data = (await awaitWithAbort(
        transport(`${endpoint}?page=${requestedPage}&page_size=20&versions=2`, undefined, signal),
        signal,
      )) as { items: SavedMapPreset[]; total: number };
      if (!dialog.open || signal.aborted || current !== seq) return;
      if (
        !data ||
        !Array.isArray(data.items) ||
        !data.items.every(isSavedMapPreset) ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0
      )
        throw Error("保存条件を確認できませんでした。");
      items = data.items;
      total = data.total;
    } catch (error) {
      // 前の一覧が引き続き表示される場合、そのページの行をそのまま呼び出せるようにする。
      if (previous && preparation === previous && current === seq && dialog.open)
        startPreparation();
      const reason =
        error instanceof Error ? error.message : "保存した検索条件を取得できませんでした。";
      throw Error(`${reason} 一覧を閉じて開き直してください。`);
    }
    page = requestedPage;
    renderList();
    startPreparation();
  };
  function startPreparation() {
    preparation?.abort();
    dialog.querySelector(".preset-preparation")?.remove();
    const eligible = items.filter((preset) => !options.filterOnly || preset.kind === "filter");
    if (!eligible.length || !options.preparePage) return;
    const job = new AbortController();
    preparation = job;
    const status = node("p", "地図への適用に必要なデータを準備しています…");
    status.className = "preset-preparation";
    status.setAttribute("role", "status");
    dialog.querySelector(".table-scroll")?.before(status);
    void options.preparePage(eligible, job.signal).then(
      () => status.remove(),
      () => {
        if (!job.signal.aborted && status.isConnected) {
          status.textContent = "一部の条件を準備できませんでした。一覧を閉じて開き直してください。";
          status.setAttribute("role", "alert");
        }
      },
    );
  }
  const confirmDelete = (preset: SavedMapPreset) => {
    const message = node("p");
    message.className = "preset-confirm-message";
    message.append(node("strong", "削除しますか？"));
    confirmation.replaceChildren(node("h2", "メッセージ"), message);
    const actions = node("div");
    actions.className = "preset-actions";
    actions.append(
      button("閉じる", () => {
        confirmation.close();
        syncBusy();
      }),
      button(
        "削除",
        () =>
          void request(
            async (signal) => {
              await transport(
                `${endpoint}/${encodeURIComponent(preset.id)}`,
                undefined,
                signal,
                "DELETE",
              );
              if (signal.aborted) return;
              confirmation.close();
              await load(items.length === 1 ? Math.max(1, page - 1) : page, signal);
            },
            "削除しています…",
            { preventClose: true },
          ),
      ),
    );
    confirmation.append(actions);
    confirmation.showModal();
    syncBusy();
  };
  function applyPreset(preset: SavedMapPreset) {
    const apply = options.apply;
    if (!apply) return;
    const selected = [...dialog.querySelectorAll<HTMLButtonElement>("[data-preset-apply-id]")].find(
      (button) => button.dataset.presetApplyId === preset.id,
    );
    const restoreFocus = () => {
      if (dialog.open && selected?.isConnected && !selected.disabled) selected.focus();
    };
    void request(
      async (signal) => {
        await apply(cloneSavedMapPreset(preset), signal);
        if (!signal.aborted && dialog.open) {
          progressDialog.clear();
          noticeDialog.show(
            mapOperationMessages[preset.kind],
            preset.kind === "filter" ? "絞り込み完了" : "色分け完了",
            restoreFocus,
          );
        }
      },
      "条件を地図へ反映しています",
      { preventClose: true, useSpinner: true, timeout: 180000, restoreFocus },
    );
  }
  function renderList() {
    for (const child of [...dialog.children].slice(1)) child.remove();
    if (options.filterOnly)
      dialog.append(
        node(
          "p",
          options.apply
            ? "この画面では絞り込み条件のみ呼び出し・適用できます。色分け条件は対応した画面で操作してください。"
            : "この画面では絞り込み条件のみ呼び出せます。色分け条件は色分けに対応した画面で呼び出してください。",
        ),
      );
    if (items.length) {
      const table = node("div");
      renderMapPresetsTable(table, {
        items,
        disabled: false,
        restoreDisabledReason: (preset) =>
          options.filterOnly && preset.kind === "coloring"
            ? "この画面では色分け条件を呼び出せません"
            : undefined,
        restore: (preset) =>
          void request(
            async (signal) => {
              await restore(cloneSavedMapPreset(preset), signal);
              if (!signal.aborted && dialog.open) {
                // スピナーを解除してから、一覧を残したまま完了メッセージを表示する。
                progressDialog.clear();
                noticeDialog.show(
                  "呼び出しが完了しました。実行ボタンで地図に反映します。",
                  "呼び出し完了",
                );
              }
            },
            "検索条件を呼び出しています…",
            { preventClose: true, useSpinner: true },
          ),
        apply: options.apply ? applyPreset : undefined,
        applyDisabledReason: (preset) =>
          options.filterOnly && preset.kind === "coloring"
            ? "この画面では色分け条件を適用できません"
            : undefined,
        remove: confirmDelete,
      });
      dialog.append(table);
    } else dialog.append(node("p", "保存した検索条件はありません。"));
    const pages = Math.max(1, Math.ceil(total / 20));
    if (pages > 1) {
      const nav = node("nav");
      nav.className = "preset-pagination";
      nav.setAttribute("aria-label", "保存した検索条件のページ");
      nav.append(
        button("前へ", () => void request((signal) => load(page - 1, signal)), page <= 1),
        node("span", `${page} / ${pages}`),
        button("次へ", () => void request((signal) => load(page + 1, signal)), page >= pages),
      );
      dialog.append(nav);
    }
    syncBusy();
  }
  return {
    save(value: AnyMapPresetDraft) {
      const draft = toV2PresetDraft(value);
      open("検索条件を保存", "save");
      const label = node("label", "条件名"),
        input = node("input");
      input.maxLength = 100;
      input.setAttribute("aria-label", "条件名");
      label.append(input);
      const actions = node("div");
      actions.className = "preset-actions";
      actions.append(
        button("閉じる", dismiss),
        button(
          "保存",
          () =>
            void request(
              async (signal) => {
                const name = input.value.trim();
                if (!name || [...name].length > 100)
                  throw Error("条件名を1〜100文字で入力してください。");
                const data = await transport(endpoint, { ...draft, name }, signal);
                if (!isSavedMapPreset(data) || data.kind !== draft.kind)
                  throw Error("保存結果を確認できませんでした。");
                if (!signal.aborted) close();
              },
              "保存しています…",
              { preventClose: true },
            ),
        ),
      );
      dialog.append(label, actions);
      input.focus();
    },
    list() {
      open("保存した検索条件", "list");
      items = [];
      total = 0;
      page = 1;
      renderList();
      void request((signal) => load(1, signal));
    },
    refreshPreparation() {
      if (!dialog.open || dialog.classList.contains("is-save") || !items.length) return false;
      startPreparation();
      return true;
    },
    close,
    dispose() {
      window.removeEventListener("keydown", key, true);
      close();
      dialog.remove();
      confirmation.remove();
      noticeDialog.dispose();
      progressDialog.dispose();
    },
  };
}
