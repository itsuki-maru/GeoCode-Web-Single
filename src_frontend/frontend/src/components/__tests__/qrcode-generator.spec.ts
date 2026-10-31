import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QRCodeGeneratorModal from "@/components/qrcode/QRCodeGeneratorModal.vue";
const generate = vi.hoisted(() => vi.fn());
vi.mock("qrcode", () => ({ default: { toCanvas: generate } }));
let clear: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clear = vi.fn();
  generate.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: clear } as any);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const saveButton = (w: ReturnType<typeof mount>) =>
  w.findAll("button").find((b) => b.text() === "保存");
describe("QRコードの生成と非同期更新", () => {
  it("生成した画像を保存し、入力を消すと古い画像と保存ボタンを消す", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,TEST",
    );
    const w = mount(QRCodeGeneratorModal, { props: { isOpen: true } });
    expect(saveButton(w)).toBeUndefined();
    await w.get("input").setValue("https://example.test");
    await flushPromises();
    expect(generate).toHaveBeenCalledWith(
      w.get("canvas").element,
      "https://example.test",
      expect.objectContaining({ width: 128 }),
    );
    await saveButton(w)!.trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.instances[0]).toMatchObject({
      download: "qrcode.png",
      href: "data:image/png;base64,TEST",
    });
    await w.get("input").setValue("");
    await flushPromises();
    expect(clear).toHaveBeenCalledWith(0, 0, 128, 128);
    expect(saveButton(w)).toBeUndefined();
    await w
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
  it("生成失敗を通知し、再入力で回復できる", async () => {
    generate.mockRejectedValueOnce(new Error("too long"));
    const w = mount(QRCodeGeneratorModal, { props: { isOpen: true } });
    await w.get("input").setValue("failure");
    await flushPromises();
    expect(w.emitted("message")).toEqual([["QRコードを生成できませんでした。"]]);
    expect(saveButton(w)).toBeUndefined();
    await w.get("input").setValue("retry");
    await flushPromises();
    expect(saveButton(w)).toBeDefined();
    w.unmount();
  });
  it.each([true, false])(
    "古い生成結果の遅延完了・失敗で新しい状態を上書きしない: %s",
    async (success) => {
      let resolve!: () => void, reject!: (error: Error) => void;
      generate.mockImplementationOnce(
        () =>
          new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      );
      const w = mount(QRCodeGeneratorModal, { props: { isOpen: true } });
      await w.get("input").setValue("old");
      await w.get("input").setValue("new");
      await flushPromises();
      expect(saveButton(w)).toBeDefined();
      if (success) resolve();
      else reject(new Error("old failure"));
      await flushPromises();
      expect(saveButton(w)).toBeDefined();
      expect(w.emitted("message")).toBeUndefined();
      w.unmount();
    },
  );
  it("入力クリア後に古い生成が成功しても保存可能にしない", async () => {
    let resolve!: () => void;
    generate.mockImplementationOnce(
      () =>
        new Promise<void>((ok) => {
          resolve = ok;
        }),
    );
    const w = mount(QRCodeGeneratorModal, { props: { isOpen: true } });
    await w.get("input").setValue("old");
    await w.get("input").setValue("");
    resolve();
    await flushPromises();
    expect(saveButton(w)).toBeUndefined();
    w.unmount();
  });
});
