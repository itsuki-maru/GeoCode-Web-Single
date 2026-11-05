import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import MapToolbar from "../MapToolbar.vue";

it("ツール表示の右側から詳しい検索を開き、適用状態を表示する", async () => {
  const wrapper = mount(MapToolbar, {
    props: {
      activeLayer: "a",
      masterLayerId: "a",
      layerList: new Map(),
      isMasterLayer: true,
      isHttpsProtocol: true,
    },
  });
  try {
    const search = wrapper.get('[aria-label="詳しい検索と色分け"]');
    expect(search.element.previousElementSibling?.id).toBe("toolbar-open-elm");
    expect(search.get("img").attributes("src")).toContain("search_fill24.png");
    expect(search.attributes("aria-pressed")).toBe("false");
    await search.trigger("click");
    expect(wrapper.emitted("advancedSearch")).toEqual([[]]);
    await wrapper.setProps({ attributeSearchActive: true });
    expect(search.attributes("aria-pressed")).toBe("true");
    expect(search.attributes("title")).toBe("詳しい検索と色分け（適用中）");
  } finally {
    wrapper.unmount();
  }
});
