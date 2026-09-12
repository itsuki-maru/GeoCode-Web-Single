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

    await wrapper.get(".save-button").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledOnce();
    expect(api.post.mock.calls[0][1].name).toBe("現在位置共有マップ");
    expect(api.post.mock.calls[0][1].use_tile_overlays).toBe(true);
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

    const urlField = wrapper.get<HTMLInputElement>('input[aria-label="現在の共有URL"]');
    expect(new URL(urlField.element.value).searchParams.get("is_check_overlay")).toBe("false");
    await wrapper.get(".overlay-toggle input").setValue(true);
    expect(new URL(urlField.element.value).searchParams.get("is_check_overlay")).toBe("true");
    const originalNavigator = navigator;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "コピー")!
        .trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith(urlField.element.value);
    } finally {
      vi.stubGlobal("navigator", originalNavigator);
    }
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "開く")!
      .trigger("click");
    expect(open).toHaveBeenCalledWith(urlField.element.value, "_blank", "noopener,noreferrer");
    open.mockRestore();
    await wrapper.get(".overlay-toggle input").setValue(false);
    expect(new URL(urlField.element.value).searchParams.get("is_check_overlay")).toBe("false");

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
    await wrapper.get(".save-button").trigger("click");
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

it("タイル使用設定を復元・保存し、初期表示の操作は保存済み設定に従う", async () => {
  const saved = {
    id: "map-1",
    name: "map",
    expires_at: "2099-01-01T00:00:00Z",
    revoked_at: null,
    share_url: "/live/map-1",
    is_password_protected: false,
    use_tile_overlays: false,
    member_count: 1,
    members: [{ user_id: "user-1", display_name: "user", marker_color: "#1a73e8" }],
  };
  mockLoad([saved]);
  api.put.mockImplementation(async (_url, payload) => {
    saved.use_tile_overlays = payload.use_tile_overlays;
    mockLoad([{ ...saved }]);
    return {};
  });
  const wrapper = mount(AdminLiveMaps);
  await flushPromises();
  const usage = wrapper.get<HTMLInputElement>(".tile-usage-toggle input");
  const initial = wrapper.get<HTMLInputElement>(".overlay-toggle input");
  expect(usage.element.checked).toBe(false);
  expect(initial.element.disabled).toBe(true);
  await usage.setValue(true);
  expect(initial.element.disabled).toBe(true);
  const save = () =>
    wrapper
      .findAll("button")
      .find((b) => b.text() === "設定を更新")!
      .trigger("click");
  await save();
  await flushPromises();
  expect(api.put).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ use_tile_overlays: true }),
  );
  expect(initial.element.disabled).toBe(false);
  await initial.setValue(true);
  await usage.setValue(false);
  await save();
  await flushPromises();
  expect(initial.element.disabled).toBe(true);
  expect(
    new URL(
      wrapper.get<HTMLInputElement>('input[aria-label="現在の共有URL"]').element.value,
    ).searchParams.get("is_check_overlay"),
  ).toBe("false");
  wrapper.unmount();
  const restored = mount(AdminLiveMaps);
  await flushPromises();
  expect(restored.get<HTMLInputElement>(".tile-usage-toggle input").element.checked).toBe(false);
  restored.unmount();
});

describe("ライブマップの公開レイヤ選択", () => {
  function setup(other = false) {
    const saved = {
      id: "map-1",
      name: "共有",
      expires_at: "2026-09-13T12:00:00Z",
      share_url: "/live/public",
      is_password_protected: false,
      use_tile_overlays: true,
      members: [{ user_id: account.user_id, display_name: "共有者", marker_color: "#123456" }],
      layer_ids: other ? [] : ["a"],
      layers_configured_by_other: other,
    };
    api.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith("live-map-layers")
          ? [
              { id: "a", layer_name: "自分のレイヤ" },
              { id: "b", layer_name: "追加レイヤ" },
            ]
          : url.endsWith("live-locations")
            ? [account]
            : [saved],
      }),
    );
    return mount(AdminLiveMaps);
  }
  const click = async (wrapper: ReturnType<typeof mount>, text: string) => {
    await wrapper
      .findAll("button")
      .find((button) => button.text() === text)!
      .trigger("click");
    await flushPromises();
  };
  it("他の管理者の設定は未操作・キャンセル時に維持し、適用時だけ置き換える", async () => {
    const wrapper = setup(true);
    await flushPromises();
    expect(wrapper.text()).toContain("別の管理者がレイヤを設定");
    await click(wrapper, "設定を更新");
    expect(api.put.mock.lastCall![1]).not.toHaveProperty("layer_ids");
    await click(wrapper, "レイヤ（マーカー・図形）を追加");
    expect(wrapper.get<HTMLInputElement>('input[value="a"]').element.checked).toBe(false);
    await wrapper.get('input[value="a"]').setValue(true);
    await click(wrapper, "キャンセル");
    await click(wrapper, "設定を更新");
    expect(api.put.mock.lastCall![1]).not.toHaveProperty("layer_ids");
    await click(wrapper, "レイヤ（マーカー・図形）を追加");
    expect(wrapper.get<HTMLInputElement>('input[value="a"]').element.checked).toBe(false);
    await wrapper.get('input[value="b"]').setValue(true);
    const count = api.put.mock.calls.length;
    await click(wrapper, "選択を適用");
    expect(api.put.mock.calls).toHaveLength(count);
    await click(wrapper, "設定を更新");
    expect(api.put.mock.lastCall![1].layer_ids).toEqual(["b"]);
    wrapper.unmount();
  });
  it("保存した選択を復元し、全解除を空配列で送信する", async () => {
    const wrapper = setup();
    await flushPromises();
    await click(wrapper, "レイヤ（マーカー・図形）を追加");
    expect(wrapper.get<HTMLInputElement>('input[value="a"]').element.checked).toBe(true);
    await wrapper.get('input[value="a"]').setValue(false);
    await click(wrapper, "選択を適用");
    await click(wrapper, "設定を更新");
    expect(api.put.mock.lastCall![1].layer_ids).toEqual([]);
    wrapper.unmount();
  });
  it("取得失敗時は選択を適用できない", async () => {
    const wrapper = setup();
    await flushPromises();
    api.get.mockRejectedValueOnce(new Error("network"));
    await click(wrapper, "レイヤ（マーカー・図形）を追加");
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text() === "選択を適用")!
        .attributes("disabled"),
    ).toBeDefined();
    await click(wrapper, "キャンセル");
    await click(wrapper, "設定を更新");
    expect(api.put.mock.lastCall![1]).not.toHaveProperty("layer_ids");
    wrapper.unmount();
  });
});
