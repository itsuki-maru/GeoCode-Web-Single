import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnetimeSettingModal from "../OnetimeSettingModal.vue";
import apiClient from "@/axiosClient";
vi.mock("@/axiosClient", () => ({
  default: {
    post: vi.fn().mockResolvedValue({
      data: { id: "share", url: "/onetime/share", expiration: "2026-09-12T00:00:00" },
    }),
    get: vi.fn().mockResolvedValue({
      data: { id: "share", url: "/onetime/share", expiration: "2026-09-12T00:00:00" },
    }),
  },
}));
describe("共有リンクのタイル共有設定", () => {
  beforeEach(() => {
    const response = {
      data: { id: "share", url: "/onetime/share", expiration: "2026-09-12T00:00:00" },
    };
    vi.mocked(apiClient.post).mockResolvedValue(response);
    vi.mocked(apiClient.get).mockResolvedValue(response);
  });
  it("初期値はオフで、新規発行・更新に現在の選択を送信する", async () => {
    const wrapper = mount(OnetimeSettingModal, {
      props: {
        isOpen: true,
        layerList: new Map([
          [
            "layer",
            {
              id: "layer",
              user_id: "owner",
              name: "Layer",
              is_master: false,
              marker_icon_id: null,
              marker_icon_filename: null,
            },
          ],
        ]),
      },
    });
    wrapper.vm.copiedLayer();
    await flushPromises();
    await wrapper.get('table input[type="checkbox"]').setValue(true);
    expect((wrapper.get("#include-tile-overlays").element as HTMLInputElement).checked).toBe(false);
    await wrapper.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        include_tile_overlays: false,
        include_shapes: false,
        update_url: false,
      }),
    );
    await wrapper.get("#include-tile-overlays").setValue(true);
    await wrapper.get(".dropdown-toggle").trigger("click");
    await wrapper.findAll(".dropdown-menu button")[1]!.trigger("click");
    await wrapper.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        include_tile_overlays: true,
        include_shapes: false,
        update_url: true,
      }),
    );
    await wrapper.get("#include-tile-overlays").setValue(false);
    await wrapper.get("#include-shapes").setValue(true);
    await wrapper.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        include_tile_overlays: false,
        include_shapes: true,
        update_url: true,
      }),
    );
    wrapper.unmount();
  });
});
