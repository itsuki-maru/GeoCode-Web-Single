import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMobileModalViewport } from "../useMobileModalViewport";

afterEach(() => vi.unstubAllGlobals());
const host = () =>
  mount({
    setup() {
      return { style: useMobileModalViewport() };
    },
    template: '<div :style="style"></div>',
  });

describe("モバイルモーダルの表示領域", () => {
  it("キーボード表示とスクロールに追従し、破棄後はイベントを解除する", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const remove = vi.spyOn(viewport, "removeEventListener");
    const w = host();
    expect(w.attributes("style")).toContain("--mobile-modal-height: 700px");
    viewport.height = 360;
    viewport.offsetTop = 42;
    viewport.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(w.attributes("style")).toContain("--mobile-modal-height: 360px");
    expect(w.attributes("style")).toContain("--mobile-modal-top: 42px");
    viewport.offsetTop = 70;
    viewport.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(w.attributes("style")).toContain("--mobile-modal-top: 70px");
    w.unmount();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(["resize", "scroll"]);
  });

  it("VisualViewportがない環境ではウィンドウの高さに追従する", async () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 680);
    const w = host();
    expect(w.attributes("style")).toContain("--mobile-modal-height: 680px");
    vi.stubGlobal("innerHeight", 400);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(w.attributes("style")).toContain("--mobile-modal-height: 400px");
    expect(w.attributes("style")).toContain("--mobile-modal-top: 0px");
    w.unmount();
  });
});
