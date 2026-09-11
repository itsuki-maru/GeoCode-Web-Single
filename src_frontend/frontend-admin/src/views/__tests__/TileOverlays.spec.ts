import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TileOverlays from "../TileOverlays.vue";
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
