import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import BackgroundMaps from "../BackgroundMaps.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import { adminBackgroundMapsUrl } from "@/router/urls";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/axiosClient", () => ({ default: api }));
const legacy = {
  id: 1,
  layer_name: "raster-old",
  label: "航空写真",
  url: "/tile/{z}/{x}/{y}.png",
  attribution: '<img src="x" onerror="alert(1)">出典',
  include_foreign_tiles: false,
  enabled: true,
  allow_temporary_share: true,
  allow_live_map: true,
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
const fallbacks = { normal: "1", temporary: "1", live: "1" };
const savedMessage = "背景地図を保存しました。地図の再読み込み時に反映されます。";
const deletedMessage = "背景地図を削除しました。地図の再読み込み時に反映されます。";
let wrapper: VueWrapper;
const submit = async () => {
  await wrapper.get("form").trigger("submit");
  await flushPromises();
};
const edit = async (id: number) => {
  await wrapper.findAll("li")[id - 1]!.get("button").trigger("click");
};
const acknowledgeMessage = async (text: string) => {
  const dialog = wrapper.get('[role="dialog"][aria-labelledby="message-modal-title"]');
  expect(dialog.isVisible()).toBe(true);
  expect(dialog.get("p").text()).toBe(text);
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  await dialog.get("button").trigger("click");
  expect(dialog.isVisible()).toBe(false);
};

beforeEach(() => {
  api.get.mockResolvedValue({ data: { backgrounds: [legacy, vector], fallbacks } });
  wrapper = mount(BackgroundMaps, { attachTo: document.body });
});
afterEach(() => {
  wrapper.unmount();
  document.body.replaceChildren();
});

describe("背景地図設定", () => {
  it("Google背景をURL入力なしで登録でき、既定背景の配信元は変更できない", async () => {
    await flushPromises();
    await edit(1);
    expect(wrapper.get<HTMLSelectElement>("#background-provider").element.disabled).toBe(true);
    // 新規登録へ戻してGoogle地図を選ぶ。
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("編集をやめる"))!
      .trigger("click");
    await wrapper.get("#background-provider").setValue("google");
    await wrapper.get("#background-google-type").setValue("terrain");
    await wrapper.get("#background-label").setValue("Google地形");
    await wrapper.get("#background-layer-name").setValue("google-terrain");
    expect(wrapper.find("#background-url").exists()).toBe(false);
    api.post.mockResolvedValue({
      data: {
        ...legacy,
        id: 3,
        provider: "google",
        google_map_type: "terrain",
        label: "Google地形",
      },
    });
    await submit();
    expect(api.post).toHaveBeenCalledWith(
      adminBackgroundMapsUrl,
      expect.objectContaining({
        provider: "google",
        google_map_type: "terrain",
        kind: "raster",
        url: "/google-maps/tiles/{z}/{x}/{y}",
        attribution: "",
      }),
    );
  });
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
    await acknowledgeMessage(savedMessage);
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
    await acknowledgeMessage(savedMessage);
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
    await acknowledgeMessage(savedMessage);
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

  it("公開先ごとにフォールバックを変更し、移動した公開先の利用可否だけを編集できる", async () => {
    const otherRaster = {
      ...legacy,
      id: 3,
      label: "代替ラスタ",
      layer_name: "other-raster",
      allow_live_map: false,
    };
    api.get.mockResolvedValueOnce({
      data: { backgrounds: [legacy, vector, otherRaster], fallbacks },
    });
    await flushPromises();
    await wrapper.get(".list-heading button").trigger("click");
    await flushPromises();
    const shared = wrapper.get<HTMLSelectElement>("#background-fallback-temporary");
    const live = wrapper.get<HTMLSelectElement>("#background-fallback-live");
    expect(
      [...shared.element.options]
        .filter((option) => !option.disabled)
        .map((option) => option.value),
    ).toEqual(["1", "3"]);
    expect(
      [...live.element.options].filter((option) => !option.disabled).map((option) => option.value),
    ).toEqual(["1"]);
    await shared.setValue("3");
    api.put.mockResolvedValueOnce({ data: { ...fallbacks, temporary: "3" } });
    await wrapper.findAll("form")[1]!.trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(`${adminBackgroundMapsUrl}/fallbacks`, {
      temporary: "3",
      live: "1",
    });
    expect(wrapper.get('[role="status"]').text()).toBe("フォールバックを保存しました。");
    await edit(1);
    expect(wrapper.get("#background-enabled").attributes()).toHaveProperty("disabled");
    expect(wrapper.get("#background-allow-live").attributes()).toHaveProperty("disabled");
    await wrapper.get("#background-allow-temporary").setValue(false);
    api.put.mockResolvedValueOnce({ data: { ...legacy, allow_temporary_share: false } });
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      `${adminBackgroundMapsUrl}/1`,
      expect.objectContaining({
        enabled: true,
        allow_temporary_share: false,
        allow_live_map: true,
      }),
    );
    expect(wrapper.get("li").text()).toContain("共有URLで使用不可");
  });

  it("無効化した背景も管理一覧で再編集でき、削除は確認後だけに実行できる", async () => {
    await flushPromises();
    expect(wrapper.get('button[aria-label="航空写真を削除"]').attributes()).toHaveProperty(
      "disabled",
    );
    await edit(2);
    await wrapper.get("#background-enabled").setValue(false);
    api.put.mockResolvedValueOnce({ data: { ...vector, enabled: false } });
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      `${adminBackgroundMapsUrl}/2`,
      expect.objectContaining({ enabled: false }),
    );
    expect(wrapper.findAll("li")[1]!.text()).toContain("無効");
    await acknowledgeMessage(savedMessage);
    await edit(2);
    expect(wrapper.get<HTMLInputElement>("#background-enabled").element.checked).toBe(false);
    await wrapper.get('button[aria-label="ベクタ地図を削除"]').trigger("click");
    expect(api.delete).not.toHaveBeenCalled();
    wrapper.getComponent(ConfirmModal).vm.$emit("cancel");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(2);
    await wrapper.get('button[aria-label="ベクタ地図を削除"]').trigger("click");
    api.delete.mockResolvedValueOnce({});
    wrapper.getComponent(ConfirmModal).vm.$emit("confirm");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith(`${adminBackgroundMapsUrl}/2`);
    expect(wrapper.findAll("li")).toHaveLength(1);
    expect(wrapper.get("legend").text()).toBe("背景地図を登録");
    await acknowledgeMessage(deletedMessage);
  });
});
