import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  post: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/axiosClient", () => ({
  default: { post: dependencies.post },
}));
vi.mock("@/router/urls", () => ({ getTokenUrl: "/account/token" }));
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: dependencies.push }),
}));

import LoginViewAdmin from "@/views/auth/LoginViewAdmin.vue";

beforeEach(() => {
  dependencies.post.mockReset();
  dependencies.push.mockReset();
});

describe("管理者ログイン画面", () => {
  it("不足した認証情報を送信しない", async () => {
    const wrapper = mount(LoginViewAdmin);
    await wrapper.get("form").trigger("submit");
    expect(dependencies.post).not.toHaveBeenCalled();
  });

  it("認証情報を送信してログイン後にユーザー一覧を開く", async () => {
    dependencies.post.mockResolvedValue({ data: {} });
    const wrapper = mount(LoginViewAdmin);
    await wrapper.get('input[name="u"]').setValue("admin");
    await wrapper.get('input[name="p"]').setValue("password123");

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(dependencies.post).toHaveBeenCalledWith("/account/token", {
      username: "admin",
      password: "password123",
    });
    expect(dependencies.push).toHaveBeenCalledWith("/users/list");
  });

  it("認証失敗時にパスワードをクリアしてエラーを表示する", async () => {
    dependencies.post.mockRejectedValue(new Error("unauthorized"));
    const wrapper = mount(LoginViewAdmin);
    await wrapper.get('input[name="u"]').setValue("admin");
    const password = wrapper.get<HTMLInputElement>('input[name="p"]');
    await password.setValue("wrongpass");

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(password.element.value).toBe("");
    expect(wrapper.get("#overlay-message").attributes("style") ?? "").not.toContain(
      "display: none",
    );
    expect(wrapper.text()).toContain("パスワードかユーザー名が間違っています。");

    await wrapper.get(".btn-modal-yes").trigger("click");
    expect(wrapper.get("#overlay-message").attributes("style")).toContain("display: none");
  });
});
