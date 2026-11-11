import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminTileServerSettingsUrl } from "@/router/urls";
import TileServerSettings from "../TileServerSettings.vue";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

const environment = {
  revision: null as string | null,
  proxy: { source: "environment", baseUrl: "https://old.example.test/tiles", hasApiKey: true },
  vectorOrigins: { source: "environment", origins: ["https://old-vector.example.test"] },
  keyStorageConfigured: true,
};
const managed = {
  ...environment,
  revision: "revision-1",
  proxy: { ...environment.proxy, source: "managed" },
};

let wrapper: VueWrapper | undefined;

async function open(data = environment) {
  api.get.mockResolvedValueOnce({ data });
  wrapper = mount(TileServerSettings);
  await flushPromises();
  return wrapper;
}

function button(text: string) {
  const match = wrapper?.findAll("button").find((candidate) => candidate.text() === text);
  if (!match) throw new Error(`ボタンが見つかりません。${text}`);
  return match;
}

async function click(text: string) {
  await button(text).trigger("click");
  await flushPromises();
}

function expectMessage(text: string) {
  const dialog = wrapper!.get('[role="dialog"]');
  expect(dialog.isVisible()).toBe(true);
  expect(dialog.text()).toContain(text);
}

async function closeMessage() {
  await click("閉じる");
  expect(wrapper!.get('[role="dialog"]').isVisible()).toBe(false);
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("タイルサーバ設定", () => {
  it("同じURLのキーを表示せずに保持し、接続確認と適用を別々に行う", async () => {
    const view = await open();
    const key = view.get<HTMLInputElement>("#tile-proxy-api-key");
    expect(key.element.value).toBe("");
    expect(key.element.type).toBe("password");
    expect(view.text()).toContain("設定済み");
    const request = {
      revision: null,
      mode: "managed",
      baseUrl: environment.proxy.baseUrl,
      tile: { z: 14, x: 14552, y: 6451 },
    };
    api.post.mockResolvedValueOnce({ data: { ok: true } });
    await click("接続確認");
    expect(api.post).toHaveBeenCalledWith(`${adminTileServerSettingsUrl}/proxy/check`, request);
    expect(api.put).not.toHaveBeenCalled();
    expectMessage("PNGタイルを取得");
    await closeMessage();

    api.put.mockResolvedValueOnce({ data: managed });
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(`${adminTileServerSettingsUrl}/proxy`, request);
    expectMessage("中継設定を適用");
    expect(button("中継を環境変数に戻す").exists()).toBe(true);
  });

  it("接続先の変更でキーを求め、範囲外の確認座標を送らない", async () => {
    const view = await open(managed);
    await view.get("#tile-proxy-url").setValue("https://new.example.test");
    await click("接続確認");
    expectMessage("APIキーを入力");
    expect(api.post).not.toHaveBeenCalled();
    await closeMessage();

    await view.get("#tile-proxy-api-key").setValue("fixture-key");
    await view.get("#tile-proxy-z").setValue("1");
    await click("接続確認");
    expectMessage("確認座標は整数");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("確認座標のPNGが404なら配信範囲内の座標へ案内する", async () => {
    await open();
    api.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    await click("接続確認");
    expectMessage("配信範囲内の座標を指定");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("中継設定のフォーム送信では不正なURLもメッセージで案内する", async () => {
    api.get.mockResolvedValueOnce({ data: environment });
    wrapper = mount(TileServerSettings, { attachTo: document.body });
    await flushPromises();
    await wrapper.get("#tile-proxy-url").setValue("invalid-url");
    (button("中継設定を適用").element as HTMLButtonElement).click();
    await flushPromises();
    expectMessage("HTTP(S)のベースURLを入力");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("新しいキーの適用後に入力を消し、編集中の接続許可先を保持する", async () => {
    const view = await open(managed);
    const newUrl = "https://new.example.test";
    const originDraft = "https://new-vector.example.test";
    const origins = view.get<HTMLTextAreaElement>("#vector-tile-origins");
    await origins.setValue(originDraft);
    await view.get("#tile-proxy-url").setValue(newUrl);
    const key = view.get<HTMLInputElement>("#tile-proxy-api-key");
    await key.setValue("fixture-key");
    api.put.mockResolvedValueOnce({
      data: { ...managed, revision: "revision-2", proxy: { ...managed.proxy, baseUrl: newUrl } },
    });
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      `${adminTileServerSettingsUrl}/proxy`,
      expect.objectContaining({
        revision: managed.revision,
        apiKey: "fixture-key",
        baseUrl: newUrl,
      }),
    );
    expect(key.element.value).toBe("");
    expect(origins.element.value).toBe(originDraft);
    await closeMessage();

    api.put.mockResolvedValueOnce({ data: environment });
    await click("中継を環境変数に戻す");
    expect(api.put).toHaveBeenLastCalledWith(`${adminTileServerSettingsUrl}/proxy`, {
      revision: "revision-2",
      mode: "environment",
    });
    expectMessage("中継を環境変数の設定に戻しました");
  });

  it("暗号鍵がなくても接続許可先を管理し、空一覧と環境変数への復帰を区別する", async () => {
    const view = await open({ ...environment, keyStorageConfigured: false });
    expect(view.text()).toContain("TILE_SETTINGS_ENCRYPTION_KEY");
    expect(button("中継設定を適用").element.matches(":disabled")).toBe(true);
    const origins = view.get("#vector-tile-origins");
    const submit = async () => {
      await view.findAll("form")[1]!.trigger("submit");
      await flushPromises();
    };
    await origins.setValue("https://*.example.test");
    await submit();
    expectMessage("HTTPSオリジン");
    expect(api.put).not.toHaveBeenCalled();
    await closeMessage();

    await origins.setValue("");
    api.put.mockResolvedValueOnce({
      data: {
        ...environment,
        revision: "origin-revision",
        keyStorageConfigured: false,
        vectorOrigins: { source: "managed", origins: [] },
      },
    });
    await submit();
    expect(api.put).toHaveBeenLastCalledWith(`${adminTileServerSettingsUrl}/vector-origins`, {
      revision: null,
      origins: [],
    });
    expectMessage("接続許可先を適用しました");
    await closeMessage();
    api.put.mockResolvedValueOnce({ data: environment });
    await click("接続許可先を環境変数に戻す");
    expect(api.put).toHaveBeenLastCalledWith(`${adminTileServerSettingsUrl}/vector-origins`, {
      revision: "origin-revision",
      origins: null,
    });
    expectMessage("接続許可先を環境変数の設定に戻しました");
  });

  it("更新競合ではキーを消し、最新設定を取得してから入力内容を確認できる", async () => {
    const view = await open(managed);
    const url = view.get<HTMLInputElement>("#tile-proxy-url");
    await url.setValue("https://draft.example.test");
    const key = view.get<HTMLInputElement>("#tile-proxy-api-key");
    await key.setValue("fixture-key");
    api.put.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    await view.get("form").trigger("submit");
    await flushPromises();
    expectMessage("別の操作で設定が更新");
    expect(key.element.value).toBe("");
    expect(button("中継設定を適用").element.matches(":disabled")).toBe(true);
    await closeMessage();

    api.get.mockResolvedValueOnce({
      data: {
        ...managed,
        revision: "concurrent-revision",
        proxy: { ...managed.proxy, baseUrl: "https://active.example.test" },
      },
    });
    await click("最新の設定を取得");
    expectMessage("最新の設定を取得しました");
    expect(url.element.value).toBe("https://draft.example.test");
    expect(view.text()).toContain("https://active.example.test");
    expect(button("中継設定を適用").element.matches(":disabled")).toBe(false);
  });

  it("管理者権限がない応答の詳細を表示せず、保存を無効にする", async () => {
    api.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 403, data: { error: "internal-detail" } },
    });
    wrapper = mount(TileServerSettings);
    await flushPromises();
    expectMessage("管理者権限が必要");
    expect(wrapper.text()).not.toContain("internal-detail");
    await closeMessage();
    expect(button("最新の設定を取得").element.matches(":disabled")).toBe(false);
    expect(button("接続許可先を適用").element.matches(":disabled")).toBe(true);
  });

  it("初回の設定取得に失敗してもモーダルを閉じた後に再取得できる", async () => {
    api.get.mockRejectedValueOnce(new Error("fixture unavailable"));
    wrapper = mount(TileServerSettings);
    await flushPromises();
    expectMessage("タイルサーバ設定を取得できませんでした");
    await closeMessage();
    expect(button("接続許可先を適用").element.matches(":disabled")).toBe(true);

    api.get.mockResolvedValueOnce({ data: environment });
    await click("最新の設定を取得");
    expectMessage("最新の設定を取得しました");
    await closeMessage();
    expect(button("接続許可先を適用").element.matches(":disabled")).toBe(false);
  });
});
