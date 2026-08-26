import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
const axiosGet = vi.hoisted(() => vi.fn());

vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("axios", () => ({ default: { get: axiosGet } }));

import { useApplicationInitStore } from "@/stores/appInits";
import { useAuthStore } from "@/stores/auth";
import { useUsersStore } from "@/stores/users";

const user = (id: string) => ({
  id,
  username: `user-${id}`,
  create_at: "2026-01-01T00:00:00.000Z",
  is_superuser: id === "2",
  is_locked: id === "1",
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("認証・アプリケーション初期化ストア", () => {
  it("管理者をログアウト状態にする", () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(true);
    store.logout();
    expect(store.isAuthenticated).toBe(false);
  });

  it("アプリケーション初期化状態をクリアする", () => {
    const store = useApplicationInitStore();
    store.appInitData = {
      appTitle: "temporary",
      allowUserAccountCreate: true,
      allowOrigins: "*",
    };
    store.clear();
    expect(store.appInitData).toEqual({
      appTitle: "",
      allowUserAccountCreate: false,
      allowOrigins: "",
    });
  });

  it("アプリケーション初期化APIの項目を状態へ変換する", async () => {
    axiosGet.mockResolvedValue({
      data: {
        app_title: "GeoCode",
        allow_user_account_create: true,
        allow_origins: "https://example.com",
      },
    });
    const store = useApplicationInitStore();
    await store.init();
    expect(store.appInitData).toEqual({
      appTitle: "GeoCode",
      allowUserAccountCreate: true,
      allowOrigins: "https://example.com",
    });
  });

  it("初期化失敗を内部で処理する", async () => {
    axiosGet.mockRejectedValue(new Error("network error"));
    const store = useApplicationInitStore();
    await expect(store.init()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Init data get error.");
  });
});

describe("ユーザーストア", () => {
  it("ユーザーを変換してID降順に並べIDから取得できる", async () => {
    api.get.mockResolvedValue({ data: { first: user("1"), second: user("2") } });
    const store = useUsersStore();
    await store.initList();
    expect([...store.usersList.keys()]).toEqual(["2", "1"]);
    expect(store.getById("1")).toEqual(user("1"));
  });

  it("再取得成功時に古い一覧を置き換える", async () => {
    api.get.mockResolvedValue({ data: { only: user("3") } });
    const store = useUsersStore();
    store.usersList.set("old", user("old"));
    await store.initList();
    expect([...store.usersList.keys()]).toEqual(["3"]);
  });

  it("API失敗をログへ記録して内部で処理する", async () => {
    api.get.mockRejectedValue(new Error("network error"));
    const store = useUsersStore();
    await expect(store.initList()).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith("Init List Error.");
  });
});
