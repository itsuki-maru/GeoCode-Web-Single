import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/settingMobile", () => ({ baseUrl: "https://media.test" }));
import Modal from "../ImagePreviewModal.vue";
enableAutoUnmount(afterEach);
describe("mobile media preview", () => {
  it("updates the displayed image and video when the selected file changes", async () => {
    const wrapper = mount(Modal, {
      props: { isOpen: true, imageSrc: "photo.png", imageId: "one" },
    });
    expect(wrapper.get("img").attributes("src")).toBe("https://media.test/static/images/photo.png");
    await wrapper.setProps({ imageSrc: "clip.MP4" });
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.get("video").attributes("src")).toBe(
      "https://media.test/static/images/clip.MP4",
    );
  });
  it("renders no media request for an empty filename", () => {
    const wrapper = mount(Modal, { props: { isOpen: true, imageSrc: "", imageId: "" } });
    expect(wrapper.find("img,video").exists()).toBe(false);
  });
  it("delegates deletion with the current ID and emits closing independently", async () => {
    const wrapper = mount(Modal, {
      props: { isOpen: true, imageSrc: "photo.png", imageId: "one" },
    });
    await wrapper.setProps({ imageId: "two", imageSrc: "second.png" });
    await wrapper.get(".btn-delete").trigger("click");
    expect(wrapper.emitted("deleteRequest")).toEqual([["two"]]);
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
