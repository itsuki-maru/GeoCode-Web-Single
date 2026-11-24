import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import GoogleMapsSettings from "../GoogleMapsSettings.vue";
import {
  adminGoogleMapsRoutesSettingsUrl as routesUrl,
  adminGoogleMapsSettingsUrl as url,
} from "@/router/urls";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
let wrapper: VueWrapper;
afterEach(() => {
  wrapper?.unmount();
  vi.resetAllMocks();
});
const settings = {
  revision: "revision",
  enabled: false,
  hasApiKey: true,
  keyStorageConfigured: true,
  language: "ja-JP",
  region: "JP",
  requestsPerMinute: 1200,
};
const routesSettings = {
  revision: "routes-revision",
  enabled: false,
  requestsPerMinute: 60,
};
function mockSettings() {
  api.get.mockImplementation(async (endpoint: string) => ({
    data: endpoint === routesUrl ? routesSettings : settings,
  }));
}
describe("Google Maps settings", () => {
  it("既存キーを表示せず維持し、入力した新しいキーで接続確認後に保存できる", async () => {
    mockSettings();
    api.post.mockResolvedValue({ data: { ok: true } });
    api.put.mockResolvedValue({ data: { ...settings, enabled: true, revision: "next" } });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.value).toBe("");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get("#google-tiles-key").setValue("replacement-key");
    await wrapper.findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      `${url}/check`,
      expect.objectContaining({ apiKey: "replacement-key", revision: "revision" }),
    );
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ apiKey: "replacement-key", enabled: true }),
    );
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.value).toBe("");
    expect(wrapper.get('[role="status"]').text()).toContain("保存しました");
  });
  it("設定の競合を表示し、入力したキーを失わない", async () => {
    mockSettings();
    api.put.mockRejectedValue({ response: { status: 409 } });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();
    await wrapper.get("#google-tiles-key").setValue("replacement-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("再読み込み");
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.value).toBe(
      "replacement-key",
    );
  });
  it("保存済みの共用キーでRoutes APIを有効にし、キーを送らず上限を保存する", async () => {
    mockSettings();
    api.put.mockResolvedValue({
      data: { ...routesSettings, enabled: true, requestsPerMinute: 24, revision: "next" },
    });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();

    const routes = wrapper.get(".routes-settings");
    const enabled = routes.get<HTMLInputElement>("#google-routes-enabled");
    expect(enabled.element.checked).toBe(false);
    expect(enabled.element.disabled).toBe(false);
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1);
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.value).toBe("");
    await wrapper.get("#google-tiles-key").setValue("unsaved-tiles-key");
    await enabled.setValue(true);
    await routes.get("#google-routes-limit").setValue("24");
    await routes.get("form").trigger("submit");
    await flushPromises();

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith(routesUrl, {
      revision: "routes-revision",
      enabled: true,
      requestsPerMinute: 24,
    });
    expect(api.put.mock.calls[0]?.[1]).not.toHaveProperty("apiKey");
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.value).toBe(
      "unsaved-tiles-key",
    );
    expect(routes.get('[role="status"]').text()).toContain("保存しました");
  });
  it("共用キーが未設定のときは保存を案内し、入力だけではRoutes APIを有効にできない", async () => {
    api.get.mockImplementation(async (endpoint: string) => ({
      data: endpoint === routesUrl ? routesSettings : { ...settings, hasApiKey: false },
    }));
    api.put.mockResolvedValue({ data: { ...settings, revision: "next" } });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();

    const routes = wrapper.get(".routes-settings");
    const enabled = routes.get<HTMLInputElement>("#google-routes-enabled");
    expect(enabled.element.disabled).toBe(true);
    expect(routes.get("#google-routes-key-issue").text()).toContain(
      "Google Maps APIキーを保存してください",
    );
    await wrapper.get("#google-tiles-key").setValue("new-shared-key");
    expect(enabled.element.disabled).toBe(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ apiKey: "new-shared-key" }),
    );
    expect(enabled.element.disabled).toBe(false);
    expect(routes.find("#google-routes-key-issue").exists()).toBe(false);
  });
  it("既に有効なRoutes APIはキーを利用できなくても上限変更と無効化ができる", async () => {
    api.get.mockImplementation(async (endpoint: string) => ({
      data:
        endpoint === routesUrl
          ? { ...routesSettings, enabled: true }
          : { ...settings, keyStorageConfigured: false },
    }));
    api.put
      .mockResolvedValueOnce({
        data: { ...routesSettings, revision: "next", enabled: true, requestsPerMinute: 24 },
      })
      .mockResolvedValueOnce({
        data: { ...routesSettings, enabled: false, requestsPerMinute: 24 },
      });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();

    const routes = wrapper.get(".routes-settings");
    const enabled = routes.get<HTMLInputElement>("#google-routes-enabled");
    expect(routes.get("#google-routes-key-issue").text()).toContain("GOOGLE_MAPS_ENCRYPTION_KEY");
    expect(enabled.element.disabled).toBe(false);
    await routes.get("#google-routes-limit").setValue("24");
    await routes.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(routesUrl, {
      revision: "routes-revision",
      enabled: true,
      requestsPerMinute: 24,
    });
    await enabled.setValue(false);
    await routes.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith(routesUrl, {
      revision: "next",
      enabled: false,
      requestsPerMinute: 24,
    });
    expect(enabled.element.disabled).toBe(true);
  });
  it("Routes設定の読み込みに失敗してもMap Tilesを操作でき、Routesだけ再読み込みできる", async () => {
    api.get.mockResolvedValueOnce({ data: settings }).mockRejectedValueOnce(new Error("offline"));
    api.get.mockResolvedValueOnce({ data: routesSettings });
    wrapper = mount(GoogleMapsSettings);
    await flushPromises();

    const routes = wrapper.get(".routes-settings");
    expect(wrapper.get<HTMLInputElement>("#google-tiles-key").element.disabled).toBe(false);
    expect(routes.get('[role="alert"]').text()).toContain("再試行");
    await routes.get("button").trigger("click");
    await flushPromises();

    expect(api.get).toHaveBeenLastCalledWith(routesUrl);
    expect(routes.get<HTMLInputElement>("#google-routes-enabled").element.disabled).toBe(false);
    expect(routes.find('[role="alert"]').exists()).toBe(false);
  });
});
