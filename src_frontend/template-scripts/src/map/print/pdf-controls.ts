import type { PrintPaper } from "../common/print-state";

export function createPdfControls(options: {
  host: HTMLElement;
  paper: HTMLElement;
  getSettings: () => { paperId: PrintPaper; title: string };
  isReady: () => boolean;
  setBusy: (busy: boolean) => void;
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "PDF出力";
  button.id = "pdf-export";
  options.host.querySelector(".print-actions")!.append(button);
  const panel = document.createElement("div");
  panel.className = "pdf-output";
  panel.innerHTML = `<p class="print-help">iPadなどで、印刷が動作しない場合はPDF出力をお試しください。</p><p class="print-help">PDFは画像形式です。出典・配信元の利用条件に従ってご利用ください。</p>
    <p data-status role="status" aria-live="polite"></p>
    <div class="print-actions"><button type="button" data-save hidden>保存</button><button type="button" data-share hidden>共有</button><button type="button" data-cancel hidden>作成を中止</button></div>`;
  options.host.querySelector("#print-status")!.after(panel);
  const status = panel.querySelector<HTMLElement>("[data-status]")!;
  const save = panel.querySelector<HTMLButtonElement>("[data-save]")!;
  const share = panel.querySelector<HTMLButtonElement>("[data-share]")!;
  const cancel = panel.querySelector<HTMLButtonElement>("[data-cancel]")!;
  let controller: AbortController | undefined;
  let file: File | undefined;
  let url: string | undefined;
  let disposed = false;
  let revision = 0;
  const clear = () => {
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    file = undefined;
    save.hidden = share.hidden = true;
  };
  const invalidate = () => {
    revision++;
    if (file) {
      clear();
      status.textContent = "設定が変更されました。PDFを再作成してください。";
    }
  };
  const refresh = () => {
    button.disabled = Boolean(controller) || !options.isReady();
  };
  button.addEventListener("click", async () => {
    if (controller || !options.isReady()) return;
    clear();
    const ownController = new AbortController();
    controller = ownController;
    options.setBusy(true);
    refresh();
    cancel.hidden = false;
    status.textContent = "PDFを作成しています…";
    const snapshot = revision;
    const settings = options.getSettings();
    let result: Blob | undefined;
    let filename = "GeoCode-Web.pdf";
    try {
      const { generateMapPdf, pdfFilename } = await import("./pdf-export");
      filename = pdfFilename(settings.title);
      result = await generateMapPdf(
        options.paper,
        settings.paperId,
        settings.title,
        ownController.signal,
      );
      if (ownController.signal.aborted) result = undefined;
      if (snapshot !== revision) {
        result = undefined;
        status.textContent = "作成中に地図が変わりました。PDFを再作成してください。";
      }
    } catch (error) {
      if (!disposed)
        status.textContent = ownController.signal.aborted
          ? "PDF作成を中止しました。"
          : `PDFを作成できませんでした。${error instanceof Error ? error.message : "再実行してください。"}`;
    } finally {
      controller = undefined;
      if (!disposed) {
        options.setBusy(false);
        cancel.hidden = true;
        refresh();
        if (result) {
          file = new File([result], filename, { type: "application/pdf" });
          url = URL.createObjectURL(file);
          save.hidden = false;
          try {
            share.hidden = !navigator.canShare?.({ files: [file] });
          } catch {
            share.hidden = true;
          }
          status.textContent = "PDFを作成しました。";
        }
      }
    }
  });
  cancel.addEventListener("click", () => {
    controller?.abort();
    status.textContent = "中止しています…";
  });
  save.addEventListener("click", () => {
    if (!file || !url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    status.textContent = "PDFの保存を実行しました。";
  });
  share.addEventListener("click", async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (!disposed)
        status.textContent =
          error instanceof Error && error.name === "AbortError"
            ? "共有をキャンセルしました。"
            : "共有できませんでした。「保存」をお試しください。";
    }
  });
  refresh();
  return {
    refresh,
    invalidate,
    busy: () => Boolean(controller),
    dispose: () => {
      disposed = true;
      controller?.abort();
      clear();
      button.remove();
      panel.remove();
    },
  };
}
