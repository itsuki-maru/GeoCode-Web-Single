import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ remove: vi.fn(), deleteImage: vi.fn() }));
vi.mock("@/axiosClient", () => ({
  default: { delete: deps.remove, isAxiosError: (e: any) => !!e?.isAxiosError },
}));
vi.mock("@/stores/images", () => ({ useImageStore: () => ({ deleteImage: deps.deleteImage }) }));
vi.mock("@/setting", () => ({ baseUrl: "https://media.test" }));
import Modal from "../ImagePreviewModal.vue";
import Confirm from "@/components/common/ConfirmModal.vue";
import { imageDeleteUrl } from "@/router/urls";
enableAutoUnmount(afterEach);
beforeEach(() => {
  deps.remove.mockResolvedValue({ data: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const render = (props = {}) =>
  mount(Modal, {
    props: { isOpen: true, imageFilename: "photo.png", imageId: "image-7", ...props },
  });
async function confirmDelete(wrapper: ReturnType<typeof render>) {
  await wrapper.get(".preview-content button").trigger("click");
  expect(wrapper.getComponent(Confirm).props("isOpen")).toBe(true);
  await wrapper
    .getComponent(Confirm)
    .findAll("button")
    .find((b) => b.text() === "削除")!
    .trigger("click");
  await flushPromises();
}
describe("media preview and deletion", () => {
  it("switches between image and video previews as the selection changes", async () => {
    const wrapper = render();
    expect(wrapper.get("img").attributes("src")).toBe("https://media.test/static/images/photo.png");
    await wrapper.setProps({ imageFilename: "clip.MP4" });
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.get("video").attributes("src")).toBe(
      "https://media.test/static/images/clip.MP4",
    );
    await wrapper.setProps({ imageFilename: "" });
    expect(wrapper.find("video, img").exists()).toBe(false);
  });
  it("offers no destructive controls for a read-only preview", () => {
    const wrapper = render({ readOnly: true, imageFilename: "/public/photo.png" });
    expect(wrapper.get("img").attributes("src")).toBe("https://media.test/public/photo.png");
    expect(wrapper.find(".preview-content button").exists()).toBe(false);
    expect(deps.remove).not.toHaveBeenCalled();
  });
  it("does not delete before confirmation, and cancellation leaves the preview open", async () => {
    const wrapper = render();
    await wrapper.get(".preview-content button").trigger("click");
    expect(deps.remove).not.toHaveBeenCalled();
    await wrapper
      .getComponent(Confirm)
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(wrapper.getComponent(Confirm).props("isOpen")).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
  });
  it("removes the store entry only after the server confirms deletion", async () => {
    let resolve!: (value: any) => void;
    deps.remove.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = render();
    await confirmDelete(wrapper);
    expect(deps.remove).toHaveBeenCalledWith(`${imageDeleteUrl}/image-7`);
    expect(deps.deleteImage).not.toHaveBeenCalled();
    resolve({ data: {} });
    await flushPromises();
    expect(deps.deleteImage).toHaveBeenCalledWith("image-7");
    expect(wrapper.emitted("message")).toContainEqual(["削除しました。"]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
  it("does not send a deletion with an empty image ID", async () => {
    const wrapper = render({ imageId: "" });
    await confirmDelete(wrapper);
    expect(deps.remove).not.toHaveBeenCalled();
    expect(wrapper.getComponent(Confirm).props("isOpen")).toBe(false);
  });
  it.each([
    [{ isAxiosError: true, response: { status: 400, data: "invalid image" } }, "message"],
    [{ isAxiosError: true, response: { status: 401, data: {} } }, "loginRedirect"],
    [{ isAxiosError: true, response: { status: 500, data: {} } }, null],
    [{ isAxiosError: true }, null],
    [new Error("offline"), null],
  ])("does not remove the local entry after a failed deletion (%j)", async (error, event) => {
    deps.remove.mockRejectedValueOnce(error);
    const wrapper = render();
    await confirmDelete(wrapper);
    expect(deps.deleteImage).not.toHaveBeenCalled();
    if (event) expect(wrapper.emitted(event)).toHaveLength(1);
    expect(wrapper.emitted("message") ?? []).not.toContainEqual(["削除しました。"]);
  });
});
