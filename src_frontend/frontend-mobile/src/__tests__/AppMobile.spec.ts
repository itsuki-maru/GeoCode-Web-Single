import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, inject, type Ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AppMobile from "../AppMobile.vue";

vi.mock("../stores/appInits", () => ({
  useApplicationInitStore: () => ({ appInitData: { appTitle: "現場調査" } }),
}));
let provided: { header: Ref<boolean>; memo: Ref<boolean>; splash: Ref<boolean> };
const child = defineComponent({
  setup() {
    provided = {
      header: inject<Ref<boolean>>("isShowAppHeader")!,
      memo: inject<Ref<boolean>>("isShowMemoIcon")!,
      splash: inject<Ref<boolean>>("showSplashScreen")!,
    };
    return () => "モバイル地図";
  },
});
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});
async function ready() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: child },
      { path: "/mapview", component: child },
    ],
  });
  await router.push("/");
  await router.isReady();
  wrapper = mount(AppMobile, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return router;
}
it("地図へ移動してアプリ名を表示し、子画面によるヘッダー切替を反映する", async () => {
  const router = await ready();
  expect(router.currentRoute.value.path).toBe("/mapview");
  expect(wrapper!.get("#app-header").text()).toBe("現場調査");
  expect(wrapper!.text()).toContain("モバイル地図");
  expect(provided.memo.value).toBe(true);
  provided.header.value = false;
  await flushPromises();
  expect(wrapper!.get("#app-header").attributes("style")).toContain("display: none");
});
it("固定時刻から1350ms経過した時だけスプラッシュを閉じる", async () => {
  await ready();
  await vi.advanceTimersByTimeAsync(1349);
  expect(wrapper!.find("#splash-screen").exists()).toBe(true);
  expect(provided.splash.value).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(wrapper!.find("#splash-screen").exists()).toBe(false);
  expect(provided.splash.value).toBe(false);
});
it("Alt+Mのフォーカスを遅延し、破棄後はキーを処理しない", async () => {
  // メモ要素が存在するページでのイベント処理を確認する。
  document.body.innerHTML =
    '<div id="overlay-memo"><div id="content-memo"><textarea id="memo-textarea"></textarea></div></div>';
  await ready();
  const focus = vi.spyOn(document.getElementById("memo-textarea")!, "focus");
  const key = (altKey: boolean) => {
    const event = new KeyboardEvent("keydown", { key: "m", altKey, cancelable: true });
    window.dispatchEvent(event);
    return event;
  };
  expect(key(false).defaultPrevented).toBe(false);
  expect(key(true).defaultPrevented).toBe(true);
  await vi.advanceTimersByTimeAsync(299);
  expect(focus).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(focus).toHaveBeenCalledTimes(1);
  document.getElementById("content-memo")!.click();
  key(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(focus).toHaveBeenCalledTimes(1);
  key(true);
  await vi.advanceTimersByTimeAsync(300);
  document.getElementById("overlay-memo")!.click();
  document.getElementById("overlay-memo")!.click();
  key(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(focus).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1350);
  wrapper!.unmount();
  wrapper = undefined;
  expect(key(true).defaultPrevented).toBe(false);
});
