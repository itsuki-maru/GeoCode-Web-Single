import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Policy from "../LayerInputPolicy.vue";
import Message from "@/components/common/MessageModal.vue";
import { useLayersStore } from "@/stores/layers";
import api from "@/axiosClient";
vi.mock("@/axiosClient", () => ({ default: { put: vi.fn() } }));
beforeEach(() => {
  vi.mocked(api.put).mockReset();
});
function setup(restricted = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useLayersStore();
  store.layersList.set("l", { id: "l", name: "保存済み", restrict_free_text: restricted } as any);
  return {
    store,
    w: mount(Policy, { props: { layerId: "l", disabled: false }, global: { plugins: [pinia] } }),
  };
}
describe("自由記述の即時保存", () => {
  it.each([false, true])("保存成功後だけ状態と通知を更新する（元の状態 %s）", async (old) => {
    let finish!: () => void;
    vi.mocked(api.put).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const { w, store } = setup(old);
    await w.get("input").setValue(!old);
    expect(store.layersList.get("l")?.restrict_free_text).toBe(old);
    expect(w.get("input").attributes()).toHaveProperty("disabled");
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/layer/l/input-policy", {
      restrict_free_text: !old,
    });
    finish();
    await flushPromises();
    expect(store.layersList.get("l")?.restrict_free_text).toBe(!old);
    expect(store.layersList.get("l")?.name).toBe("保存済み");
    expect(w.findComponent(Message).props("message")).toBe(
      old
        ? "マーカー内容・図形メモの自由記述を許可しました。"
        : "マーカー内容・図形メモ作成の自由記述を制限しました。",
    );
    w.unmount();
  });
  it("保存に失敗したらチェックを戻す", async () => {
    vi.mocked(api.put).mockRejectedValueOnce(new Error("offline"));
    const { w, store } = setup();
    await w.get("input").setValue(true);
    await flushPromises();
    expect((w.get("input").element as HTMLInputElement).checked).toBe(false);
    expect(store.layersList.get("l")?.restrict_free_text).toBe(false);
    expect(w.findComponent(Message).props("message")).toContain("変更できませんでした");
    w.unmount();
  });
});
