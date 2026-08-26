import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import BaseModal from "@/components/common/BaseModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import ProgressSpinner from "@/components/common/ProgressSpinner.vue";
import FullScreenMapModal from "@/components/map/FullScreenMapModal.vue";
import ImagePreviewFromIframeModal from "@/components/map/ImagePreviewFromIframeModal.vue";

describe("基本モーダル", () => {
  it("スロットを表示してモバイル用の既定z-indexを適用する", () => {
    const wrapper = mount(BaseModal, {
      props: { isOpen: true },
      slots: { default: "modal body" },
    });

    expect(wrapper.text()).toContain("modal body");
    expect(wrapper.get(".base-modal-overlay").attributes("style")).toContain("z-index: 10");
    expect(wrapper.get(".base-modal-content").attributes("style")).toContain("z-index: 11");
  });

  it("閉じている場合は非表示になる", () => {
    const wrapper = mount(BaseModal, { props: { isOpen: false } });
    expect(wrapper.get(".base-modal-overlay").isVisible()).toBe(false);
  });

  it("有効なオーバーレイ自体をクリックした場合のみ閉じる", async () => {
    const wrapper = mount(BaseModal, {
      props: { isOpen: true },
      slots: { default: "content" },
    });

    await wrapper.get(".base-modal-content").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.get(".base-modal-overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ closeOnOverlayClick: false });
    await wrapper.get(".base-modal-overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

describe("共通モーダル操作", () => {
  it("確認モーダルからconfirmとcancelを通知する", async () => {
    const wrapper = mount(ConfirmModal, {
      props: { isOpen: true, title: "削除確認", message: "削除しますか？" },
    });
    const buttons = wrapper.findAll("button");
    await buttons[1].trigger("click");
    await buttons[0].trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("メッセージモーダルを表示して閉じる", async () => {
    const wrapper = mount(MessageModal, {
      props: { isOpen: true, message: "保存しました" },
    });
    expect(wrapper.text()).toContain("保存しました");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("開いている間だけ進捗スピナーを表示する", async () => {
    const wrapper = mount(ProgressSpinner, { props: { isOpen: false } });
    expect(wrapper.get(".overlay-progress-bar").attributes("style")).toContain("display: none");
    await wrapper.setProps({ isOpen: true });
    expect(wrapper.get(".overlay-progress-bar").attributes("style") ?? "").not.toContain(
      "display: none",
    );
  });
});

describe("iframe用画像プレビューモーダル", () => {
  it("モバイル用の重なり順でスロットを表示しオーバーレイクリックで閉じる", async () => {
    const wrapper = mount(ImagePreviewFromIframeModal, {
      props: { isOpen: true },
      slots: { default: "preview" },
    });

    expect(wrapper.text()).toContain("preview");
    expect(wrapper.get(".image-preview-modal-overlay").attributes("style")).toContain(
      "z-index: 10",
    );
    expect(wrapper.get(".image-pereview-modal-content").attributes("style")).toContain(
      "z-index: 11",
    );
    await wrapper.get(".image-pereview-modal-content").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.get(".image-preview-modal-overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("画像プレビューiframeからの有効なメッセージで閉じる", async () => {
    const wrapper = mount(FullScreenMapModal, {
      props: { isOpen: true, imageSrc: "/images/html/preview.png" },
      attachTo: document.body,
    });
    const iframe = wrapper.get("iframe").element as HTMLIFrameElement;
    const previewOrigin = new URL(iframe.src).origin;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "callParentImagePreview", message: "" },
        origin: previewOrigin,
        source: window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "callParentImagePreview", message: "" },
        origin: "https://invalid.example.com",
        source: iframe.contentWindow,
      }),
    );
    expect(wrapper.emitted("close")).toBeUndefined();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "callParentImagePreview", message: "" },
        origin: previewOrigin,
        source: iframe.contentWindow,
      }),
    );
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ isOpen: false });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "callParentImagePreview", message: "" },
        origin: previewOrigin,
        source: iframe.contentWindow,
      }),
    );
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
