import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TileOverlays from "../TileOverlays.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
const tile = {
  id: "a",
  name: "洪水",
  url: "https://example.com/{z}/{x}/{y}.png",
  attribution: "出典",
  min_zoom: 0,
  max_zoom: 18,
  opacity: 0.7,
  sort_order: 0,
  enabled: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [tile] });
});

it("一覧取得失敗を再読み込みで回復し、新規タイルを表示順で登録する", async () => {
  api.get.mockRejectedValueOnce(new Error("offline"));
  const wrapper = mount(TileOverlays);
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("取得できません");
  await wrapper.get('[role="alert"] button').trigger("click");
  await flushPromises();
  api.post.mockResolvedValue({ data: { ...tile, id: "b", name: "新規", sort_order: -1 } });
  await wrapper.get("input").setValue("新規");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.findAll("li")[0]!.text()).toContain("新規");
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("");
  wrapper.unmount();
});

it.each([true, false])("削除の確認・キャンセル・結果を反映する: 成功=%s", async (success) => {
  const wrapper = mount(TileOverlays);
  await flushPromises();
  const action = async (text: string) =>
    wrapper
      .get("li")
      .findAll("button")
      .find((b) => b.text() === text)!
      .trigger("click");
  await action("編集");
  await action("削除");
  const confirmation = wrapper.getComponent(ConfirmModal);
  confirmation.vm.$emit("cancel");
  await flushPromises();
  expect(api.delete).not.toHaveBeenCalled();
  await action("削除");
  if (success) api.delete.mockResolvedValue({});
  else api.delete.mockRejectedValue(new Error("offline"));
  confirmation.vm.$emit("confirm");
  await flushPromises();
  expect(api.delete).toHaveBeenCalledWith(expect.stringContaining("/admin/tile-overlays/a"));
  if (success) {
    expect(wrapper.find("li").exists()).toBe(false);
    expect(wrapper.find("legend").text()).toBe("タイルを登録");
  } else {
    expect(wrapper.find("li").exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain("削除できません");
  }
  wrapper.unmount();
});
describe("タイル追加設定", () => {
  it("既存タイルの無効化を保存する", async () => {
    const wrapper = mount(TileOverlays);
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "編集")!
      .trigger("click");
    await wrapper.get('input[type="checkbox"]').setValue(false);
    api.put.mockResolvedValue({ data: { ...tile, enabled: false } });
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      expect.stringContaining("/admin/tile-overlays/a"),
      expect.objectContaining({ enabled: false }),
    );
    expect(wrapper.get("li").text()).toContain("無効");
    wrapper.unmount();
  });
  it("保存失敗時に入力を保持する", async () => {
    const wrapper = mount(TileOverlays);
    await flushPromises();
    await wrapper.get("input").setValue("浸水");
    api.post.mockRejectedValue(new Error("offline"));
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("浸水");
    expect(wrapper.get('[role="alert"]').text()).toContain("保存できませんでした");
    wrapper.unmount();
  });
});
