import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import MapToolbar from "../MapToolbar.vue";

it("places the advanced-search icon between search word 2 and reload, using the same button style", async () => {
  const wrapper = mount(MapToolbar, {
    props: {
      activeLayer: "a",
      masterLayerId: "a",
      layerList: new Map(),
      isMasterLayer: true,
      isHttpsProtocol: true,
      mapObjectQueryFormData: { query1: "", query2: "" },
    },
    global: { stubs: { CommonFormsModal: true } },
  });
  try {
    const search = wrapper.get('[aria-label="詳しい検索"]');
    expect(search.element.previousElementSibling?.id).toBe("search-textbox2");
    const reload = search.element.nextElementSibling!;
    expect(reload.querySelector("img")?.getAttribute("src")).toContain("update_fill24.png");
    expect(reload.classList.contains("btn-head-image-search")).toBe(true);
    expect(search.classes()).toContain("btn-head-image-search");
    expect(search.get("img").attributes("src")).toContain("search_fill24.png");
    expect(search.text()).toBe("");
    await search.trigger("click");
    expect(wrapper.emitted("advancedSearch")).toEqual([[]]);
    await wrapper.setProps({ attributeSearchActive: true });
    expect(search.attributes("aria-pressed")).toBe("true");
    expect(search.attributes("title")).toContain("適用中");
  } finally {
    wrapper.unmount();
  }
});
