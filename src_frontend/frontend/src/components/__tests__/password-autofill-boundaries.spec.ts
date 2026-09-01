import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  routerReplace: vi.fn(),
}));

import UserPrivacySetting from "@/components/UserPrivacySetting.vue";
import MapToolbar from "@/components/map/MapToolbar.vue";
import { useApplicationInitStore } from "@/stores/appInits";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/axiosClient", () => ({
  default: {
    get: testState.apiGet,
    post: testState.apiPost,
    put: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock("qrcode", () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: testState.routerReplace }),
}));

describe("ユーザー設定の認証境界", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    testState.apiGet.mockReset().mockResolvedValue({
      data: { is_private: false, is_totp_enabled: false },
    });
    testState.apiPost.mockReset().mockResolvedValue({ data: {} });
    testState.routerReplace.mockReset().mockResolvedValue(undefined);
  });

  it("2段階認証の有効化中だけトークン再発行状態にする", async () => {
    let completeVerification!: (value: { data: Record<string, never> }) => void;
    const pendingVerification = new Promise<{ data: Record<string, never> }>((resolve) => {
      completeVerification = resolve;
    });
    testState.apiPost
      .mockResolvedValueOnce({
        data: { otpauth_url: "otpauth://totp/test", secret_base32: "TESTSECRET" },
      })
      .mockReturnValueOnce(pendingVerification);
    const authStore = useAuthStore();
    const wrapper = mount(UserPrivacySetting);
    await flushPromises();

    await wrapper
      .get('[title="アカウントの2段階認証設定を切り替えます。"] .switch')
      .trigger("click");
    await flushPromises();
    await wrapper.get(".post-code-input").setValue("123456");
    void wrapper.get(".post-code-btn").trigger("click");

    expect(authStore.isTokenRotationPending).toBe(true);
    completeVerification({ data: {} });
    await flushPromises();

    expect(authStore.isTokenRotationPending).toBe(false);
    expect(wrapper.text()).toContain("二段階認証が有効になりました。");
    expect(wrapper.text()).toContain("2段階認証：ON");
  });

  it("2段階認証の無効化中だけトークン再発行状態にする", async () => {
    testState.apiGet.mockResolvedValueOnce({
      data: { is_private: false, is_totp_enabled: true },
    });
    let completeDisable!: (value: { data: Record<string, never> }) => void;
    const pendingDisable = new Promise<{ data: Record<string, never> }>((resolve) => {
      completeDisable = resolve;
    });
    testState.apiPost.mockReturnValueOnce(pendingDisable);
    const authStore = useAuthStore();
    const wrapper = mount(UserPrivacySetting);
    await flushPromises();

    await wrapper
      .get('[title="アカウントの2段階認証設定を切り替えます。"] .switch')
      .trigger("click");
    await wrapper.get(".totp-disable-input").setValue("123456");
    void wrapper.get("#content-disable-totp form").trigger("submit");

    expect(authStore.isTokenRotationPending).toBe(true);
    completeDisable({ data: {} });
    await flushPromises();

    expect(authStore.isTokenRotationPending).toBe(false);
    expect(wrapper.text()).toContain("2段階認証を無効化しました。");
    expect(wrapper.text()).toContain("2段階認証：OFF");
  });

  it("パスワード変更成功を案内して確認後にログイン画面へ置き換える", async () => {
    const appInitStore = useApplicationInitStore();
    appInitStore.appInitData.allowUserUpdatePassword = true;
    const authStore = useAuthStore();
    const wrapper = mount(UserPrivacySetting);

    await wrapper.get(".setting-btn").trigger("click");
    await wrapper.get("#current-password").setValue("current-password");
    await wrapper.get("#new-password").setValue("new-password");
    await wrapper.get("#check-password").setValue("new-password");
    await wrapper.get("#content-update-password").trigger("submit");
    await flushPromises();

    expect(authStore.isReauthenticationPending).toBe(true);
    expect(testState.routerReplace).not.toHaveBeenCalled();
    const dialog = wrapper.get(".reauthentication-content");
    expect(dialog.text()).toContain(
      "パスワードを変更しました。セキュリティ保護のため、もう一度ログインしてください。",
    );

    await dialog.get("button").trigger("click");
    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.isReauthenticationPending).toBe(false);
    expect(testState.routerReplace).toHaveBeenCalledWith("/account/login");
  });

  it("パスワード変更失敗時は再ログイン待ち状態を解除する", async () => {
    testState.apiPost.mockRejectedValueOnce(new Error("update failed"));
    const appInitStore = useApplicationInitStore();
    appInitStore.appInitData.allowUserUpdatePassword = true;
    const authStore = useAuthStore();
    const wrapper = mount(UserPrivacySetting);

    await wrapper.get(".setting-btn").trigger("click");
    await wrapper.get("#current-password").setValue("current-password");
    await wrapper.get("#new-password").setValue("new-password");
    await wrapper.get("#check-password").setValue("new-password");
    await wrapper.get("#content-update-password").trigger("submit");
    await flushPromises();

    expect(authStore.isReauthenticationPending).toBe(false);
    expect(wrapper.find(".reauthentication-content").exists()).toBe(false);
    expect(wrapper.text()).toContain("パスワードの更新に失敗しました。");
  });

  it("閉じているパスワード変更欄をDOMに残さない", async () => {
    const appInitStore = useApplicationInitStore();
    appInitStore.appInitData.allowUserUpdatePassword = true;
    const wrapper = mount(UserPrivacySetting);

    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0);

    await wrapper.get(".setting-btn").trigger("click");
    const form = wrapper.get("#content-update-password");
    expect(form.element.tagName).toBe("FORM");
    expect(form.findAll('input[type="password"]')).toHaveLength(3);
    expect(form.get("#current-password").attributes()).toMatchObject({
      name: "current-password",
      autocomplete: "current-password",
    });
    expect(form.get("#new-password").attributes()).toMatchObject({
      name: "new-password",
      autocomplete: "new-password",
    });
    expect(form.get("#check-password").attributes()).toMatchObject({
      name: "check-password",
      autocomplete: "new-password",
    });

    await form.get('button[type="button"]').trigger("click");
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0);
  });

  it("検索欄を認証情報ではなく検索用途として明示する", () => {
    const wrapper = mount(MapToolbar, {
      props: {
        activeLayer: "layer-1",
        masterLayerId: "layer-1",
        layerList: new Map(),
        isMasterLayer: true,
        isHttpsProtocol: true,
        mapObjectQueryFormData: { query1: "", query2: "" },
      },
    });

    expect(wrapper.get(".right-btn-header-zone").attributes()).toMatchObject({
      role: "search",
      "aria-label": "地図オブジェクト検索",
    });
    expect(wrapper.get("#search-textbox1").attributes()).toMatchObject({
      type: "text",
      name: "map-object-search-query-1",
      autocomplete: "off",
    });
    expect(wrapper.get("#search-textbox2").attributes()).toMatchObject({
      type: "text",
      name: "map-object-search-query-2",
      autocomplete: "off",
    });
  });
});
