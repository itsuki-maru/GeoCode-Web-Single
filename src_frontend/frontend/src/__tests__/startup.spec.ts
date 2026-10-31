import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  init: vi.fn(),
  mount: vi.fn(),
  use: vi.fn(),
  pinia: {},
  router: {},
}));
vi.mock("vue", () => ({ createApp: () => ({ use: api.use, mount: api.mount }) }));
vi.mock("pinia", () => ({ createPinia: () => api.pinia }));
vi.mock("../App.vue", () => ({ default: {} }));
vi.mock("../router", () => ({ default: api.router }));
vi.mock("../stores/appInits", () => ({ useApplicationInitStore: () => ({ init: api.init }) }));
let listeners: Array<[string, EventListener]>;
beforeEach(() => {
  vi.resetModules();
  listeners = [];
  api.init.mockReset().mockResolvedValue(undefined);
  api.mount.mockClear();
  api.use.mockClear();
  const listen = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    name: string,
    listener: EventListener,
    options: any,
  ) => {
    listeners.push([name, listener]);
    listen(name, listener, options);
  }) as any);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  listeners.forEach(([name, fn]) => window.removeEventListener(name, fn));
  vi.unstubAllGlobals();
});
it.each([true, false])(
  "初期情報を待って描画し、ServiceWorker登録の成功・失敗を処理する: %s",
  async (success) => {
    let complete!: () => void;
    api.init.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const register = vi.fn();
    if (success) register.mockResolvedValue({ scope: "/" });
    else register.mockRejectedValue(new Error("unsupported"));
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    await import("../main");
    expect(api.use.mock.calls).toEqual([[api.pinia], [api.router]]);
    expect(api.mount).not.toHaveBeenCalled();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.mount).toHaveBeenCalledExactlyOnceWith("#app");
    expect(api.init).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();
    expect(register).toHaveBeenCalledWith(expect.stringContaining("service-worker.js"));
    expect(console.log).toHaveBeenCalledWith(
      success ? "Service Worker registered: " : "Service Worker registration failed:",
      expect.anything(),
    );
  },
);
