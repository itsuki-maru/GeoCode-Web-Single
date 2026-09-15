import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNowcastFeed,
  isNowcastUrl,
  NOWCAST_URL,
  selectNowcastTime,
} from "../src/map/common/nowcast-time";

const record = (time = "20260915030000") => ({
  basetime: time,
  validtime: time,
  elements: ["hrpns"],
});
let cleanups: (() => void)[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T03:01:00Z"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  cleanups = [];
});
afterEach(() => {
  cleanups.forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("nowcast time resolution", () => {
  it("times out a stalled request and retries invalid responses", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      )
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValue({ ok: true, json: async () => [record()] });
    vi.stubGlobal("fetch", fetcher);
    const listener = vi.fn();
    cleanups.push(createNowcastFeed().subscribe(listener));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(listener.mock.lastCall?.[0].failed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0].failed).toBe(true);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(listener.mock.lastCall?.[0].failed).toBe(false);
  });
  it("does not regress to an older response from an upstream cache", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [record()] })
      .mockResolvedValue({ ok: true, json: async () => [record("20260915025500")] });
    vi.stubGlobal("fetch", fetcher);
    const listener = vi.fn();
    cleanups.push(createNowcastFeed().subscribe(listener));
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0].time.validtime).toBe("20260915030000");
  });
  it("recognizes only the explicit latest rainfall template", () => {
    expect(isNowcastUrl(NOWCAST_URL)).toBe(true);
    for (const url of [
      NOWCAST_URL.replace("www.jma.go.jp", "evil.test"),
      NOWCAST_URL + "?x=1",
      NOWCAST_URL.replaceAll("latest", "20260915030000"),
      NOWCAST_URL.replace("hrpns", "thns"),
    ]) {
      expect(isNowcastUrl(url)).toBe(false);
    }
  });
  it("selects the newest analysis regardless of order and excludes forecasts, invalid dates and future times", () => {
    const times = [
      record("20260915025500"),
      record(),
      record("20260230000000"),
      record("20260915030500"),
      { ...record(), validtime: "20260915031000" },
      { ...record("20260915030100"), elements: ["thns"] },
      null,
    ];
    expect(selectNowcastTime(times).validtime).toBe("20260915030000");
    for (const data of [null, {}, [], [{ ...record(), basetime: "<script>" }]])
      expect(() => selectNowcastTime(data)).toThrow();
  });
  it("shares polling and aborts only when the final subscriber leaves", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [record()] });
    vi.stubGlobal("fetch", fetcher);
    const feed = createNowcastFeed();
    const a = vi.fn(),
      b = vi.fn();
    const stopA = feed.subscribe(a),
      stopB = feed.subscribe(b);
    cleanups.push(stopA, stopB);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(b.mock.lastCall?.[0].time.validtime).toBe("20260915030000");
    stopA();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stopB();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("ignores a late response from an aborted subscription", async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({ ok: true, json: async () => [record("20260915025500")] });
    vi.stubGlobal("fetch", fetcher);
    const feed = createNowcastFeed();
    const old = vi.fn();
    const stop = feed.subscribe(old);
    stop();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    const current = vi.fn();
    cleanups.push(feed.subscribe(current));
    await flush();
    resolve({ ok: true, json: async () => [record()] });
    await flush();
    expect(current.mock.lastCall?.[0].time.validtime).toBe("20260915025500");
    expect(old).toHaveBeenCalledTimes(1);
  });
  it("pauses on hidden tabs and checks immediately on return", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [record()] });
    vi.stubGlobal("fetch", fetcher);
    const feed = createNowcastFeed();
    cleanups.push(feed.subscribe(vi.fn()));
    await flush();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retains the last time during failures, backs off, and recovers", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [record()] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => [record()] });
    vi.stubGlobal("fetch", fetcher);
    const listener = vi.fn();
    cleanups.push(createNowcastFeed().subscribe(listener));
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      failed: true,
      time: { validtime: "20260915030000" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(listener.mock.lastCall?.[0].failed).toBe(false);
  });
});
