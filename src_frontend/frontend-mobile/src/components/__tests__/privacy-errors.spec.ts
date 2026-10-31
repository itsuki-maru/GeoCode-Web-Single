import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserPrivacySetting from "@/components/UserPrivacySetting.vue";
import { useApplicationInitStore } from "@/stores/appInits";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
beforeEach(() => {
  setActivePinia(createPinia());
  useApplicationInitStore().appInitData.allowUserUpdatePassword = true;
  api.get.mockResolvedValue({ data: { is_private: false, is_totp_enabled: false } });
  api.post.mockResolvedValue({ data: { otpauth_url: "otpauth://test" } });
  api.put.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
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
    await w.get("#content-update-user .btn-close button").trigger("click");
    expect(w.vm.isInitialized).toBe(true);
    w.unmount();
  });
});
