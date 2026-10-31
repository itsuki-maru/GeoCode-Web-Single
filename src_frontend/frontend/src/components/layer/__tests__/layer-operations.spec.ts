import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ post: vi.fn(), initList: vi.fn(), layersList: new Map() }));
vi.mock("@/axiosClient", () => ({
  default: { post: deps.post, isAxiosError: (e: any) => !!e?.isAxiosError },
}));
vi.mock("@/stores/layers", () => ({ useLayersStore: () => deps }));
import Create from "../LayerCreateModal.vue";
import List from "../LayerListModal.vue";
import { addLayerUrl } from "@/router/urls";
import BaseModal from "@/components/common/BaseModal.vue";
const Choices = {
  name: "TileOverlayChoices",
  emits: ["busy", "changed", "loginRedirect"],
  template: '<div class="choices" />',
};
enableAutoUnmount(afterEach);
beforeEach(() => {
  deps.post.mockResolvedValue({ data: {} });
  deps.initList.mockResolvedValue(true);
  deps.layersList = new Map([
    ["a", { id: "a", name: "first" }],
    ["b", { id: "b", name: "second" }],
  ]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const create = () =>
  mount(Create, { props: { isOpen: true }, global: { stubs: { TileOverlayChoices: Choices } } });
const add = async (wrapper: ReturnType<typeof create>) => {
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "追加")!
    .trigger("click");
  await flushPromises();
};
describe("layer creation", () => {
  it("requires a name before creating a layer", async () => {
    const wrapper = create();
    await add(wrapper);
    expect(deps.post).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")).toContainEqual(["レイヤ名を入力してください。"]);
  });
  it("creates the named layer and refreshes the list only after success", async () => {
    const wrapper = create();
    await wrapper.get('input[type="text"]').setValue("new-layer");
    await add(wrapper);
    expect(deps.post).toHaveBeenCalledWith(`${addLayerUrl}?name=new-layer`);
    expect(deps.initList).toHaveBeenCalledOnce();
    expect(wrapper.emitted("message")).toContainEqual(["new-layerを作成しました。"]);
    expect(wrapper.get<HTMLInputElement>('input[type="text"]').element.value).toBe("");
  });
  it.each([
    { isAxiosError: true, response: { status: 400, data: "invalid name" } },
    { isAxiosError: true, response: { status: 401, data: "expired" } },
    { isAxiosError: true, response: { status: 500, data: "server" } },
    { isAxiosError: true, response: { status: 503, data: "unavailable" } },
    { isAxiosError: true },
    new Error("offline"),
  ])(
    "does not publish a creation or lose the name after a failed request (%j)",
    async (error: any) => {
      deps.post.mockRejectedValueOnce(error);
      const wrapper = create();
      await wrapper.get('input[type="text"]').setValue("pending");
      await add(wrapper);
      expect(deps.initList).not.toHaveBeenCalled();
      expect(wrapper.emitted("created")).toBeUndefined();
      expect(wrapper.get<HTMLInputElement>('input[type="text"]').element.value).toBe("pending");
      if (error.response?.status === 400)
        expect(wrapper.emitted("message")).toContainEqual(["invalid name"]);
      if (error.response?.status === 401) expect(wrapper.emitted("loginRedirect")).toHaveLength(1);
    },
  );
  it("prevents changing mode and overlay dismissal while tile selection is saving", async () => {
    const wrapper = create();
    await wrapper.get('input[value="tiles"]').setValue(true);
    const choices = wrapper.findComponent(Choices);
    choices.vm.$emit("busy", true);
    await flushPromises();
    expect(
      wrapper
        .findAll('input[type="radio"]')
        .every((radio) => radio.attributes("disabled") !== undefined),
    ).toBe(true);
    wrapper.getComponent(BaseModal).vm.$emit("close");
    expect(wrapper.emitted("close")).toBeUndefined();
    choices.vm.$emit("changed", [{ id: "tile-1" }]);
    choices.vm.$emit("loginRedirect");
    expect(wrapper.emitted("tilesChanged")).toContainEqual([[{ id: "tile-1" }]]);
    expect(wrapper.emitted("loginRedirect")).toHaveLength(1);
    choices.vm.$emit("busy", false);
    await flushPromises();
    wrapper.getComponent(BaseModal).vm.$emit("close");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
describe("layer list", () => {
  const render = async () => {
    const wrapper = mount(List, { props: { isOpen: true } });
    (wrapper.vm as any).initSearch();
    await flushPromises();
    return wrapper;
  };
  it("initializes, filters and restores the list without mutating source layers", async () => {
    const wrapper = await render();
    expect(wrapper.findAll("tbody tr").map((row) => row.findAll("td")[0]!.text())).toEqual([
      "second",
      "first",
    ]);
    await wrapper.get("input").setValue("first");
    await wrapper.get('[title="検索実行"]').trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    expect(wrapper.find("tbody").text()).toContain("first");
    await wrapper.get('[title="検索結果をクリア"]').trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    expect(deps.layersList.size).toBe(2);
    await wrapper.get("input").setValue("absent");
    await wrapper.get('[title="検索実行"]').trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(0);
  });
  it("forwards the exact selected layer for activation, rename and deletion", async () => {
    const wrapper = await render();
    const cells = wrapper.findAll("tbody tr")[0]!.findAll("td");
    await cells[0]!.trigger("click");
    await cells[1]!.trigger("click");
    await cells[2]!.trigger("click");
    expect(wrapper.emitted("changeActiveLayer")).toEqual([["b"]]);
    expect(wrapper.emitted("rename")).toEqual([["b", "second"]]);
    expect(wrapper.emitted("deleteLayer")).toEqual([["b"]]);
    expect(deps.layersList.size).toBe(2);
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "閉じる")!
      .trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
