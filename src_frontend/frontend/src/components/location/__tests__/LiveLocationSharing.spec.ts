import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ delete: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

import LiveLocationSharing from "@/components/location/LiveLocationSharing.vue";

beforeEach(() => {
  vi.clearAllMocks();
  api.delete.mockResolvedValue({});
  api.put.mockResolvedValue({});
});

describe("LiveLocationSharing", () => {
  it("共有許可のないアカウントにはボタンを表示しない", async () => {
    api.get.mockResolvedValue({ data: { can_share_live_location: false } });
    const wrapper = mount(LiveLocationSharing);
    await flushPromises();
    expect(wrapper.find("button").exists()).toBe(false);
    wrapper.unmount();
  });

  it("利用者操作後に自身の最新位置で共有セッションを開始する", async () => {
    api.get.mockResolvedValue({ data: { can_share_live_location: true } });
    api.post.mockResolvedValue({ data: { session_id: "session-1", upload_interval_ms: 5000 } });
    const wrapper = mount(LiveLocationSharing);
    await flushPromises();
    wrapper.vm.receivePosition({
      latitude: 35,
      longitude: 139,
      accuracy: 5,
      heading: 90,
      speed: 8,
      timestamp: Date.now(),
    });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledOnce();
    expect(api.post.mock.calls[0][1]).toMatchObject({ latitude: 35, longitude: 139 });
    expect(wrapper.get("button").text()).toContain("位置共有中");
    wrapper.unmount();
  });
});
