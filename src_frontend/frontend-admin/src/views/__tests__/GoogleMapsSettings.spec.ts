import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import GoogleMapsSettings from "../GoogleMapsSettings.vue";
import { adminGoogleMapsSettingsUrl as url } from "@/router/urls";
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
describe("Google Maps settings", () => {
  it("既存キーを表示せず維持し、入力した新しいキーで接続確認後に保存できる", async () => {
    api.get.mockResolvedValue({ data: settings });
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
    api.get.mockResolvedValue({ data: settings });
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
});
