import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  requestHandler: undefined as ((config: any) => any) | undefined,
  responseHandler: undefined as ((error: any) => Promise<any>) | undefined,
  post: vi.fn(),
  request: vi.fn(),
  logout: vi.fn(),
  push: vi.fn(),
  reauthenticationPending: false,
  tokenRotationPending: false,
}));

const client = vi.hoisted(() => ({
  post: state.post,
  request: state.request,
  isAxiosError: vi.fn(() => true),
  interceptors: {
    request: {
      use: vi.fn((fulfilled: (config: any) => any) => {
        state.requestHandler = fulfilled;
      }),
    },
    response: {
      use: vi.fn((_fulfilled: unknown, rejected: (error: any) => Promise<any>) => {
        state.responseHandler = rejected;
      }),
    },
  },
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => client),
    isAxiosError: vi.fn(() => true),
  },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    logout: state.logout,
    isReauthenticationPending: state.reauthenticationPending,
    isTokenRotationPending: state.tokenRotationPending,
  }),
}));
vi.mock("@/router", () => ({
  default: { push: state.push },
}));
vi.mock("@/router/urls", () => ({
  refreshTokenUrl: "/account/refresh",
}));
vi.mock("@/setting", () => ({ baseUrl: "/api" }));
vi.mock("@/settingMobile", () => ({ baseUrl: "/api" }));

import apiClient from "@/axiosClient";

void apiClient;

beforeEach(() => {
  state.post.mockReset();
  state.request.mockReset();
  state.logout.mockReset();
  state.push.mockReset();
  state.reauthenticationPending = false;
  state.tokenRotationPending = false;
});

describe("リクエストインターセプター", () => {
  it("通常のペイロードにJSONのContent-Typeを設定する", () => {
    const config = { data: { value: 1 }, headers: {} as Record<string, string> };
    expect(state.requestHandler?.(config).headers["Content-Type"]).toBe("application/json");
  });

  it("FormDataでは明示的なContent-Typeを削除する", () => {
    const config = {
      data: new FormData(),
      headers: { "Content-Type": "multipart/form-data" } as Record<string, string>,
    };
    expect(state.requestHandler?.(config).headers).not.toHaveProperty("Content-Type");
  });
});

describe("レスポンスインターセプター", () => {
  it("再ログイン案内中の401では自動更新や画面遷移を行わない", async () => {
    state.reauthenticationPending = true;
    const error = {
      response: { status: 401, data: { error: "token_expired" } },
      config: { url: "/protected" },
    };

    await expect(state.responseHandler?.(error)).rejects.toBe(error);
    expect(state.post).not.toHaveBeenCalled();
    expect(state.logout).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("トークン再発行中の401では自動更新や画面遷移を行わない", async () => {
    state.tokenRotationPending = true;
    const error = {
      response: { status: 401, data: { error: "token_expired" } },
      config: { url: "/protected" },
    };

    await expect(state.responseHandler?.(error)).rejects.toBe(error);
    expect(state.post).not.toHaveBeenCalled();
    expect(state.logout).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("期限切れトークンを更新して元のリクエストを再試行する", async () => {
    state.post.mockResolvedValue({ data: {} });
    state.request.mockResolvedValue({ data: "retried" });
    const originalConfig = { url: "/protected" };

    await expect(
      state.responseHandler?.({
        response: { status: 401, data: { error: "token_expired" } },
        config: originalConfig,
      }),
    ).resolves.toEqual({ data: "retried" });

    expect(state.post).toHaveBeenCalledWith("/account/refresh");
    expect(state.request).toHaveBeenCalledWith(originalConfig);
  });

  it("トークン更新に失敗した場合はログアウトしてログイン画面へ遷移する", async () => {
    state.post.mockRejectedValue(new Error("refresh rejected"));

    await expect(
      state.responseHandler?.({
        response: { status: 401, data: { error: "token_expired" } },
        config: { url: "/protected" },
      }),
    ).rejects.toThrow("Token refresh failed");

    expect(state.logout).toHaveBeenCalledOnce();
    expect(state.push).toHaveBeenCalledWith("/account/login");
  });

  it("リフレッシュトークン期限切れ時は直ちにログアウトする", async () => {
    const error = {
      response: { status: 401, data: { error: "refresh_token_expired" } },
      config: { url: "/protected" },
    };

    await expect(state.responseHandler?.(error)).rejects.toBe(error);
    expect(state.post).not.toHaveBeenCalled();
    expect(state.logout).toHaveBeenCalledOnce();
    expect(state.push).toHaveBeenCalledWith("/account/login");
  });
});
