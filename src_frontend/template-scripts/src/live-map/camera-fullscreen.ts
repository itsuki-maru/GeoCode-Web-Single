/** 接続や映像要素を作り直さず、ポップアップの映像を拡大する。 */
export class CameraFullscreen {
  private dismiss: (() => void) | null = null;

  open(content: HTMLElement, name: string, trigger: HTMLButtonElement): void {
    if (this.dismiss || !content.isConnected) return;
    const placeholder = document.createComment("camera presentation");
    content.before(placeholder);
    const dialog = document.createElement("dialog");
    dialog.className = "live-camera-fullscreen";
    dialog.setAttribute("aria-label", `${name}の共有カメラ映像`);
    const surface = document.createElement("div");
    surface.className = "live-camera-fullscreen-surface";
    const toolbar = document.createElement("div");
    toolbar.className = "live-camera-fullscreen-toolbar";
    const title = document.createElement("strong");
    title.textContent = name;
    const exit = document.createElement("button");
    exit.type = "button";
    exit.textContent = "全画面を終了";
    toolbar.append(title, exit);
    surface.append(toolbar, content);
    dialog.append(surface);
    document.body.append(dialog);
    let closed = false;
    let native = false;
    const exitNative = () => {
      if (document.fullscreenElement === surface) void document.exitFullscreen().catch(() => {});
    };
    const dismiss = () => {
      if (closed) return;
      closed = true;
      this.dismiss = null;
      document.removeEventListener("fullscreenchange", changed);
      exitNative();
      placeholder.replaceWith(content);
      dialog.close();
      dialog.remove();
      if (trigger.isConnected && !trigger.hidden) trigger.focus({ preventScroll: true });
    };
    const changed = () => {
      if (document.fullscreenElement === surface) native = true;
      else if (native) dismiss();
    };
    this.dismiss = dismiss;
    exit.onclick = dismiss;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener("close", dismiss);
    document.addEventListener("fullscreenchange", changed);
    dialog.showModal();
    exit.focus({ preventScroll: true });
    // 非対応・拒否時もダイアログによるページ全体の拡大表示を維持する。
    if (surface.requestFullscreen && document.fullscreenEnabled !== false) {
      try {
        void surface
          .requestFullscreen()
          .then(() => {
            if (closed) exitNative();
            else changed();
          })
          .catch(() => {});
      } catch {
        // 同期的に拒否されるブラウザでも拡大表示は利用できる。
      }
    }
  }

  close(): void {
    this.dismiss?.();
  }
}
