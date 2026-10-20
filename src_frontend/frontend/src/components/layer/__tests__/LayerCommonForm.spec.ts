import { mount, flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { beforeEach, it, expect, vi } from "vitest";
import Modal from "../LayerRenameModal.vue";
import Message from "@/components/common/MessageModal.vue";
import apiClient from "@/axiosClient";
vi.mock("@/axiosClient", () => ({
  default: { get: vi.fn(), put: vi.fn(), isAxiosError: (e: any) => !!e?.response },
}));
const binding = {
  common_form_id: null,
  common_form_version: null,
  revision: 2,
  marker_count: 10,
  shape_count: 5,
};
beforeEach(() => {
  vi.mocked(apiClient.get)
    .mockReset()
    .mockImplementation(async (url) => ({
      data:
        String(url) === "/common-forms"
          ? [{ id: "form", version: 3, form_title: "点検", is_password_protected: true }]
          : String(url).endsWith("/form")
            ? binding
            : {},
    }));
  vi.mocked(apiClient.put).mockReset().mockResolvedValue({});
});
async function open() {
  const w = mount(Modal, {
    props: { isOpen: true, layerId: "layer", currentName: "group", masterLayerId: "master" },
    global: { plugins: [createPinia()], stubs: { MarkerIconPicker: true } },
  });
  await flushPromises();
  return w;
}
it("レイヤ内の件数と置換を確認し、承認した版と件数で一括更新する", async () => {
  const w = await open();
  await w.get('[aria-label="レイヤの共通フォーム"]').setValue("form");
  await w
    .findAll("button")
    .find((b) => b.text() === "変更")!
    .trigger("click");
  await flushPromises();
  const confirm = w.findComponent(Message);
  expect(confirm.props("isOpen")).toBe(true);
  expect(confirm.props("message")).toContain("マーカー10件・図形5件");
  expect(apiClient.put).not.toHaveBeenCalled();
  confirm.vm.$emit("close");
  await flushPromises();
  expect(apiClient.put).not.toHaveBeenCalled();
  await w
    .findAll("button")
    .find((b) => b.text() === "変更")!
    .trigger("click");
  confirm.vm.$emit("confirm");
  await flushPromises();
  expect(apiClient.put).toHaveBeenCalledWith(
    "/layer/update/layer",
    expect.objectContaining({
      name: "group",
      update_common_form: true,
      common_form_id: "form",
      common_form_version: 3,
      form_binding_revision: 2,
      form_target_count: 15,
    }),
  );
  expect(w.emitted("close")).toHaveLength(1);
  w.unmount();
});
it("フォームを変更しなければ既存の名前・アイコン更新だけを送る", async () => {
  const w = await open();
  await w
    .findAll("button")
    .find((b) => b.text() === "変更")!
    .trigger("click");
  await flushPromises();
  expect(vi.mocked(apiClient.put).mock.calls[0]![1]).not.toHaveProperty("update_common_form");
  w.unmount();
});
it("競合時は閉じずに再確認を案内する", async () => {
  const w = await open();
  await w.get('[aria-label="レイヤの共通フォーム"]').setValue("form");
  await w
    .findAll("button")
    .find((b) => b.text() === "変更")!
    .trigger("click");
  vi.mocked(apiClient.put).mockRejectedValueOnce({ response: { status: 409 } });
  w.findComponent(Message).vm.$emit("confirm");
  await flushPromises();
  expect(w.emitted("close")).toBeUndefined();
  expect(w.emitted("message")!.flat().join()).toContain("設定を開き直してください");
  w.unmount();
});
