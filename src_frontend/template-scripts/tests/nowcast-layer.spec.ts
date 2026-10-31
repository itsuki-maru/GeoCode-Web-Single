import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Leaflet は、型宣言を同梱していないブラウザー向けの依存ライブラリである。
import L from "leaflet";
import { NOWCAST_MAX_AGE } from "../src/map/common/nowcast-time";
import { createNowcastLayer } from "../src/map/common/nowcast-layer";

const feed = vi.hoisted(() => ({ subscribe: vi.fn(), receive: null as any, stop: vi.fn() }));
vi.mock("../src/map/common/nowcast-time", async (original) => ({
  ...(await original<object>()),
  nowcastFeed: { subscribe: feed.subscribe },
}));
const now = Date.parse("2026-09-15T03:01:00Z");
let cleanup: (() => void)[];
beforeEach(() => {
  cleanup = [];
  vi.spyOn(Date, "now").mockReturnValue(now);
  feed.stop.mockClear();
  feed.subscribe.mockImplementation((receive) => {
    feed.receive = receive;
    receive({ failed: false });
    return feed.stop;
  });
});
afterEach(() => {
  cleanup.reverse().forEach((stop) => stop());
  document.body.replaceChildren();
});
const setup = (afterControl?: HTMLElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const map = L.map(container).setView([35, 139], 6);
  cleanup.push(() => map.remove());
  const added = vi.fn();
  const result = createNowcastLayer(L, map, { minZoom: 3 }, "雨雲", {
    afterControl,
    onControlAdded: added,
  });
  cleanup.push(result.dispose);
  result.layer.addTo(map);
  return { ...result, map, added, container };
};
const time = {
  basetime: "20260915030000",
  validtime: "20260915030000",
  milliseconds: now - 60_000,
};

describe("nowcast layer lifecycle with a fixed UTC clock", () => {
  it("updates its tiles and explicitly Japanese time label, then reports image failures", () => {
    const { layer, container } = setup();
    expect(layer.getPrintStatus()).toEqual({ loading: true, failed: false });
    feed.receive({ failed: false, time });
    expect(layer._url).toContain("/20260915030000/none/20260915030000/surf/hrpns/");
    expect(container.textContent).toContain("12:00（日本時間）");
    expect(layer.getPrintStatus()).toEqual({ loading: false, failed: false });
    layer.fire("tileerror");
    expect(container.textContent).toContain("画像を取得できない");
    expect(layer.getPrintStatus().failed).toBe(true);
    feed.receive({ failed: true, time });
    expect(container.textContent).toContain("時刻更新に失敗");
  });

  it("hides stale tiles exactly at the age boundary without relying on wall-clock time", () => {
    const { layer, container } = setup();
    feed.receive({ failed: false, time });
    vi.mocked(Date.now).mockReturnValue(time.milliseconds + NOWCAST_MAX_AGE - 1);
    expect(layer.getPrintStatus().failed).toBe(false);
    vi.mocked(Date.now).mockReturnValue(time.milliseconds + NOWCAST_MAX_AGE);
    feed.receive({ failed: false, time });
    expect(layer.getPrintStatus().failed).toBe(true);
    expect(container.textContent).toContain("15分以上前のため非表示");
    expect(layer._url).toMatch(/^data:/);
  });

  it("pauses rendering for printing, resumes the latest state and retries failed images", () => {
    const { layer, map, container } = setup();
    map.fire("printpause");
    feed.receive({ failed: true });
    expect(container.textContent).toContain("取得中");
    map.fire("printresume");
    expect(container.textContent).toContain("取得できません");
    feed.receive({ failed: false, time });
    layer.fire("tileerror");
    layer.retryPrint();
    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(layer.getPrintStatus()).toEqual({ loading: true, failed: false });
    feed.receive({ failed: false, time });
    expect(layer.getPrintStatus().failed).toBe(false);
  });

  it("removes subscriptions and map listeners, including a control inserted after another control", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const { layer, map, dispose, added } = setup(anchor);
    expect(anchor.nextElementSibling?.classList.contains("nowcast-status")).toBe(true);
    const subscriptions = feed.subscribe.mock.calls.length;
    layer.fire("add");
    expect(feed.subscribe).toHaveBeenCalledTimes(subscriptions);
    map.removeLayer(layer);
    expect(feed.stop).toHaveBeenCalled();
    dispose();
    expect(added).toHaveBeenCalledTimes(1);
    layer.fire("add");
    map.fire("printresume");
    expect(feed.subscribe).toHaveBeenCalledTimes(subscriptions);
    expect(anchor.nextElementSibling?.classList.contains("nowcast-status")).toBe(false);
  });
});
