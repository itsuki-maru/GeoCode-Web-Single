import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { describe, expect, it } from "vitest";

import { useWindowSize } from "@/composables/useWindowSize";

const Harness = defineComponent({
  setup() {
    return useWindowSize();
  },
  template: '<div data-width="width" data-height="height">{{ width }}x{{ height }}</div>',
});

describe("ウィンドウサイズの監視", () => {
  it("マウント中はウィンドウサイズを監視しアンマウント後は停止する", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 800,
    });
    const wrapper = mount(Harness);
    expect(wrapper.text()).toBe("1024x800");

    window.innerWidth = 640;
    window.innerHeight = 480;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.text()).toBe("640x480");

    wrapper.unmount();
    window.innerWidth = 320;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.vm.width).toBe(640);
  });
});
