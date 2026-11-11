import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import BackgroundMaps from "../BackgroundMaps.vue";
import { adminBackgroundMapsUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
const legacy = {
  id: 1,
  layer_name: "raster-old",
  label: "航空写真",
  url: "/tile/{z}/{x}/{y}.png",
  attribution: '<img src="x" onerror="alert(1)">出典',
  include_foreign_tiles: false,
  min_zoom: null,
  max_zoom: null,
};
const vector = {
  ...legacy,
  id: 2,
  layer_name: "vector",
  label: "ベクタ地図",
  kind: "vector",
  style_url: "/style.json",
};
let wrapper: VueWrapper;
const submit = async () => {
  await wrapper.get("form").trigger("submit");
  await flushPromises();
};
const edit = async (id: number) => {
  await wrapper.findAll("li")[id - 1]!.get("button").trigger("click");
};

beforeEach(() => {
  api.get.mockResolvedValue({ data: [legacy, vector] });
  wrapper = mount(BackgroundMaps, { attachTo: document.body });
});
afterEach(() => {
  wrapper.unmount();
  document.body.replaceChildren();
});

describe("背景地図設定", () => {
  it("文字数はUnicode文字数で検証し、絵文字をUTF-16のmaxlengthで切り詰めない", async () => {
    await flushPromises();
    await edit(2);
    for (const id of [
      "background-label",
      "background-layer-name",
      "background-url",
      "background-attribution",
    ])
      expect(wrapper.get(`#${id}`).attributes("maxlength")).toBeUndefined();
    const label = "😀".repeat(200);
    await wrapper.get("#background-label").setValue(label);
    api.put.mockResolvedValue({ data: { ...vector, label } });
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      `${adminBackgroundMapsUrl}/2`,
      expect.objectContaining({ label }),
    );
  });

  it("旧ラスタを読み、ID1種別を固定してnullズームと出典原文を更新する", async () => {
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(adminBackgroundMapsUrl);
    await edit(1);
    expect(wrapper.get<HTMLSelectElement>("#background-kind").element.disabled).toBe(true);
    expect(wrapper.get<HTMLInputElement>("#background-min-zoom").element.value).toBe("");
    expect(wrapper.get<HTMLTextAreaElement>("#background-attribution").element.value).toBe(
      legacy.attribution,
    );
    expect(wrapper.find("img").exists()).toBe(false);
    await wrapper.get("#background-label").setValue("更新した航空写真");
    api.put.mockResolvedValue({
      data: { ...legacy, kind: "raster", style_url: null, label: "更新した航空写真" },
    });
    await submit();
    expect(api.put).toHaveBeenCalledWith(`${adminBackgroundMapsUrl}/1`, {
      ...legacy,
      id: undefined,
      label: "更新した航空写真",
      kind: "raster",
      style_url: null,
    });
    expect(wrapper.get('[role="status"]').text()).toContain("保存しました");
    expect(wrapper.get("li").text()).toContain("更新した航空写真");
    expect(wrapper.get("legend").text()).toBe("背景地図を登録");
  });

  it("ベクタを新規登録して一覧へ反映し、編集でスタイルを変更できる", async () => {
    await flushPromises();
    await wrapper.get("#background-label").setValue("新しい背景");
    await wrapper.get("#background-layer-name").setValue("new-vector");
    await wrapper.get("#background-url").setValue("/fallback/{z}/{x}/{y}.png");
    await wrapper.get("#background-kind").setValue("vector");
    expect(wrapper.get('label[for="background-url"]').text()).toContain("互換用画像");
    await wrapper
      .get("#background-style-url")
      .setValue("https://tiles.example.test/styles/v2.json");
    await wrapper.get("#background-foreign").setValue(true);
    await wrapper.get("#background-min-zoom").setValue("0");
    await wrapper.get("#background-max-zoom").setValue("22");
    const created = {
      ...vector,
      id: 3,
      label: "新しい背景",
      layer_name: "new-vector",
      style_url: "https://tiles.example.test/styles/v2.json",
    };
    api.post.mockResolvedValue({ data: created });
    await submit();
    expect(api.post).toHaveBeenCalledWith(
      adminBackgroundMapsUrl,
      expect.objectContaining({
        kind: "vector",
        style_url: created.style_url,
        url: "/fallback/{z}/{x}/{y}.png",
        include_foreign_tiles: true,
        min_zoom: 0,
        max_zoom: 22,
      }),
    );
    await edit(3);
    expect(wrapper.get<HTMLInputElement>("#background-style-url").element.value).toBe(
      created.style_url,
    );
    await wrapper.get("#background-style-url").setValue("/styles/v3.json");
    api.put.mockResolvedValue({ data: { ...created, style_url: "/styles/v3.json" } });
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      `${adminBackgroundMapsUrl}/3`,
      expect.objectContaining({ style_url: "/styles/v3.json" }),
    );
  });

  it("ラスタへ変更すると隠れたスタイルをnullで保存し、編集取消は一覧と入力元を変更しない", async () => {
    await flushPromises();
    await edit(2);
    await wrapper.get("#background-kind").setValue("raster");
    expect(wrapper.find("#background-style-url").exists()).toBe(false);
    api.put.mockResolvedValue({ data: { ...vector, kind: "raster", style_url: null } });
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      `${adminBackgroundMapsUrl}/2`,
      expect.objectContaining({ kind: "raster", style_url: null }),
    );
    await edit(2);
    await wrapper.get("#background-label").setValue("取り消す入力");
    await wrapper
      .findAll("form button")
      .find((button) => button.text() === "編集をやめる")!
      .trigger("click");
    expect(wrapper.get("legend").text()).toBe("背景地図を登録");
    expect(wrapper.findAll("li")[1]!.text()).toContain("ベクタ地図");
    expect(wrapper.get<HTMLInputElement>("#background-label").element.value).toBe("");
  });

  it("入力が不正なら送信せず、保存失敗時は入力と一覧を維持して再試行できる", async () => {
    await flushPromises();
    await edit(2);
    await wrapper
      .get("#background-style-url")
      .setValue("http://invalid.test/style.json?secret=hidden");
    await submit();
    expect(api.put).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("スタイルURL");
    expect(wrapper.get('[role="alert"]').text()).not.toContain("secret");
    await wrapper.get("#background-style-url").setValue("/styles/v2.json");
    api.put.mockRejectedValueOnce(new Error("failure with provider url"));
    await submit();
    expect(wrapper.get('[role="alert"]').text()).toContain("保存できませんでした");
    expect(wrapper.get<HTMLInputElement>("#background-style-url").element.value).toBe(
      "/styles/v2.json",
    );
    expect(wrapper.findAll("li")[1]!.text()).toContain("/style.json");
    api.put.mockResolvedValue({ data: { ...vector, style_url: "/styles/v2.json" } });
    await submit();
    expect(wrapper.findAll("li")[1]!.text()).toContain("/styles/v2.json");
  });

  it("最初の一覧取得が完了するまで保存せず、取得失敗を再読み込みで回復する", async () => {
    wrapper.unmount();
    let reject!: (reason?: unknown) => void;
    api.get.mockReturnValueOnce(
      new Promise((_resolve, no) => {
        reject = no;
      }),
    );
    wrapper = mount(BackgroundMaps);
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(true);
    await submit();
    expect(api.post).not.toHaveBeenCalled();
    reject(new Error("offline"));
    await flushPromises();
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(true);
    await wrapper.get('[role="alert"] button').trigger("click");
    await flushPromises();
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(false);
    expect(wrapper.findAll("li")).toHaveLength(2);
  });

  it("保存待機中の重複送信を防ぎ、フォームと編集操作を無効にする", async () => {
    await flushPromises();
    await edit(2);
    let complete!: (value: unknown) => void;
    api.put.mockReturnValueOnce(
      new Promise((yes) => {
        complete = yes;
      }),
    );
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(true);
    expect(
      wrapper
        .findAll("li button")
        .every((button) => (button.element as HTMLButtonElement).disabled),
    ).toBe(true);
    complete({ data: vector });
    await flushPromises();
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(false);
  });
});
