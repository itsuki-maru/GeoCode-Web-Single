import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TileOverlayChoices from "../TileOverlayChoices.vue";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), isAxiosError: vi.fn(() => false) }));
vi.mock("@/axiosClient", () => ({ default: api }));
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({
    data: {
      available: [
        { id: "a", name: "洪水" },
        { id: "b", name: "浸水" },
      ],
      selected: ["a"],
    },
  });
});
describe("重ね合わせタイルの選択", () => {
  it("保存後に登録解除を通知し、失敗した選択は元に戻す", async () => {
    const wrapper = mount(TileOverlayChoices);
    await flushPromises();
    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect((boxes[0].element as HTMLInputElement).checked).toBe(true);
    api.put.mockResolvedValueOnce({ data: [] });
    await boxes[0].setValue(false);
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(expect.stringContaining("/tile-overlays/a"), {
      selected: false,
    });
    expect(wrapper.emitted("changed")).toEqual([[[]]]);
    api.put.mockRejectedValueOnce(new Error("offline"));
    await boxes[1].setValue(true);
    await flushPromises();
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("保存できませんでした");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    wrapper.unmount();
  });
  it("保存待ちの連続操作を防ぐ", async () => {
    const wrapper = mount(TileOverlayChoices);
    await flushPromises();
    let finish!: (result: unknown) => void;
    api.put.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await wrapper.findAll("input")[1].setValue(true);
    expect(
      wrapper.findAll("input").every((input) => input.attributes("disabled") !== undefined),
    ).toBe(true);
    finish({ data: [{ id: "a" }, { id: "b" }] });
    await flushPromises();
    expect(
      wrapper.findAll("input").every((input) => input.attributes("disabled") === undefined),
    ).toBe(true);
    wrapper.unmount();
  });
});
