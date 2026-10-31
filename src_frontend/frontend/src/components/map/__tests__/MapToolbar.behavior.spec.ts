import { mount } from "@vue/test-utils";
import { ref, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MapToolbar from "../MapToolbar.vue";
const dimensions = vi.hoisted(() => ({ width: null as any, height: null as any }));
vi.mock("@/composables/useWindowSize", () => ({ useWindowSize: () => dimensions }));
beforeEach(() => {
  dimensions.width = ref(1200);
  dimensions.height = ref(800);
});
const open = (extra = {}) =>
  mount(MapToolbar, {
    props: {
      activeLayer: "a",
      masterLayerId: "a",
      layerList: new Map([
        ["a", { id: "a", name: "A" }],
        ["b", { id: "b", name: "B" }],
      ]) as any,
      isMasterLayer: true,
      isHttpsProtocol: true,
      mapObjectQueryFormData: { query1: "", query2: "" },
      ...extra,
    },
    global: {
      stubs: {
        CommonFormsModal: { name: "CommonFormsModal", props: ["isOpen"], template: "<div />" },
      },
    },
  });
describe("検索とレイヤ操作の通知", () => {
  it("入力は一度検索し、親からの反映は再検索せず、縦向きへの変更で第二条件を消す", async () => {
    const w = open();
    await w.get("#search-textbox1").setValue("first");
    expect(w.emitted("mapObjectSearch")).toEqual([[{ query1: "first", query2: "" }, false]]);
    await w.setProps({ mapObjectQueryFormData: { query1: "parent", query2: "second" } });
    expect(w.emitted("mapObjectSearch")).toHaveLength(1);
    await w.setProps({ mapObjectQueryFormData: { query1: "parent", query2: "second" } });
    expect(w.emitted("mapObjectSearch")).toHaveLength(1);
    dimensions.height.value = 1400;
    await nextTick();
    expect(w.get<HTMLInputElement>("#search-textbox2").element.value).toBe("");
    expect(w.emitted("mapObjectSearch")!.at(-1)).toEqual([{ query1: "parent", query2: "" }, false]);
    (w.vm as any).onMapObjectSearch(true);
    await nextTick();
    expect(w.emitted("mapObjectSearch")).toHaveLength(3);
    expect(w.emitted("mapObjectSearch")!.at(-1)).toEqual([{ query1: "", query2: "" }, true]);
    w.unmount();
  });
  it.each([true, false])("選択レイヤとmaster設定をリロードへ渡す: %s", async (master) => {
    const w = open({ isMasterLayer: master });
    await w.get("select").setValue("b");
    expect(w.emitted("update:activeLayer")).toEqual([["b"]]);
    await w
      .findAll("button")
      .find((b) => b.attributes("title")?.startsWith("リロード"))!
      .trigger("click");
    expect(w.emitted("reloadMap")![0]).toEqual([
      expect.stringContaining(`layer=a&is_master=${master}`),
      true,
    ]);
    w.unmount();
  });
  it("各ツールの要求を親へ通知し、共通フォームを閉じられる", async () => {
    const w = open();
    const events = [
      "newLayer",
      "imageUpload",
      "imageList",
      "qrCode",
      "onetimeSetting",
      "fullScreenMap",
      "exportJson",
      "importJson",
      "printMap",
    ];
    for (const [index, event] of events.entries()) {
      await w.findAll(".left-btn-header-zone button")[index]!.trigger("click");
      expect(w.emitted(event)).toEqual([[]]);
    }
    await w.get('button[title="共通フォーム作成・管理"]').trigger("click");
    const dialog = w.getComponent({ name: "CommonFormsModal" });
    expect(dialog.props("isOpen")).toBe(true);
    dialog.vm.$emit("close");
    await nextTick();
    expect(dialog.props("isOpen")).toBe(false);
    await w
      .findAll("button")
      .find((b) => b.attributes("title")?.startsWith("レイヤ一覧"))!
      .trigger("click");
    expect(w.emitted("layerList")).toEqual([[]]);
    w.unmount();
  });
});
