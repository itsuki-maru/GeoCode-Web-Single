import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  isAxiosError: vi.fn(),
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("@/setting", () => ({ baseUrl: "/api", assetsUrl: "/assets/" }));
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import AdminUsersList from "@/views/users/AdminUsersList.vue";

const usersResponse = {
  data: {
    admin: {
      id: "2",
      username: "admin",
      create_at: "2026-08-23T10:20:30.000Z",
      is_superuser: true,
      is_locked: true,
    },
  },
};

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/admin/users") ? usersResponse : { data: { username: "admin" } }),
  );
  api.post.mockReset();
  api.put.mockReset();
  api.isAxiosError.mockReturnValue(false);
  routerPush.mockReset();
});

describe("管理操作の失敗と入力検証", () => {
  const click = async (wrapper: ReturnType<typeof mount>, text: string) => {
    await wrapper
      .findAll("button")
      .find((b) => b.text() === text)!
      .trigger("click");
    await flushPromises();
  };
  it.each([
    ["", "", "入力は全て必須"],
    ["valid", "short", "8文字以上"],
  ])("不完全な作成入力を送信しない: %s", async (name, password, message) => {
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const form = await openCreateForm(wrapper);
    await form.get('input[type="text"]').setValue(name);
    await form.get('input[type="password"]').setValue(password);
    await form.trigger("submit");
    expect(wrapper.text()).toContain(message);
    expect(api.post).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it.each([
    ["", "", "入力されていません"],
    ["short", "short", "8文字以上"],
    ["password1", "password2", "一致しません"],
  ])("パスワード更新の検証エラー: %s", async (password, check, message) => {
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    await click(wrapper, "パスワード更新");
    const inputs = wrapper.findAll("#overlay-user-info input");
    await inputs[0]!.setValue(password);
    await inputs[1]!.setValue(check);
    await wrapper.get("#overlay-user-info form").trigger("submit");
    expect(wrapper.text()).toContain(message);
    expect(api.post).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it.each([true, false])("確認後のパスワード更新と結果表示: 成功=%s", async (success) => {
    if (success) api.post.mockResolvedValue({});
    else api.post.mockRejectedValue(new Error("offline"));
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    await click(wrapper, "パスワード更新");
    const inputs = wrapper.findAll("#overlay-user-info input");
    await inputs[0]!.setValue("password123");
    await inputs[1]!.setValue("password123");
    await wrapper.get("#overlay-user-info form").trigger("submit");
    const confirmation = wrapper.getComponent({ name: "ConfirmModal" });
    expect(confirmation.props("isOpen")).toBe(true);
    confirmation.vm.$emit("confirm");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(expect.stringContaining("/2"), {
      new_password: "password123",
    });
    expect(wrapper.text()).toContain(success ? "更新しました。" : "更新に失敗しました。");
    await click(wrapper, "閉じる");
    wrapper.unmount();
  });
  it.each([true, false])(
    "位置共有権限の更新後は成功・失敗とも一覧を再取得する: %s",
    async (success) => {
      if (success) api.put.mockResolvedValue({});
      else api.put.mockRejectedValue(new Error("offline"));
      const wrapper = mount(AdminUsersList);
      await flushPromises();
      await wrapper.get(".permission-control input").setValue(true);
      await flushPromises();
      expect(api.put).toHaveBeenCalledWith(expect.stringContaining("/2/live-location-permission"), {
        enabled: true,
      });
      expect(
        api.get.mock.calls.filter(([url]) => String(url).includes("/admin/users")),
      ).toHaveLength(2);
      if (!success) expect(wrapper.text()).toContain("許可を更新できません");
      wrapper.unmount();
    },
  );
  it.each([400, 500])("アカウント作成のエラーを表示する: %s", async (status) => {
    api.isAxiosError.mockReturnValue(true);
    api.post.mockRejectedValue({ response: { status, data: { error: "validation" } } });
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const form = await openCreateForm(wrapper);
    await form.get('input[type="text"]').setValue("valid");
    await form.get('input[type="password"]').setValue("password123");
    await form.trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain(status === 400 ? "形式が正しくありません" : "作成に失敗");
    await wrapper.get(".btn-head-image").trigger("click");
    expect(form.get<HTMLInputElement>('input[type="text"]').element.value).toBe("");
    wrapper.unmount();
  });
  it("ロック解除失敗を通知し、ログイン情報取得失敗でログインへ移動する", async () => {
    api.post.mockRejectedValue(new Error("offline"));
    api.get.mockImplementation((url: string) =>
      url.includes("/admin/users")
        ? Promise.resolve(usersResponse)
        : Promise.reject(new Error("unauthorized")),
    );
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    await click(wrapper, "ロック解除");
    expect(wrapper.text()).toContain("解除に失敗");
    expect(routerPush).toHaveBeenCalledWith("/account/login");
    wrapper.unmount();
  });
});

const openCreateForm = async (wrapper: ReturnType<typeof mount>) => {
  await wrapper.get(".btn-head-image").trigger("click");
  return wrapper.get("#overlay-create-user form");
};

describe("管理ユーザー一覧画面", () => {
  it("ユーザーを取得して整形した日付とロック操作を表示する", async () => {
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    expect(wrapper.text()).toContain("admin");
    expect(wrapper.text()).toContain("2026-08-23");
    expect(wrapper.findAll("button").some((button) => button.text() === "ロック解除")).toBe(true);
  });

  it("リクエスト送信前にアカウント作成入力を検証する", async () => {
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const form = await openCreateForm(wrapper);
    await form.get('input[type="text"]').setValue("bad name");
    await form.get('input[type="password"]').setValue("password123");
    await form.trigger("submit");
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("ユーザー名は3文字以上");
  });

  it("有効なアカウントを作成してユーザーを再取得しフォームをクリアする", async () => {
    api.post.mockResolvedValue({ data: {} });
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const form = await openCreateForm(wrapper);
    const username = form.get<HTMLInputElement>('input[type="text"]');
    const password = form.get<HTMLInputElement>('input[type="password"]');
    await username.setValue("new.user");
    await password.setValue("password123");

    await form.trigger("submit");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/api/admin/user/create", {
      username: "new.user",
      password: "password123",
    });
    expect(wrapper.text()).toContain("ユーザーの作成に成功しました。");
    expect(username.element.value).toBe("");
    expect(password.element.value).toBe("");
    expect(api.get.mock.calls.filter(([url]) => String(url).includes("/admin/users"))).toHaveLength(
      2,
    );
  });

  it("使用済みユーザー名には競合専用メッセージを表示する", async () => {
    api.isAxiosError.mockReturnValue(true);
    api.post.mockRejectedValue({ response: { status: 409, data: { error: "conflict" } } });
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const form = await openCreateForm(wrapper);
    await form.get('input[type="text"]').setValue("existing");
    await form.get('input[type="password"]').setValue("password123");

    await form.trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("既に使用されているユーザー名です。");
  });

  it("ロック中のユーザーを解除して一覧を再取得する", async () => {
    api.post.mockResolvedValue({ data: {} });
    const wrapper = mount(AdminUsersList);
    await flushPromises();
    const unlock = wrapper.findAll("button").find((button) => button.text() === "ロック解除");

    await unlock?.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/api/admin/user/unlock/2");
    expect(wrapper.text()).toContain("アカウントロックを解除しました。");
  });
});
