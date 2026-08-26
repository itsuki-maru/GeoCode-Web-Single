import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
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
  api.isAxiosError.mockReturnValue(false);
  routerPush.mockReset();
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
    expect(wrapper.findAll("button").some((button) => button.text() === "Unlock")).toBe(true);
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
    const unlock = wrapper.findAll("button").find((button) => button.text() === "Unlock");

    await unlock?.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/api/admin/user/unlock/2");
    expect(wrapper.text()).toContain("アカウントロックを解除しました。");
  });
});
