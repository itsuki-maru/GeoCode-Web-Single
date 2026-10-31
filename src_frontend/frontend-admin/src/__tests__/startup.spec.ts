import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  init: vi.fn(),
  mount: vi.fn(),
  use: vi.fn(),
  pinia: {},
  router: {},
}));
vi.mock("vue", () => ({ createApp: () => ({ use: api.use, mount: api.mount }) }));
vi.mock("pinia", () => ({ createPinia: () => api.pinia }));
vi.mock("../AdminApp.vue", () => ({ default: {} }));
vi.mock("../router", () => ({ default: api.router }));
vi.mock("../stores/appInits", () => ({
  useApplicationInitStore: (pinia: unknown) => {
    expect(pinia).toBe(api.pinia);
    return { init: api.init };
  },
}));
beforeEach(() => {
  vi.resetModules();
  api.init.mockReset();
  api.mount.mockClear();
  api.use.mockClear();
});
it("初期情報の取得が完了してから管理画面を描画する", async () => {
  let complete!: () => void;
  api.init.mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  await import("../mainAdmin");
  expect(api.use.mock.calls).toEqual([[api.pinia], [api.router]]);
  expect(api.mount).not.toHaveBeenCalled();
  complete();
  await Promise.resolve();
  expect(api.mount).toHaveBeenCalledExactlyOnceWith("#app");
});
