import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, inject, type Ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.vue";
import { disableTokenUrl, externalSiteUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("@/stores/appInits", () => ({
  useApplicationInitStore: () => ({ appInitData: { appTitle: "テスト地図" } }),
}));
const privacy = vi.fn();
let provided: {
  buttons: Ref<boolean>;
  splash: Ref<boolean>;
  fetch: () => Promise<void>;
  reset: () => void;
};
const child = defineComponent({
  setup(_, { expose }) {
    provided = {
      buttons: inject<Ref<boolean>>("isShowOtherFunctionButtonZone")!,
      splash: inject<Ref<boolean>>("showSplashScreen")!,
      fetch: inject<() => Promise<void>>("fetchExternalSiteHref")!,
      reset: inject<() => void>("resetExternalSiteHref")!,
    };
    expose({ openUserPrivacySettings: privacy });
    return () => "地図画面";
  },
});
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  api.get.mockResolvedValue({ data: { url: "https://example.test/user-site" } });
  api.post.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function ready() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: child },
      { path: "/mapview", component: child },
      { path: "/account/login", component: { template: "<div>ログイン画面</div>" } },
    ],
  });
  await router.push("/");
  await router.isReady();
  wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: { transition: true, ExternalSiteUrlSettingModal: true, MessageModal: true },
    },
  });
  await flushPromises();
  return router;
}
const externalLink = () => wrapper!.get('a[title="外部サイトを開く"]');
const settings = () => wrapper!.getComponent({ name: "ExternalSiteUrlSettingModal" });
const memo = () => wrapper!.get("#overlay-memo");
const memoVisible = () => !memo().attributes("style")?.includes("display: none");

describe("アプリ共通操作", () => {
  it("初期画面から地図へ移動し、アプリ名と利用者の外部URLを表示する", async () => {
    const router = await ready();
    expect(router.currentRoute.value.path).toBe("/mapview");
    expect(wrapper!.get(".app-header").text()).toBe("テスト地図");
    expect(wrapper!.text()).toContain("地図画面");
    expect(api.get).toHaveBeenCalledExactlyOnceWith(externalSiteUrl);
    expect(externalLink().attributes("href")).toBe("https://example.test/user-site");
    expect(externalLink().attributes("rel")).toBe("noopener noreferrer");
  });

  it("1350ms後にスプラッシュを閉じ、子画面へ公開する状態も更新する", async () => {
    await ready();
    expect(wrapper!.find("#splash-screen").exists()).toBe(true);
    expect(provided.splash.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1349);
    expect(wrapper!.find("#splash-screen").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper!.find("#splash-screen").exists()).toBe(false);
    expect(provided.splash.value).toBe(false);
  });

  it("メモのフォーカスを描画後に移し、開閉しても入力を保持する", async () => {
    await ready();
    const textarea = wrapper!.get<HTMLTextAreaElement>("#memo-textarea");
    const focus = vi.spyOn(textarea.element, "focus");
    expect(memoVisible()).toBe(false);
    await wrapper!.get('button[title="Memo"]').trigger("click");
    expect(memoVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(focus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(focus).toHaveBeenCalledTimes(1);
    await textarea.setValue("作業メモ");
    await wrapper!.get("#content-memo button").trigger("click");
    expect(memoVisible()).toBe(false);
    await wrapper!.get('button[title="Memo"]').trigger("click");
    expect(textarea.element.value).toBe("作業メモ");
  });

  it("メモ内容のクリックは閉じず、背景のクリックで閉じる", async () => {
    await ready();
    await memo().trigger("click");
    expect(memoVisible()).toBe(false);
    await wrapper!.get('button[title="Memo"]').trigger("click");
    await wrapper!.get("#content-memo").trigger("click");
    expect(memoVisible()).toBe(true);
    await memo().trigger("click");
    expect(memoVisible()).toBe(false);
  });

  it("Alt+Mでメモを開閉し、他のキーは妨げない", async () => {
    await ready();
    const ordinary = new KeyboardEvent("keydown", { key: "m", cancelable: true });
    window.dispatchEvent(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    expect(memoVisible()).toBe(false);
    const shortcut = new KeyboardEvent("keydown", { key: "m", altKey: true, cancelable: true });
    window.dispatchEvent(shortcut);
    await flushPromises();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(memoVisible()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", altKey: true }));
    await flushPromises();
    expect(memoVisible()).toBe(false);
  });

  it("破棄後にはショートカットのリスナーを残さない", async () => {
    await ready();
    await vi.advanceTimersByTimeAsync(1350);
    wrapper!.unmount();
    wrapper = undefined;
    const shortcut = new KeyboardEvent("keydown", { key: "m", altKey: true, cancelable: true });
    window.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("外部URLの取得失敗時は既定URLを維持する", async () => {
    api.get.mockRejectedValueOnce(new Error("offline"));
    await ready();
    expect(externalLink().attributes("href")).toBe("https://project.geocode-web.com");
  });

  it("子画面に提供した更新・リセット処理を反映する", async () => {
    await ready();
    provided.reset();
    await flushPromises();
    expect(externalLink().attributes("href")).toBe("https://project.geocode-web.com");
    api.get.mockResolvedValueOnce({ data: { url: "https://example.test/updated" } });
    await provided.fetch();
    await flushPromises();
    expect(externalLink().attributes("href")).toBe("https://example.test/updated");
    provided.buttons.value = false;
    await flushPromises();
    expect(wrapper!.find(".other-function-btn-zone").exists()).toBe(false);
  });

  it("設定画面の保存後に外部URLを再取得し、閉じる操作を反映する", async () => {
    await ready();
    await wrapper!.get('button[title="外部サイトURL設定"]').trigger("click");
    expect(settings().props("isOpen")).toBe(true);
    api.get.mockResolvedValueOnce({ data: { url: "https://example.test/saved" } });
    settings().vm.$emit("saved");
    await flushPromises();
    expect(externalLink().attributes("href")).toBe("https://example.test/saved");
    settings().vm.$emit("close");
    await flushPromises();
    expect(settings().props("isOpen")).toBe(false);
  });

  it("子画面のメッセージを表示し、閉じると内容を消す", async () => {
    await ready();
    settings().vm.$emit("message", "保存しました。");
    await flushPromises();
    const message = wrapper!.getComponent({ name: "MessageModal" });
    expect(message.props()).toMatchObject({ isOpen: true, message: "保存しました。" });
    message.vm.$emit("close");
    await flushPromises();
    expect(message.props()).toMatchObject({ isOpen: false, message: "" });
  });

  it("利用者設定の操作を現在の地図画面へ伝える", async () => {
    await ready();
    await wrapper!.get('button[title^="ユーザー設定"]').trigger("click");
    expect(privacy).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "ログアウトAPIの成否によらずログインへ戻り、外部URLと操作表示をリセットする: failure=%s",
    async (failure) => {
      const router = await ready();
      if (failure) api.post.mockRejectedValueOnce(new Error("offline"));
      await wrapper!.get('button[title^="ログアウト"]').trigger("click");
      await flushPromises();
      expect(api.post).toHaveBeenCalledExactlyOnceWith(disableTokenUrl);
      expect(router.currentRoute.value.path).toBe("/account/login");
      expect(wrapper!.find(".other-function-btn-zone").exists()).toBe(false);
      expect(provided.buttons.value).toBe(false);
      provided.buttons.value = true;
      await flushPromises();
      expect(externalLink().attributes("href")).toBe("https://project.geocode-web.com");
    },
  );

  it("設定画面の認証切れ通知でもログアウトして遷移する", async () => {
    const router = await ready();
    settings().vm.$emit("loginRedirect");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(disableTokenUrl);
    expect(router.currentRoute.value.path).toBe("/account/login");
  });
});
