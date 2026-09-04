import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("@/setting", () => ({ baseUrl: "/api" }));

import AdminLiveMaps from "@/views/live/AdminLiveMaps.vue";

const account = {
  user_id: "user-1",
  username: "location-user",
  can_share_live_location: true,
  received_at: null,
};

function mockLoad(maps: unknown[], locationAccounts = [account]) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve({
      data: url.includes("live-locations") ? locationAccounts : maps,
    }),
  );
}

beforeEach(() => {
  api.delete.mockResolvedValue({});
  api.post.mockResolvedValue({ data: { share_url: "/live/public-map-1" } });
  api.put.mockResolvedValue({});
});

describe("現在位置共有マップ管理画面", () => {
  it("未発行時は汎用的な初期名で1件の共有マップを作成できる", async () => {
    mockLoad([]);
    const wrapper = mount(AdminLiveMaps);
    await flushPromises();

    const mapName = wrapper.get<HTMLInputElement>('.form input[maxlength="100"]');
    expect(mapName.element.value).toBe("現在位置共有マップ");
    expect(wrapper.text()).toContain("共有リンクを発行");
    expect(wrapper.text()).not.toContain("路線バス");

    await wrapper.get(".form button").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledOnce();
    expect(api.post.mock.calls[0][1].name).toBe("現在位置共有マップ");
  });

  it("発行済みの場合は同じ1件の設定を編集する", async () => {
    mockLoad([
      {
        id: "map-1",
        name: "拠点メンバー現在位置",
        expires_at: "2026-09-05T12:00:00Z",
        revoked_at: null,
        member_count: 1,
        share_url: "/live/public-map-1",
        is_password_protected: false,
        members: [
          {
            user_id: "user-1",
            display_name: "担当者A",
            marker_color: "#cf222e",
          },
        ],
      },
    ]);
    const wrapper = mount(AdminLiveMaps);
    await flushPromises();

    expect(wrapper.text()).toContain("現在の共有マップを編集");
    expect(wrapper.text()).toContain("設定を更新");
    expect(wrapper.get<HTMLInputElement>('.form input[maxlength="100"]').element.value).toBe(
      "拠点メンバー現在位置",
    );
    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="現在の共有URL"]').element.value,
    ).toContain("/live/public-map-1");

    const update = wrapper.findAll("button").find((button) => button.text() === "設定を更新");
    await update?.trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      "/api/admin/live-maps/map-1",
      expect.objectContaining({
        name: "拠点メンバー現在位置",
        members: [expect.objectContaining({ display_name: "担当者A" })],
        password_action: "remove",
      }),
    );
    const messageModal = wrapper.get("#overlay-message");
    expect(messageModal.attributes("style") ?? "").not.toContain("display: none");
    expect(messageModal.text()).toContain("共有マップを更新しました");

    await wrapper.get(".btn-modal-yes").trigger("click");
    expect(wrapper.get("#overlay-message").attributes("style")).toContain("display: none");
  });

  it("任意の共有パスワードを設定して作成できる", async () => {
    mockLoad([]);
    const wrapper = mount(AdminLiveMaps);
    await flushPromises();

    await wrapper.get<HTMLInputElement>(".password-toggle input").setValue(true);
    await wrapper.get<HTMLInputElement>('input[type="password"]').setValue("share-pass");
    await wrapper.get(".form button").trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith(
      "/api/admin/live-maps",
      expect.objectContaining({
        password_action: "set",
        share_password: "share-pass",
      }),
    );
  });

  it("共有対象は最大20件まで選択できる", async () => {
    const locationAccounts = Array.from({ length: 21 }, (_, index) => ({
      ...account,
      user_id: `user-${index + 1}`,
      username: `location-user-${index + 1}`,
    }));
    mockLoad([], locationAccounts);
    const wrapper = mount(AdminLiveMaps);
    await flushPromises();

    const checkboxes = wrapper.findAll<HTMLInputElement>(
      'input[type="checkbox"][aria-label$="を共有対象にする"]',
    );
    expect(checkboxes).toHaveLength(21);
    expect(checkboxes.filter((checkbox) => checkbox.element.checked)).toHaveLength(20);
    expect(checkboxes[20]!.element.disabled).toBe(true);
    expect(wrapper.text()).toContain("20 / 最大20件を選択");

    await checkboxes[0]!.setValue(false);
    expect(checkboxes[20]!.element.disabled).toBe(false);
  });
});
