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
    wrapper.vm.initRows();
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

describe("共有リンクの入力検証と既存リンク", () => {
  const open = () => {
    const w = mount(OnetimeSettingModal, {
      props: {
        isOpen: true,
        layerList: new Map([
          ["layer", { id: "layer", name: "レイヤ", user_id: "owner", is_master: false }],
        ]) as any,
      },
    });
    w.vm.initRows();
    return w;
  };
  beforeEach(() => {
    const response = {
      data: { id: "share", url: "/onetime/share", expiration: "2026-01-01 12:00:00" },
    };
    vi.mocked(apiClient.post).mockResolvedValue(response);
    vi.mocked(apiClient.get).mockResolvedValue(response);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  it.each([
    ["", "数値を入力"],
    ["5", "10分以上"],
    ["60", "レイヤが選択"],
  ])("不正な発行条件を送信しない: %s", async (value, text) => {
    const w = open();
    await w.get("#minits").setValue(value);
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(w.emitted("message")!.flat().join()).toContain(text);
    w.unmount();
  });
  it.each(["", "not-a-date", "2026-01-01 12:00:00"])(
    "取得済み共有URLを確認し、期限文字列の差異で失敗しない: %s",
    async (expiration) => {
      const w = open();
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        data: { id: "share", url: "/onetime/share", expiration },
      });
      await w.vm.fetchCurrentSharedUrl();
      await flushPromises();
      await w.get(".existing-share-btn").trigger("click");
      expect(w.emitted("generated")![0]).toEqual([
        window.location.origin + "/onetime/share",
        "share",
        true,
        expect.any(String),
      ]);
      await w
        .findAll("button")
        .find((b) => b.text() === "閉じる")!
        .trigger("click");
      expect(w.emitted("close")).toHaveLength(1);
      w.unmount();
    },
  );
  it("パスワードを発行要求へ渡し、API失敗では生成完了を通知しない", async () => {
    const w = open();
    await flushPromises();
    await w.get('table input[type="checkbox"]').setValue(true);
    await w.get("#share-password").setValue("password");
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("offline"));
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(w.emitted("generated")).toBeUndefined();
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ share_password: "password" }),
    );
    expect(w.emitted("generated")).toHaveLength(1);
    w.unmount();
  });
});
