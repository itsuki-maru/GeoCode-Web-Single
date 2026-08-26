import { beforeEach, describe, expect, it, vi } from "vitest";

const authCheck = vi.hoisted(() => vi.fn());

vi.mock("@/axiosClient", () => ({ default: { get: authCheck } }));

import router from "@/router";

beforeEach(async () => {
  await router.replace("/account/login");
});

describe("管理者ルートの認証ガード", () => {
  it("認証成功時はユーザー一覧へ遷移する", async () => {
    authCheck.mockResolvedValue({ data: { username: "admin" } });
    await router.push("/users/list");
    expect(router.currentRoute.value.name).toBe("List");
    expect(authCheck).toHaveBeenCalledOnce();
  });

  it("認証失敗時はログイン画面へリダイレクトする", async () => {
    authCheck.mockRejectedValue(new Error("unauthorized"));
    await router.push("/users/list");
    expect(router.currentRoute.value.name).toBe("login");
  });
});
