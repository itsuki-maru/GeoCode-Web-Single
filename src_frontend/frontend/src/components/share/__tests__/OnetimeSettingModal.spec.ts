import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnetimeSettingModal from "../OnetimeSettingModal.vue";
import apiClient from "@/axiosClient";
import { shareSnapshotFixture } from "./share-snapshot-fixture";
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
    expect(w.emitted("message")!.flat().join()).toContain("共有リンクを作成できませんでした");
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

describe("現在の地図のスナップショット共有", () => {
  const open = (snapshot = shareSnapshotFixture()) =>
    mount(OnetimeSettingModal, {
      props: { isOpen: true, layerList: new Map(), snapshot, zIndex: 20 },
    });
  beforeEach(() => {
    const response = {
      data: { id: "share", url: "/onetime/share", expiration: "2026-12-01T00:00:00" },
    };
    vi.mocked(apiClient.post).mockResolvedValue(response);
    vi.mocked(apiClient.get).mockResolvedValue(response);
  });
  it("地図の対象と表示設定を確認し、通常共有の対象選択を出さずに保存する", async () => {
    const snapshot = shareSnapshotFixture();
    const expected = JSON.parse(JSON.stringify(snapshot));
    const w = open(snapshot);
    expect(w.find("table").exists()).toBe(false);
    expect(w.find("#include-shapes").exists()).toBe(false);
    expect(w.find("#include-tile-overlays").exists()).toBe(false);
    expect(w.get(".snapshot-summary").text()).toContain("マーカー 1件・図形 1件");
    expect(w.get(".snapshot-summary").text()).toContain("選択グループ");
    expect(w.get(".snapshot-summary").text()).toContain("標準地図");
    expect(w.get(".snapshot-summary").text()).toContain("浸水想定");
    expect(w.get(".base-modal-overlay").attributes("style")).toContain("z-index: 20");
    snapshot.markers["marker-a"]!.detail = "共有画面を開いた後の変更";
    snapshot.state.view.latitude = 40;
    await w.get("#share-password").setValue("password");
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      minutes: 60,
      layers: ["layer-a"],
      update_url: false,
      share_password: "password",
      include_shapes: true,
      include_tile_overlays: true,
      snapshot: expected,
    });
    expect(w.emitted("generated")).toHaveLength(1);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("送信中の連打とスナップショットの差し替えで共有対象を変えない", async () => {
    let complete!: (value: any) => void;
    vi.mocked(apiClient.post).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const snapshot = shareSnapshotFixture();
    const w = open(snapshot);
    await w.get(".dropdown-toggle").trigger("click");
    await w.findAll(".dropdown-menu button")[1]!.trigger("click");
    await w.get(".dropdown-btn > button").trigger("click");
    await w.get(".dropdown-btn > button").trigger("click");
    const replacement = shareSnapshotFixture();
    replacement.state.view.latitude = 40;
    await w.setProps({ snapshot: replacement });
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({
      snapshot,
      update_url: true,
    });
    expect(w.get(".snapshot-summary").text()).toContain("35.500000");
    expect((w.get("#share-password").element as HTMLInputElement).disabled).toBe(true);
    expect(
      w
        .findAll("button")
        .find((button) => button.text() === "閉じる")!
        .attributes("disabled"),
    ).toBeDefined();
    complete({ data: { id: "share", url: "/onetime/share", expiration: "2026-12-01T00:00:00" } });
    await flushPromises();
    expect(w.emitted("generated")).toHaveLength(1);
    w.unmount();
  });

  it("0件の地図も保存でき、不正なスナップショットは通常共有へ切り替えない", async () => {
    const snapshot = shareSnapshotFixture();
    snapshot.layers = {};
    snapshot.markers = {};
    snapshot.shapes = [];
    snapshot.state.layerIds = [];
    snapshot.state.markerIds = [];
    snapshot.state.shapeIds = [];
    delete snapshot.state.coloring;
    const w = open(snapshot);
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({
      layers: [],
      include_shapes: false,
      snapshot,
    });
    w.unmount();
    vi.mocked(apiClient.post).mockClear();
    const invalid = open({} as any);
    expect(invalid.get('[role="alert"]').text()).toContain("もう一度共有");
    expect(invalid.find("table").exists()).toBe(false);
    await invalid.get(".dropdown-btn > button").trigger("click");
    expect(apiClient.post).not.toHaveBeenCalled();
    invalid.unmount();
  });

  it("保存失敗を表示して再試行でき、閉じた後の応答で完了画面を開かない", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce({
      response: { status: 400, data: { error: "共有する図形を確認してください。" } },
    });
    const w = open();
    await w.get(".dropdown-btn > button").trigger("click");
    await flushPromises();
    expect(w.emitted("message")!.flat()).toContain("共有する図形を確認してください。");
    expect(w.emitted("generated")).toBeUndefined();
    let complete!: (value: any) => void;
    vi.mocked(apiClient.post).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await w.get(".dropdown-btn > button").trigger("click");
    await w.setProps({ isOpen: false });
    complete({ data: { id: "share", url: "/onetime/share", expiration: "2026-12-01T00:00:00" } });
    await flushPromises();
    expect(w.emitted("generated")).toBeUndefined();
    w.unmount();
  });
});
