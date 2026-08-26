import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import BaseModal from "@/components/common/BaseModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import ProgressSpinner from "@/components/common/ProgressSpinner.vue";

describe("基本モーダル", () => {
  it("スロットを表示して指定されたz-indexを使用する", () => {
    const wrapper = mount(BaseModal, {
      props: { isOpen: true, zIndex: 12 },
      slots: { default: "modal body" },
    });

    expect(wrapper.text()).toContain("modal body");
    expect(wrapper.get(".base-modal-overlay").isVisible()).toBe(true);
    expect(wrapper.get(".base-modal-overlay").attributes("style")).toContain("z-index: 12");
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

describe("確認モーダル", () => {
  it("内容を表示してconfirmとcancelを通知する", async () => {
    const wrapper = mount(ConfirmModal, {
      props: { isOpen: true, title: "削除確認", message: "削除しますか？" },
    });

    expect(wrapper.text()).toContain("削除確認");
    expect(wrapper.text()).toContain("削除しますか？");
    const buttons = wrapper.findAll("button");
    await buttons[1].trigger("click");
    await buttons[0].trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });
});

describe("メッセージモーダル", () => {
  it("メッセージを表示してcloseを通知する", async () => {
    const wrapper = mount(MessageModal, {
      props: { isOpen: true, message: "保存しました" },
    });

    expect(wrapper.text()).toContain("保存しました");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

describe("進捗スピナー", () => {
  it("isOpenに従って表示し装飾SVGを支援技術から隠す", async () => {
    const wrapper = mount(ProgressSpinner, { props: { isOpen: false } });
    expect(wrapper.get(".progress-overlay").attributes("style")).toContain("display: none");
    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");

    await wrapper.setProps({ isOpen: true });
    expect(wrapper.get(".progress-overlay").attributes("style") ?? "").not.toContain(
      "display: none",
    );
  });
});
