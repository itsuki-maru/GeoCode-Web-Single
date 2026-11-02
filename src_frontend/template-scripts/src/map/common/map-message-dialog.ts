import css from "./map-preset-dialog.css?inline";
import { action, node } from "./coloring-editor";

/** 保存条件と地図操作の完了通知で、同じメッセージ表示と閉じ方を使う。 */
export function createMapMessageDialog(onClose?: () => void) {
  if (!document.getElementById("map-preset-dialog-style")) {
    const style = node("style");
    style.id = "map-preset-dialog-style";
    style.textContent = css;
    document.head.append(style);
  }
  const dialog = node("dialog");
  dialog.className = "map-preset-dialog is-confirm common-form-confirm map-message-dialog";
  document.body.append(dialog);
  let previous: HTMLElement | null = null;
  let fallbackFocus: (() => void) | undefined;
  const close = (restoreFocus = true) => {
    if (!dialog.open) return;
    dialog.close();
    onClose?.();
    if (restoreFocus) {
      if (fallbackFocus) fallbackFocus();
      else if (previous?.isConnected) previous.focus();
    }
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const key = (event: KeyboardEvent) => {
    if (
      dialog.open &&
      (event.key === "Escape" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p"))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") close();
    }
  };
  window.addEventListener("keydown", key, true);
  return {
    dialog,
    show(message: string, label: string, focus?: () => void) {
      previous = document.activeElement as HTMLElement | null;
      fallbackFocus = focus;
      const content = node("p");
      content.className = "preset-confirm-message";
      content.append(node("strong", message));
      const actions = node("div");
      actions.className = "preset-actions";
      const button = action("閉じる", () => close());
      button.className = "btn-close";
      actions.append(button);
      dialog.setAttribute("aria-label", label);
      dialog.replaceChildren(node("h2", "メッセージ"), content, actions);
      if (!dialog.open) dialog.showModal();
      button.focus();
    },
    close,
    dispose() {
      close(false);
      window.removeEventListener("keydown", key, true);
      dialog.remove();
    },
  };
}
