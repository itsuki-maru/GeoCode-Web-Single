import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfControls } from "../../../template-scripts/src/map/print/pdf-controls";

const generate = vi.hoisted(() => vi.fn());
vi.mock("../../../template-scripts/src/map/print/pdf-export", () => ({
  generateMapPdf: generate,
  pdfFilename: () => "GeoCode-Web.pdf",
}));
let controls: ReturnType<typeof createPdfControls>;
let ready = true;
const busy = vi.fn();
beforeEach(() => {
  document.body.innerHTML =
    '<aside id="settings"><div class="print-actions"></div><div id="print-status"></div></aside><article id="paper"></article>';
  ready = true;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: vi.fn(() => true) });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  controls = createPdfControls({
    host: document.getElementById("settings")!,
    paper: document.getElementById("paper")!,
    getSettings: () => ({ paperId: "a4-landscape", title: "地図" }),
    isReady: () => ready,
    setBusy: busy,
  });
});
afterEach(() => {
  controls.dispose();
  document.body.replaceChildren();
});
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
describe("PDF出力の状態管理", () => {
  it("準備完了後に生成し、利用者が再度押した時だけ共有する", async () => {
    generate.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    click("#pdf-export");
    click("#pdf-export");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>("[data-save]")!.hidden).toBe(false),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(navigator.share).not.toHaveBeenCalled();
    click("[data-share]");
    expect(navigator.share).toHaveBeenCalledWith({ files: [expect.any(File)] });
    controls.invalidate();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(document.querySelector<HTMLButtonElement>("[data-save]")!.hidden).toBe(true);
  });
  it("取得失敗時は保存を出さず操作を復帰する", async () => {
    generate.mockRejectedValue(new Error("CORS画像取得失敗"));
    click("#pdf-export");
    await vi.waitFor(() =>
      expect(document.querySelector("[data-status]")!.textContent).toContain("CORS画像取得失敗"),
    );
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(document.querySelector<HTMLButtonElement>("[data-save]")!.hidden).toBe(true);
  });
  it("生成中の設定変更・中止では古いPDFを公開しない", async () => {
    let complete!: (value: Blob) => void;
    generate.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          complete = resolve;
        }),
    );
    click("#pdf-export");
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    controls.invalidate();
    click("[data-cancel]");
    complete(new Blob(["pdf"]));
    await vi.waitFor(() => expect(controls.busy()).toBe(false));
    expect(document.querySelector<HTMLButtonElement>("[data-save]")!.hidden).toBe(true);
  });
  it("閉じた後に処理が完了してもURLを生成しない", async () => {
    let complete!: (value: Blob) => void;
    generate.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          complete = resolve;
        }),
    );
    click("#pdf-export");
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    controls.dispose();
    complete(new Blob(["pdf"]));
    await vi.waitFor(() => expect(controls.busy()).toBe(false));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("画像未取得中はPDF出力を無効にする", () => {
    ready = false;
    controls.refresh();
    click("#pdf-export");
    expect(generate).not.toHaveBeenCalled();
  });
});
