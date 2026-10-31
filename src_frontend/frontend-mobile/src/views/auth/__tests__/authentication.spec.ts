import { flushPromises, mount, enableAutoUnmount } from "@vue/test-utils";
import { ref } from "vue";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  post: vi.fn(),
  push: vi.fn(),
  login: vi.fn(),
  allowSignup: true,
}));
vi.mock("@/axiosClient", () => ({
  default: { post: deps.post, isAxiosError: (e: any) => !!e?.isAxiosError },
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: deps.push }) }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ login: deps.login }) }));
vi.mock("@/stores/appInits", () => ({
  useApplicationInitStore: () => ({ appInitData: { allowUserAccountCreate: deps.allowSignup } }),
}));
import Login from "../LoginViewMobile.vue";
import Signup from "../SignupViewMobile.vue";
import { getTokenUrl, getTokenFromTotpUrl, signupUrl } from "@/router/urls";

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  deps.allowSignup = true;
  deps.post.mockResolvedValue({ data: { user: "alice" } });
});
const failure = (error: string) => ({ isAxiosError: true, response: { data: { error } } });
function render(component = Login) {
  const visible = ref(true);
  const fetchExternal = vi.fn().mockResolvedValue(undefined);
  const resetExternal = vi.fn();
  const wrapper = mount(component, {
    global: {
      stubs: { RouterLink: { template: "<a><slot /></a>" } },
      provide: {
        isShowOtherFunctionButtonZone: visible,
        isShowMemoIcon: visible,
        fetchExternalSiteHref: fetchExternal,
        resetExternalSiteHref: resetExternal,
      },
    },
  });
  return { wrapper, visible, fetchExternal, resetExternal };
}
async function credentials(
  wrapper: ReturnType<typeof render>["wrapper"],
  username = "alice",
  password = "password123",
) {
  await wrapper.get("#username").setValue(username);
  await wrapper.get("#password").setValue(password);
}
async function submit(wrapper: ReturnType<typeof render>["wrapper"]) {
  await wrapper.get("form").trigger("submit");
  await flushPromises();
}
async function challenge() {
  deps.post.mockResolvedValueOnce({ data: { totp_required: true, challenge_id: "challenge-7" } });
  const state = render();
  await credentials(state.wrapper);
  await submit(state.wrapper);
  return state;
}

describe("login and two-factor authentication", () => {
  it.each([
    ["", ""],
    ["alice", ""],
    ["", "password123"],
  ])("does not send incomplete credentials (%s, %s)", async (user, password) => {
    const { wrapper, visible } = render();
    await credentials(wrapper, user, password);
    await submit(wrapper);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    expect(visible.value).toBe(false);
  });
  it("restores the remembered username and opens the map only after successful authentication", async () => {
    localStorage.setItem("loginuser", "alice");
    const { wrapper, visible } = render();
    expect(wrapper.get<HTMLInputElement>("#username").element.value).toBe("alice");
    await wrapper.get("#password").setValue("password123");
    await submit(wrapper);
    expect(deps.post).toHaveBeenCalledWith(getTokenUrl, {
      username: "alice",
      password: "password123",
    });
    expect(deps.login).toHaveBeenCalledOnce();
    expect(visible.value).toBe(true);
    expect(deps.push).toHaveBeenCalledWith("/mapview");
  });
  it("hides account creation when disabled by the server", () => {
    deps.allowSignup = false;
    const { wrapper } = render();
    expect(wrapper.text()).not.toContain("アカウントを作成しますか？");
  });
  it.each([
    ["Unauthorized", "パスワードかユーザー名が間違っています。"],
    ["LockedAccount", "アカウントがロックされています。"],
    ["PleaseWait", "複数回の間違いにより、時間制限が設定されています。"],
    [
      "UnauthorizedPleaseWait",
      "複数回の間違いがあったため、時間をおいてから再度ログインしてください。",
    ],
    ["Locked", "複数回の失敗により、アカウントがロックされました。管理者に連絡してください。"],
    ["unknown", "パスワードかユーザー名が間違っています。"],
  ])("keeps authentication closed for %s and explains the failure", async (code, message) => {
    deps.post.mockRejectedValueOnce(failure(`unauthorized error: ${code}`));
    const { wrapper, visible } = render();
    await credentials(wrapper);
    await submit(wrapper);
    expect(wrapper.get("#overlay-message").isVisible()).toBe(true);
    expect(wrapper.text()).toContain(message);
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.push).not.toHaveBeenCalled();
    expect(visible.value).toBe(false);
    await wrapper.get("#overlay-message button").trigger("click");
    await flushPromises();
    expect(wrapper.get("#overlay-message").attributes("style")).toContain("display: none");
  });
  it.each([new Error("offline"), { isAxiosError: true }])(
    "never authenticates after a transport failure",
    async (error) => {
      deps.post.mockRejectedValueOnce(error);
      const { wrapper, visible } = render();
      await credentials(wrapper);
      await submit(wrapper);
      expect(deps.login).not.toHaveBeenCalled();
      expect(deps.push).not.toHaveBeenCalled();
      expect(visible.value).toBe(false);
    },
  );
  it("requires a nonempty token and submits the server challenge before opening the map", async () => {
    const { wrapper, visible } = await challenge();
    expect(wrapper.find("#overlay-token-post").exists()).toBe(true);
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.push).not.toHaveBeenCalled();
    await wrapper.get("#overlay-token-post form").trigger("submit");
    expect(deps.post).toHaveBeenCalledTimes(1);
    await wrapper.get("#overlay-token-post input").setValue("123456");
    await wrapper.get("#overlay-token-post form").trigger("submit");
    await flushPromises();
    expect(deps.post).toHaveBeenLastCalledWith(getTokenFromTotpUrl, {
      totp_token: "123456",
      challenge_id: "challenge-7",
    });
    expect(deps.login).toHaveBeenCalledOnce();
    expect(visible.value).toBe(true);
    expect(deps.push).toHaveBeenCalledWith("/mapview");
  });
  it.each([
    ["NoAuth", "トークンが不正です。", true],
    ["Time Over.", "時間切れとなりました。再度ログインしてください。", false],
    ["NoBasicAuth", "不正な操作です。", true],
    ["unknown", "パスワードかユーザー名が間違っています。", true],
  ])(
    "rejects a failed second factor (%s), clears the password and keeps the user logged out",
    async (code, message, remains) => {
      const { wrapper, visible } = await challenge();
      deps.post.mockRejectedValueOnce(failure(`unauthorized error: ${code}`));
      await wrapper.get("#overlay-token-post input").setValue("123456");
      await wrapper.get("#overlay-token-post form").trigger("submit");
      await flushPromises();
      expect(wrapper.text()).toContain(message);
      expect(wrapper.find("#overlay-token-post").exists()).toBe(remains);
      expect(wrapper.get<HTMLInputElement>("#password").element.value).toBe("");
      expect(deps.login).not.toHaveBeenCalled();
      expect(deps.push).not.toHaveBeenCalled();
      expect(visible.value).toBe(false);
    },
  );
});

describe("account creation", () => {
  it("does not create an account without both required fields", async () => {
    const post = vi.spyOn(axios, "post");
    const { wrapper } = render(Signup);
    await submit(wrapper);
    await wrapper.get("#username").setValue("alice");
    await submit(wrapper);
    expect(post).not.toHaveBeenCalled();
  });
  it("sends the registration and redirects only on success", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });
    const { wrapper } = render(Signup);
    await credentials(wrapper);
    await submit(wrapper);
    expect(post).toHaveBeenCalledWith(signupUrl, {
      username: "alice",
      password: "password123",
      secrets_question: "alice",
      secrets_q_answer: "password123",
    });
    expect(deps.push).toHaveBeenCalledWith("/account/login");
  });
  it("keeps failed registrations on the page and allows correcting the username", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new Error("conflict"));
    const { wrapper } = render(Signup);
    await credentials(wrapper);
    await submit(wrapper);
    expect(deps.push).not.toHaveBeenCalled();
    expect(wrapper.get<HTMLInputElement>("#username").element.value).toBe("");
    expect(wrapper.text()).toContain("使用できないユーザー名です。");
    await wrapper.get("#overlay-message button").trigger("click");
    await flushPromises();
    expect(wrapper.get("#overlay-message").attributes("style")).toContain("display: none");
  });
});
