import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import {
  AxiosError,
  CanceledError,
  isCancel,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
const auth = vi.hoisted(() => ({ logout: vi.fn(), push: vi.fn() }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ logout: auth.logout }) }));
vi.mock("@/router", () => ({ default: { push: auth.push } }));
vi.mock("@/setting", () => ({ baseUrl: "https://admin.example.test" }));
import apiClient from "@/axiosClient";
import TileOverlays from "@/views/TileOverlays.vue";
import BackgroundMaps from "@/views/BackgroundMaps.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";

const originalAdapter = apiClient.defaults.adapter;
const adapter = vi.fn<AxiosAdapter>();
let wrapper: VueWrapper | undefined;
const path = (config: InternalAxiosRequestConfig) => new URL(config.url!, config.baseURL).pathname;
const response = (config: InternalAxiosRequestConfig, data: unknown = {}): AxiosResponse => ({
  config,
  data,
  status: 200,
  statusText: "OK",
  headers: {},
});
function httpError(
  config: InternalAxiosRequestConfig,
  status: number,
  data = { error: "rejected" },
) {
  return new AxiosError(
    `HTTP ${status}`,
    status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    { transport: "test" },
    { ...response(config, data), status, statusText: "Rejected" },
  );
}
beforeEach(() => {
  adapter.mockReset();
  auth.logout.mockClear();
  auth.push.mockClear();
  apiClient.defaults.adapter = adapter;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  apiClient.defaults.adapter = originalAdapter;
  document.body.replaceChildren();
});

describe("実Axios経由のエラー伝播", () => {
  it("成功応答はそのまま返す", async () => {
    let sent!: AxiosResponse;
    adapter.mockImplementation(async (config) => (sent = response(config, { saved: true })));
    expect(await apiClient.get("/protected")).toBe(sent);
    expect(sent.data).toEqual({ saved: true });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 422, 500, 503])(
    "HTTP %sの元のエラー・応答・要求を保持し、自動再送しない",
    async (status) => {
      let failure!: AxiosError;
      adapter.mockImplementation(async (config) => {
        failure = httpError(config, status);
        throw failure;
      });
      const pending = apiClient.post(
        "/protected",
        { name: "保持する入力" },
        { headers: { "X-Request-Id": "original" } },
      );
      const received = await pending.catch((error) => error);
      expect(received).toBe(failure);
      expect(received.response.status).toBe(status);
      expect(received.response.data).toEqual({ error: "rejected" });
      expect(received.config.method).toBe("post");
      expect(JSON.parse(received.config.data)).toEqual({ name: "保持する入力" });
      expect(received.config.headers.get("X-Request-Id")).toBe("original");
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(auth.logout).not.toHaveBeenCalled();
      expect(auth.push).not.toHaveBeenCalled();
    },
  );
  it.each([AxiosError.ERR_NETWORK, AxiosError.ECONNABORTED])(
    "応答のない%sも元のエラーで拒否する",
    async (code) => {
      let failure!: AxiosError;
      adapter.mockImplementation(async (config) => {
        failure = new AxiosError("transport failed", code, config);
        throw failure;
      });
      const received = await apiClient.get("/protected", { timeout: 1000 }).catch((error) => error);
      expect(received).toBe(failure);
      expect(received.code).toBe(code);
      expect(received.response).toBeUndefined();
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(auth.logout).not.toHaveBeenCalled();
      expect(auth.push).not.toHaveBeenCalled();
    },
  );
  it("処理中のAbortSignalによるキャンセルを成功へ変換しない", async () => {
    const controller = new AbortController();
    let failure!: CanceledError<unknown>;
    adapter.mockImplementation(
      (config) =>
        new Promise((_resolve, reject) => {
          config.signal!.addEventListener!(
            "abort",
            () => {
              failure = new CanceledError("cancelled", config);
              reject(failure);
            },
            { once: true },
          );
        }),
    );
    const pending = apiClient
      .get("/protected", { signal: controller.signal })
      .catch((error) => error);
    await flushPromises();
    expect(adapter).toHaveBeenCalledTimes(1);
    controller.abort();
    const received = await pending;
    expect(received).toBe(failure);
    expect(isCancel(received)).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
});

describe("実Axios経由の認証更新の回帰", () => {
  it("401だけを更新して同じPOST本文とヘッダーで一度再送する", async () => {
    let protectedCalls = 0;
    adapter.mockImplementation(async (config) => {
      if (path(config) === "/protected" && ++protectedCalls === 1)
        throw httpError(config, 401, { error: "token_expired" });
      return response(config, { saved: true });
    });
    await expect(
      apiClient.post("/protected", { name: "保存内容" }, { headers: { "X-Request-Id": "same" } }),
    ).resolves.toMatchObject({ data: { saved: true } });
    expect(adapter.mock.calls.map(([c]) => path(c))).toEqual([
      "/protected",
      "/account/refresh",
      "/protected",
    ]);
    const requests = adapter.mock.calls.map(([c]) => c).filter((c) => path(c) === "/protected");
    expect(requests[1]!.data).toBe(requests[0]!.data);
    expect(requests[1]!.headers.get("X-Request-Id")).toBe("same");
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
  it("更新先の500では元の操作を再送せず、ログインへ戻し、次の要求は処理できる", async () => {
    let protectedCalls = 0;
    adapter.mockImplementation(async (config) => {
      if (path(config) === "/account/refresh") throw httpError(config, 500);
      if (path(config) === "/protected" && ++protectedCalls === 1)
        throw httpError(config, 401, { error: "token_expired" });
      return response(config, { recovered: true });
    });
    await expect(apiClient.post("/protected", { name: "未送信" })).rejects.toThrow(
      "Token refresh failed",
    );
    expect(adapter.mock.calls.map(([c]) => path(c))).toEqual(["/protected", "/account/refresh"]);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.push).toHaveBeenCalledExactlyOnceWith("/account/login");
    await expect(apiClient.get("/next")).resolves.toMatchObject({ data: { recovered: true } });
    expect(adapter).toHaveBeenCalledTimes(3);
  });
  it("更新成功後の再送が503でも元の失敗を返し、追加の更新やログアウトをしない", async () => {
    let calls = 0,
      failure!: AxiosError;
    adapter.mockImplementation(async (config) => {
      if (path(config) === "/account/refresh") return response(config);
      if (++calls === 1) throw httpError(config, 401, { error: "token_expired" });
      failure = httpError(config, 503);
      throw failure;
    });
    const received = await apiClient
      .post("/protected", { name: "保存内容" })
      .catch((error) => error);
    expect(received).toBe(failure);
    expect(adapter.mock.calls.map(([c]) => path(c))).toEqual([
      "/protected",
      "/account/refresh",
      "/protected",
    ]);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
  it("同時401は一つの更新完了を待ち、それぞれの操作を一度再送する", async () => {
    const calls = new Map<string, number>();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    adapter.mockImplementation(async (config) => {
      const url = path(config);
      if (url === "/account/refresh") {
        await gate;
        return response(config);
      }
      const count = (calls.get(url) ?? 0) + 1;
      calls.set(url, count);
      if (count === 1) throw httpError(config, 401, { error: "token_expired" });
      return response(config, { url });
    });
    const pending = Promise.all([apiClient.get("/one"), apiClient.get("/two")]);
    await flushPromises();
    expect(adapter.mock.calls.filter(([c]) => path(c) === "/account/refresh")).toHaveLength(1);
    expect(calls).toEqual(
      new Map([
        ["/one", 1],
        ["/two", 1],
      ]),
    );
    complete();
    expect((await pending).map((r) => r.data.url)).toEqual(["/one", "/two"]);
    expect(calls).toEqual(
      new Map([
        ["/one", 2],
        ["/two", 2],
      ]),
    );
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
});

const tile = {
  id: "a",
  name: "洪水",
  url: "https://tiles.example.test/{z}/{x}/{y}.png",
  attribution: "出典",
  min_zoom: 0,
  max_zoom: 18,
  opacity: 0.7,
  sort_order: 0,
  enabled: true,
};
async function openTiles() {
  wrapper = mount(TileOverlays, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}
const click = async (text: string) => {
  await wrapper!
    .findAll("button")
    .find((b) => b.text() === text)!
    .trigger("click");
  await flushPromises();
};
describe("実Axiosを使うタイル管理の失敗と復旧", () => {
  it("一覧の通信失敗を表示し、待機を解除して再読込できる", async () => {
    adapter
      .mockImplementationOnce(async (config) => {
        throw new AxiosError("offline", AxiosError.ERR_NETWORK, config);
      })
      .mockImplementation(async (config) => response(config, [tile]));
    const w = await openTiles();
    expect(w.get('[role="alert"]').text()).toContain("取得できません");
    expect(w.get('[role="alert"] button').attributes("disabled")).toBeUndefined();
    expect(w.text()).not.toContain("処理中…");
    await click("一覧を再読み込み");
    expect(w.find('[role="alert"]').exists()).toBe(false);
    expect(w.get("li").text()).toContain("洪水");
    expect(adapter).toHaveBeenCalledTimes(2);
  });
  it("保存の500では入力と一覧を保持し、成功通知を出さず再保存できる", async () => {
    let attempts = 0;
    adapter.mockImplementation(async (config) => {
      if (config.method === "get") return response(config, [tile]);
      if (++attempts === 1) throw httpError(config, 500);
      return response(config, { ...tile, id: "b", name: "浸水" });
    });
    const w = await openTiles();
    await w.get("input").setValue("浸水");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain("保存できませんでした");
    expect(w.get<HTMLInputElement>("input").element.value).toBe("浸水");
    expect(w.findAll("li")).toHaveLength(1);
    expect(w.text()).not.toContain("タイル設定を保存しました");
    expect(w.get("fieldset").attributes("disabled")).toBeUndefined();
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.findAll("li")).toHaveLength(2);
    expect(w.get<HTMLInputElement>("input").element.value).toBe("");
    expect(w.get('[role="status"]').text()).toContain("保存しました");
    expect(attempts).toBe(2);
  });
  it("削除の500では一覧と編集内容を残し、再確認して成功した時だけ削除する", async () => {
    let attempts = 0;
    adapter.mockImplementation(async (config) => {
      if (config.method === "get") return response(config, [tile]);
      if (++attempts === 1) throw httpError(config, 500);
      return response(config);
    });
    const w = await openTiles();
    await click("編集");
    await w.get("input").setValue("編集途中");
    await click("削除");
    w.getComponent(ConfirmModal).vm.$emit("confirm");
    await flushPromises();
    expect(w.findAll("li")).toHaveLength(1);
    expect(w.get<HTMLInputElement>("input").element.value).toBe("編集途中");
    expect(w.get('[role="alert"]').text()).toContain("削除できません");
    expect(w.text()).not.toContain("タイル設定を削除しました");
    expect(w.get("li button").attributes("disabled")).toBeUndefined();
    await click("削除");
    w.getComponent(ConfirmModal).vm.$emit("confirm");
    await flushPromises();
    expect(w.find("li").exists()).toBe(false);
    expect(w.get("legend").text()).toBe("タイルを登録");
    expect(w.get('[role="status"]').text()).toContain("削除しました");
    expect(attempts).toBe(2);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });
});

const background = {
  id: 2,
  layer_name: "vector-background",
  label: "背景地図",
  url: "/tile/{z}/{x}/{y}.png",
  kind: "vector",
  style_url: "/styles/v1.json",
  attribution: "出典",
  include_foreign_tiles: false,
  min_zoom: null,
  max_zoom: null,
};
async function openBackground() {
  wrapper = mount(BackgroundMaps, { attachTo: document.body });
  await flushPromises();
  await wrapper.get("li button").trigger("click");
  return wrapper;
}

describe("実Axiosを使う背景地図設定", () => {
  it("保存中のトークン更新後も同じ入力を再送し、一度だけ成功を反映する", async () => {
    const writes: unknown[] = [];
    adapter.mockImplementation(async (config) => {
      if (config.method === "get") return response(config, [background]);
      if (path(config) === "/account/refresh") return response(config);
      writes.push(JSON.parse(config.data));
      if (writes.length === 1) throw httpError(config, 401, { error: "token_expired" });
      return response(config, { ...background, ...JSON.parse(config.data) });
    });
    const w = await openBackground();
    await w.get("#background-style-url").setValue("/styles/v2.json");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]).toMatchObject({
      style_url: "/styles/v2.json",
      min_zoom: null,
      max_zoom: null,
    });
    expect(
      adapter.mock.calls.filter(([config]) => path(config) === "/account/refresh"),
    ).toHaveLength(1);
    expect(w.get("li").text()).toContain("/styles/v2.json");
    expect(w.get('[role="status"]').text()).toContain("背景地図を保存しました");
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.push).not.toHaveBeenCalled();
  });

  it("サーバーの入力エラーでは元の一覧と編集中の入力を維持し、再保存で回復する", async () => {
    let attempts = 0;
    adapter.mockImplementation(async (config) => {
      if (config.method === "get") return response(config, [background]);
      if (++attempts === 1) throw httpError(config, 400, { error: "private provider details" });
      return response(config, { ...background, ...JSON.parse(config.data) });
    });
    const w = await openBackground();
    await w.get("#background-style-url").setValue("/styles/retry.json");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(attempts).toBe(1);
    expect(w.get('[role="alert"]').text()).toContain("保存できませんでした");
    expect(w.text()).not.toContain("private provider details");
    expect(w.get<HTMLInputElement>("#background-style-url").element.value).toBe(
      "/styles/retry.json",
    );
    expect(w.get("li").text()).toContain("/styles/v1.json");
    expect(w.find('[role="status"]').exists()).toBe(false);
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(attempts).toBe(2);
    expect(w.get("li").text()).toContain("/styles/retry.json");
    expect(w.get('[role="status"]').text()).toContain("保存しました");
  });
});
