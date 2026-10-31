import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveLocationSharing from "../LiveLocationSharing.vue";
import { authCheckUrl, liveLocationSessionUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));

const NOW = new Date("2026-01-01T00:00:00.000Z");
const position = {
  latitude: 35,
  longitude: 139,
  accuracy: 5,
  heading: null,
  speed: null,
  timestamp: Date.parse("2025-12-31T23:59:59.000Z"),
};
const beacon = vi.fn();
enableAutoUnmount(afterEach);

beforeEach(() => {
  // 時計とスケジュールの両方を固定し、実時間の待機やタイムゾーン固有の期待値を使わない。
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, sendBeacon: beacon });
  api.get.mockResolvedValue({ data: { can_share_live_location: true } });
  api.post.mockResolvedValue({ data: { session_id: "session-1", upload_interval_ms: 2000 } });
  api.put.mockResolvedValue({});
  api.delete.mockResolvedValue({});
  beacon.mockReturnValue(true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function ready() {
  const wrapper = mount(LiveLocationSharing);
  await flushPromises();
  expect(api.get).toHaveBeenCalledWith(authCheckUrl);
  return wrapper;
}
async function sharing() {
  const wrapper = await ready();
  wrapper.vm.receivePosition(position);
  await wrapper.get("button").trigger("click");
  await flushPromises();
  return wrapper;
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

describe("位置共有のライフサイクル", () => {
  it.each([false, "true", undefined])(
    "明示的な許可がない場合は操作を表示しない: %s",
    async (value) => {
      api.get.mockResolvedValue({ data: { can_share_live_location: value } });
      const wrapper = await ready();
      expect(wrapper.find("button").exists()).toBe(false);
      expect(api.post).not.toHaveBeenCalled();
    },
  );

  it("認証確認が失敗した場合も操作を表示しない", async () => {
    api.get.mockRejectedValue(new Error("offline"));
    expect((await ready()).find("button").exists()).toBe(false);
  });

  it("操作前は送信せず、開始操作後も位置取得まで待機する", async () => {
    const wrapper = await ready();
    wrapper.vm.receiveError();
    await advance(10000);
    expect(api.post).not.toHaveBeenCalled();
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("button").text()).toBe("位置取得中…");
    expect(api.post).not.toHaveBeenCalled();
    wrapper.vm.receivePosition(position);
    await flushPromises();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(liveLocationSessionUrl, {
      latitude: 35,
      longitude: 139,
      accuracy_m: 5,
      heading_deg: null,
      speed_mps: null,
      observed_at: "2025-12-31T23:59:59.000Z",
      sequence_no: 0,
    });
    expect(wrapper.get("button").classes()).toContain("active");
  });

  it.each([null, 0])("timestampの欠落とUnix epochを区別する: %s", async (timestamp) => {
    const wrapper = await ready();
    wrapper.vm.receivePosition({ ...position, timestamp });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(api.post.mock.calls[0][1].observed_at).toBe(
      timestamp === null ? NOW.toISOString() : "1970-01-01T00:00:00.000Z",
    );
  });

  it("サーバー指定の間隔で最新位置と連番を送り、応答待ち中は重複送信しない", async () => {
    let resolve!: (value: object) => void;
    api.put.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = await sharing();
    wrapper.vm.receivePosition({ ...position, latitude: 36 });
    await advance(1999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledExactlyOnceWith(
      `${liveLocationSessionUrl}/session-1`,
      expect.objectContaining({ latitude: 36, sequence_no: 1 }),
    );
    await advance(10000);
    expect(api.put).toHaveBeenCalledTimes(1);
    resolve({});
    await flushPromises();
    await advance(2000);
    expect(api.put.mock.calls[1][1].sequence_no).toBe(2);
    expect(wrapper.get("button").text()).toContain("共有中");
  });

  it("送信間隔が未指定なら5000msを使う", async () => {
    api.post.mockResolvedValue({ data: { session_id: "session-1" } });
    await sharing();
    await advance(4999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it.each([500, undefined])(
    "一時的な送信失敗後は再試行し、成功すると共有状態に戻る: %s",
    async (status) => {
      api.put.mockRejectedValueOnce(status ? { response: { status } } : new Error("offline"));
      const wrapper = await sharing();
      await advance(2000);
      expect(wrapper.get("button").text()).toContain("再接続中");
      await advance(2000);
      expect(api.put.mock.calls.map(([, data]) => data.sequence_no)).toEqual([1, 2]);
      expect(wrapper.get("button").text()).toContain("共有中");
    },
  );

  it.each([403, 404, 409])(
    "セッションを継続できない応答では自動送信を停止する: %s",
    async (status) => {
      api.put.mockRejectedValueOnce({ response: { status } });
      const wrapper = await sharing();
      await advance(2000);
      expect(wrapper.get("button").text()).toContain("エラー（再試行）");
      expect(wrapper.get("button").classes()).not.toContain("active");
      await advance(20000);
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(beacon).not.toHaveBeenCalled();
    },
  );

  it("開始失敗後は利用者の再操作で再試行する", async () => {
    api.post.mockRejectedValueOnce(new Error("offline"));
    const wrapper = await sharing();
    expect(wrapper.get("button").text()).toContain("エラー（再試行）");
    await advance(10000);
    expect(api.post).toHaveBeenCalledTimes(1);
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(wrapper.get("button").text()).toContain("共有中");
  });

  it.each([false, true])("停止APIの成否によらず以降の送信を止める: failure=%s", async (failure) => {
    if (failure) api.delete.mockRejectedValue(new Error("offline"));
    const wrapper = await sharing();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledExactlyOnceWith(`${liveLocationSessionUrl}/session-1`);
    expect(wrapper.get("button").text()).toBe("現在位置を共有");
    await advance(20000);
    expect(api.put).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("位置取得待ち中の取消では停止APIを呼ばない", async () => {
    const wrapper = await ready();
    await wrapper.get("button").trigger("click");
    await wrapper.get("button").trigger("click");
    wrapper.vm.receivePosition(position);
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("位置取得エラーでタイマーを止め、停止操作を残す", async () => {
    const wrapper = await sharing();
    wrapper.vm.receiveError();
    await flushPromises();
    expect(wrapper.get("button").text()).toContain("エラー（停止）");
    await advance(20000);
    expect(api.put).not.toHaveBeenCalled();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledTimes(1);
  });

  it("非表示で停止通知し、復帰後は新しい位置を得て別セッションを開始する", async () => {
    const wrapper = await sharing();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(beacon).toHaveBeenCalledExactlyOnceWith(`${liveLocationSessionUrl}/session-1/stop`);
    await advance(20000);
    expect(api.put).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(wrapper.get("button").text()).toBe("位置取得中…");
    expect(api.post).toHaveBeenCalledTimes(1);
    api.post.mockResolvedValue({ data: { session_id: "session-2", upload_interval_ms: 2000 } });
    wrapper.vm.receivePosition({ ...position, longitude: 140 });
    await flushPromises();
    expect(api.post.mock.calls[1][1]).toMatchObject({ longitude: 140, sequence_no: 0 });
    await advance(2000);
    expect(api.put).toHaveBeenCalledWith(
      `${liveLocationSessionUrl}/session-2`,
      expect.objectContaining({ sequence_no: 1 }),
    );
  });

  it("非表示中に開始せず、復帰後の新しい位置を待つ", async () => {
    const wrapper = await ready();
    wrapper.vm.receivePosition(position);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await wrapper.get("button").trigger("click");
    expect(api.post).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    wrapper.vm.receivePosition(position);
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it.each(["pagehide", "unmount"])(
    "離脱時に一度だけ停止通知し、タイマーとイベントを解除する: %s",
    async (event) => {
      const wrapper = await sharing();
      if (event === "pagehide") window.dispatchEvent(new Event("pagehide"));
      wrapper.unmount();
      expect(beacon).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("pagehide"));
      document.dispatchEvent(new Event("visibilitychange"));
      await advance(20000);
      expect(api.put).not.toHaveBeenCalled();
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(beacon).toHaveBeenCalledTimes(1);
    },
  );

  it("sendBeacon非対応でも離脱時に例外や追加送信を起こさない", async () => {
    const wrapper = await sharing();
    vi.stubGlobal("navigator", Object.create(null));
    expect(() => wrapper.unmount()).not.toThrow();
    await advance(20000);
    expect(api.put).not.toHaveBeenCalled();
  });
});
