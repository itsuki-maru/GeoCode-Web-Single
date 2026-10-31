import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import { beforeEach, expect, it, vi } from "vitest";
import AdminApp from "../AdminApp.vue";
import { useApplicationInitStore } from "../stores/appInits";
const state = vi.hoisted(() => ({ route: null as any }));
vi.mock("vue-router", () => ({ useRoute: () => state.route }));
beforeEach(() => {
  setActivePinia(createPinia());
  state.route = reactive({ name: "login" });
});
it("ログイン時は管理ナビゲーションを隠し、ログイン後に表示する", async () => {
  useApplicationInitStore().appInitData.appTitle = "管理タイトル";
  const w = mount(AdminApp, {
    global: { stubs: { RouterLink: { template: "<a><slot /></a>" }, RouterView: true } },
  });
  expect(w.get("#application-title").text()).toBe("管理タイトル");
  expect(w.find("nav").exists()).toBe(false);
  state.route.name = "List";
  await w.vm.$nextTick();
  expect(w.findAll("nav a")).toHaveLength(3);
  expect(w.get("main").classes()).not.toContain("login-content");
  w.unmount();
});
