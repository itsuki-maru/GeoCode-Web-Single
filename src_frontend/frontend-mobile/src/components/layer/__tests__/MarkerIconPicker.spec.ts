import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  icons: [{ id: "icon-1", filename: "pin.png", uuid_filename: "saved.png" }],
  load: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/stores/markerIcons", () => ({ useMarkerIconStore: () => store }));
vi.mock("@/settingMobile", () => ({ baseUrl: "https://icons.test" }));
import Picker from "../MarkerIconPicker.vue";
enableAutoUnmount(afterEach);
beforeEach(() => {
  store.load.mockResolvedValue(undefined);
  store.upload.mockResolvedValue({});
  store.remove.mockResolvedValue(undefined);
});
const render = (selected: string | null = "icon-1") =>
  mount(Picker, { props: { modelValue: selected } });
async function select(wrapper: ReturnType<typeof render>, file?: File) {
  const input = wrapper.get<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input.element, "files", { value: file ? [file] : [], configurable: true });
  await input.trigger("change");
}
describe("marker icon selection and persistence", () => {
  it("loads the library and emits icon and default selections", async () => {
    const wrapper = render();
    await flushPromises();
    expect(store.load).toHaveBeenCalledOnce();
    expect(wrapper.get(".select-icon img").attributes("src")).toBe(
      "https://icons.test/static/marker-icons/saved.png",
    );
    await wrapper.get(".select-icon").trigger("click");
    await wrapper.get(".default-icon").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["icon-1"], [null]]);
  });
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "accepts %s and clears the selection after upload",
    async (type) => {
      const wrapper = render();
      const file = new File(["icon"], "pin.png", { type });
      await select(wrapper, file);
      await wrapper.get(".btn-file-upload").trigger("click");
      await flushPromises();
      expect(store.upload).toHaveBeenCalledWith(file);
      expect(wrapper.get<HTMLButtonElement>(".btn-file-upload").element.disabled).toBe(true);
      expect(wrapper.emitted("message")).toContainEqual(["アイコンをアップロードしました。"]);
    },
  );
  it("accepts 5MB exactly but rejects larger or unsupported files without sending them", async () => {
    const wrapper = render();
    const file = new File(["icon"], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024, configurable: true });
    await select(wrapper, file);
    expect(wrapper.text()).toContain("5.0 MB");
    expect(wrapper.get<HTMLButtonElement>(".btn-file-upload").element.disabled).toBe(false);
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 });
    await select(wrapper, file);
    expect(wrapper.emitted("message")).toContainEqual([
      "5MBを超える画像はアップロードできません。",
    ]);
    await select(wrapper, new File(["html"], "payload.png", { type: "text/html" }));
    expect(wrapper.emitted("message")).toContainEqual([
      "PNG、JPEG、GIF、WebP形式の画像を選択してください。",
    ]);
    await select(wrapper);
    expect(wrapper.get<HTMLButtonElement>(".btn-file-upload").element.disabled).toBe(true);
    expect(store.upload).not.toHaveBeenCalled();
  });
  it("blocks concurrent uploads and retains the file for a failed-upload retry", async () => {
    let reject!: (error: Error) => void;
    store.upload.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const wrapper = render();
    const file = new File(["icon"], "pin.png", { type: "image/png" });
    await select(wrapper, file);
    await wrapper.get(".btn-file-upload").trigger("click");
    expect(wrapper.get<HTMLInputElement>("input").element.disabled).toBe(true);
    await wrapper.get(".btn-file-upload").trigger("click");
    expect(store.upload).toHaveBeenCalledOnce();
    reject(new Error("offline"));
    await flushPromises();
    expect(wrapper.emitted("message")).toContainEqual(["アイコンのアップロードに失敗しました。"]);
    expect(wrapper.get<HTMLButtonElement>(".btn-file-upload").element.disabled).toBe(false);
    await wrapper.get(".btn-file-upload").trigger("click");
    await flushPromises();
    expect(store.upload).toHaveBeenCalledTimes(2);
  });
  it.each(["icon-1", "other"])(
    "clears selection only when deleting the selected icon (%s)",
    async (selected) => {
      const wrapper = render(selected);
      await wrapper.get(".delete-icon").trigger("click");
      await flushPromises();
      expect(store.remove).toHaveBeenCalledWith("icon-1");
      expect(wrapper.emitted("update:modelValue")).toEqual(
        selected === "icon-1" ? [[null]] : undefined,
      );
      expect(wrapper.emitted("message")).toContainEqual(["アイコンを削除しました。"]);
    },
  );
  it("retains the selected icon after a failed deletion", async () => {
    store.remove.mockRejectedValueOnce(new Error("forbidden"));
    const wrapper = render();
    await wrapper.get(".delete-icon").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("message")).toContainEqual(["アイコンの削除に失敗しました。"]);
  });
  it("allows clearing the pending file without uploading", async () => {
    const wrapper = render();
    await select(wrapper, new File(["image"], "pin.png", { type: "image/png" }));
    await wrapper.get(".btn-secondary").trigger("click");
    expect(wrapper.get<HTMLButtonElement>(".btn-file-upload").element.disabled).toBe(true);
    expect(store.upload).not.toHaveBeenCalled();
  });
});
