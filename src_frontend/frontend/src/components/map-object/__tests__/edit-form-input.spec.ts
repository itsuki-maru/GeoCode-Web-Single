import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Modal from "../MapObjectEditModal.vue";
import InputModal from "../MapObjectFormInputModal.vue";
import Settings from "../MapObjectFormSettingsModal.vue";
import Message from "@/components/common/MessageModal.vue";
import apiClient from "@/axiosClient";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useLayersStore } from "@/stores/layers";
vi.mock("@/axiosClient", () => ({
  default: { get: vi.fn(), put: vi.fn(), isAxiosError: () => false },
}));
const marker = {
  id: "one",
  layer_id: "layer",
  marker_name: "施設",
  detail: "本文",
  latitude: 35,
  longitude: 139,
  update_at: "",
};
const shape = {
  id: "shape",
  layer_id: "layer",
  user_id: "u",
  shape_type: "polyline" as const,
  name: "管路",
  geojson: {
    type: "Feature" as const,
    properties: { memo: "メモ", style: { color: "#123456", weight: 3 } },
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [139, 35],
        [140, 36],
      ],
    },
  },
  created_at: "",
  updated_at: "",
};
const layer = { id: "layer", name: "レイヤ", is_master: false };
const button = (w: ReturnType<typeof mount>, text: string) =>
  w.findAll("button").find((b) => b.text() === text)!;
async function setup(kind: "marker" | "shape" = "marker") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  markers.mapObjectList.set("one", { ...marker });
  shapes.shapeList.set("shape", JSON.parse(JSON.stringify(shape)));
  useLayersStore().layersList = new Map([["layer", layer as any]]);
  const w = mount(Modal, {
    props: {
      isOpen: true,
      targetType: kind,
      targetId: kind === "marker" ? "one" : "shape",
      layerList: new Map([["layer", layer]]),
      isHttpsProtocol: true,
    },
    global: {
      plugins: [pinia],
      stubs: { MapObjectFormInputModal: true, MapObjectFormSettingsModal: true },
    },
  });
  await flushPromises();
  return { w, markers, shapes };
}
beforeEach(() => {
  vi.mocked(apiClient.get)
    .mockReset()
    .mockResolvedValue({ data: { form_schema: { fields: [{ id: "n" }] } } });
  vi.mocked(apiClient.put).mockReset().mockResolvedValue({});
});
describe("編集画面からのフォーム回答", () => {
  it("通常編集の保存に失敗した場合はフォームを開かず、編集内容を保持する", async () => {
    const { w, markers } = await setup();
    vi.spyOn(markers, "updateMapObject").mockResolvedValueOnce(null);
    await w.get("textarea").setValue("未保存の内容");
    await button(w, "フォームで回答を登録").trigger("click");
    w.findComponent(Message).vm.$emit("confirm");
    await flushPromises();
    expect(w.findComponent(InputModal).exists()).toBe(false);
    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("未保存の内容");
    expect(w.emitted("close")).toBeUndefined();
    w.unmount();
  });

  it.each(["marker", "shape"] as const)(
    "%s: 保存結果をストア・地図へ反映して編集画面を閉じ、再編集でも追記を保持する",
    async (kind) => {
      const { w, markers, shapes } = await setup(kind);
      expect(button(w, "入力フォーム設定")).toBeTruthy();
      await button(w, "フォームで回答を登録").trigger("click");
      expect(w.findComponent(InputModal).props("isOpen")).toBe(true);
      const object =
        kind === "marker"
          ? { ...marker, detail: "本文\n回答追記" }
          : {
              ...shape,
              geojson: {
                ...shape.geojson,
                properties: { ...shape.geojson.properties, memo: "メモ\n回答追記" },
              },
            };
      w.findComponent(InputModal).vm.$emit("saved", object);
      await flushPromises();
      expect((w.get("textarea").element as HTMLTextAreaElement).value).toContain("回答追記");
      expect(w.emitted("close")).toHaveLength(1);
      expect(w.emitted("updated")![0]![0]).toMatchObject({ objectType: kind, id: object.id });
      await w.setProps({ isOpen: false });
      await w.setProps({ isOpen: true });
      await flushPromises();
      await button(w, "+更新").trigger("click");
      await flushPromises();
      const body = vi.mocked(apiClient.put).mock.calls.at(-1)![1] as any;
      expect(kind === "marker" ? body.detail : body.geojson.properties.memo).toContain("回答追記");
      expect(w.emitted("close")).toHaveLength(2);
      expect(
        kind === "marker"
          ? markers.getById("one")?.detail
          : shapes.getById("shape")?.geojson.properties.memo,
      ).toContain("回答追記");
      w.unmount();
    },
  );
  it("未保存編集は確認し、キャンセルでは保持、保存成功後だけフォームを開く", async () => {
    const { w } = await setup();
    await w.get("textarea").setValue("編集中");
    await button(w, "フォームで回答を登録").trigger("click");
    expect(w.findComponent(Message).props("isOpen")).toBe(true);
    expect(w.findComponent(InputModal).exists()).toBe(false);
    w.findComponent(Message).vm.$emit("close");
    await flushPromises();
    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("編集中");
    await button(w, "フォームで回答を登録").trigger("click");
    w.findComponent(Message).vm.$emit("confirm");
    await flushPromises();
    expect(apiClient.put).toHaveBeenCalledWith(
      "/marker/update/one",
      expect.objectContaining({ detail: "編集中" }),
    );
    expect(w.findComponent(InputModal).props("isOpen")).toBe(true);
    expect(w.emitted("close")).toBeUndefined();
    w.unmount();
  });
  it("フォーム未設定・取得失敗でも通常編集は使え、設定保存後にボタンを更新する", async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { form_schema: { fields: [] } } });
    const { w } = await setup();
    expect(button(w, "フォームで回答を登録")).toBeUndefined();
    await button(w, "入力フォーム設定").trigger("click");
    w.findComponent(Settings).vm.$emit("saved");
    await flushPromises();
    expect(button(w, "フォームで回答を登録")).toBeTruthy();
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error("network"));
    await w.setProps({ isOpen: false });
    await w.setProps({ isOpen: true });
    await flushPromises();
    expect(button(w, "フォームで回答を登録")).toBeUndefined();
    await button(w, "+更新").trigger("click");
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});
