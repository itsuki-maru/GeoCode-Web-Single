import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserPrivacySetting from "@/components/UserPrivacySetting.vue";
import { useApplicationInitStore } from "@/stores/appInits";
import { useAuthStore } from "@/stores/auth";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("vue-router", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
beforeEach(() => {
  setActivePinia(createPinia());
  useApplicationInitStore().appInitData.allowUserUpdatePassword = true;
  api.get.mockResolvedValue({ data: { is_private: false, is_totp_enabled: false } });
  api.post.mockResolvedValue({ data: { otpauth_url: "otpauth://test" } });
  api.put.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const toggle = '[title="アカウントの2段階認証設定を切り替えます。"] .switch';
describe("アカウント設定の失敗系", () => {
  it.each([
    ["", "", "", "現在のパスワード"],
    ["current", "", "", "入力されていません"],
    ["current", "short", "short", "8文字以上"],
    ["current", "password1", "password2", "一致しません"],
  ])("不正なパスワード更新は送信しない: %s/%s", async (current, password, check, message) => {
    const w = mount(UserPrivacySetting);
    await flushPromises();
    await w.get(".setting-btn").trigger("click");
    await w.get("#current-password").setValue(current);
    await w.get("#new-password").setValue(password);
    await w.get("#check-password").setValue(check);
    await w.get("#content-update-password").trigger("submit");
    expect(w.text()).toContain(message);
    expect(api.post).not.toHaveBeenCalled();
    w.unmount();
  });
  it("ユーザー情報取得失敗から回復し、プライバシー変更を両方向へ送信する", async () => {
    api.get.mockRejectedValueOnce(new Error("offline"));
    const w = mount(UserPrivacySetting);
    await flushPromises();
    const target = '[title="アカウントのプライバシー設定を切り替えます。"] .switch';
    await w.get(target).trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(expect.any(String), { is_private: true });
    api.put.mockRejectedValueOnce(new Error("offline"));
    await w.get(target).trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(expect.any(String), { is_private: false });
    w.vm.openCloseUserSettingModal();
    await flushPromises();
    await w.get("#content-update-user .btn-zone button").trigger("click");
    expect(w.vm.isInitialized).toBe(true);
    w.unmount();
  });
  it("TOTP準備失敗を処理し、コード未入力と検証失敗では有効化しない", async () => {
    api.post.mockRejectedValueOnce(new Error("offline"));
    const w = mount(UserPrivacySetting);
    await flushPromises();
    await w.get(toggle).trigger("click");
    await flushPromises();
    await w.get("#content-gen-qrcode .btn-close button").trigger("click");
    await w.get(toggle).trigger("click");
    await flushPromises();
    await w.get(".post-code-btn").trigger("click");
    expect(w.text()).toContain("6桁の数字");
    await w.get(".message-btn-close button").trigger("click");
    api.post.mockRejectedValueOnce(new Error("invalid"));
    await w.get(".post-code-input").setValue("123456");
    await w.get(".post-code-btn").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("トークンが正しくありません");
    expect(useAuthStore().isTokenRotationPending).toBe(false);
    expect(w.vm.isTotpAuth).toBe(false);
    w.unmount();
  });
  it("TOTP解除の入力不足・キャンセル・失敗で認証状態を維持する", async () => {
    api.get.mockResolvedValue({ data: { is_private: false, is_totp_enabled: true } });
    const w = mount(UserPrivacySetting);
    await flushPromises();
    await w.get(toggle).trigger("click");
    await w.get("#content-disable-totp form").trigger("submit");
    expect(api.post).not.toHaveBeenCalled();
    await w.get('#content-disable-totp button[type="button"]').trigger("click");
    await w.get(toggle).trigger("click");
    await w.get(".totp-disable-input").setValue("123456");
    api.post.mockRejectedValueOnce(new Error("invalid"));
    await w.get("#content-disable-totp form").trigger("submit");
    await flushPromises();
    expect(w.text()).toContain("無効化できませんでした");
    expect(w.vm.isTotpAuth).toBe(true);
    expect(useAuthStore().isTokenRotationPending).toBe(false);
    w.unmount();
  });
});
