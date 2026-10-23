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
async function setup(kind: "marker" | "shape" = "marker", restricted = false) {
  const selectedLayer = { ...layer, restrict_free_text: restricted };
  const pinia = createPinia();
  setActivePinia(pinia);
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  markers.mapObjectList.set("one", { ...marker });
  shapes.shapeList.set("shape", JSON.parse(JSON.stringify(shape)));
  useLayersStore().layersList = new Map([["layer", selectedLayer as any]]);
  const w = mount(Modal, {
    props: {
      isOpen: true,
      targetType: kind,
      targetId: kind === "marker" ? "one" : "shape",
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

describe("レイヤの自由記述制限", () => {
  it.each(["marker", "shape"] as const)(
    "%s: 本文を保持して読み取り専用にし、挿入を拒否する",
    async (kind) => {
      const { w } = await setup(kind, true);
      const textarea = w.get("textarea").element as HTMLTextAreaElement;
      const original = textarea.value;
      expect(textarea.readOnly).toBe(true);
      expect(textarea.placeholder).toBe("入力が制限されています。");
      expect(w.text()).toContain("名前と所属レイヤを変更できます");
      expect(w.text().includes("図形の頂点は地図上で編集できます")).toBe(kind === "shape");
      expect(w.findAll("button[disabled]").length).toBeGreaterThan(5);
      (w.vm as any).insertUploadedMarkdown("[添付](link)");
      await flushPromises();
      expect(textarea.value).toBe(original);
      expect(w.emitted("openImageUpload")).toBeUndefined();
      if (kind === "shape")
        expect(w.get('input[type="color"]').attributes()).toHaveProperty("disabled");
      await w.get('input[type="text"]').setValue("名称だけ変更");
      await button(w, "+更新").trigger("click");
      await flushPromises();
      const payload = vi.mocked(apiClient.put).mock.calls.at(-1)![1] as any;
      expect(payload.name).toBe("名称だけ変更");
      if (kind === "shape") expect(payload.geojson).toBeUndefined();
      else expect(payload.detail).toBe(original);
      w.unmount();
    },
  );
  it("制限中もフォーム回答を開ける", async () => {
    const { w } = await setup("marker", true);
    await button(w, "フォームで回答を登録").trigger("click");
    expect(w.findComponent(InputModal).props("isOpen")).toBe(true);
    w.unmount();
  });
  it("内容が空でもマーカー名だけで更新できる", async () => {
    const { w } = await setup();
    await w.get("textarea").setValue("");
    await button(w, "+更新").trigger("click");
    await flushPromises();
    expect(apiClient.put).toHaveBeenCalledWith(
      "/marker/update/one",
      expect.objectContaining({ name: "施設", detail: "" }),
    );
    w.unmount();
  });
});

describe("制限付きレイヤへの所属変更", () => {
  async function destinations(w: ReturnType<typeof mount>, sourceRestricted: boolean) {
    const layers = new Map([
      ["layer", { ...layer, restrict_free_text: sourceRestricted }],
      ["locked", { ...layer, id: "locked", name: "制限あり", restrict_free_text: true }],
      ["free", { ...layer, id: "free", name: "自由", restrict_free_text: false }],
    ]);
    useLayersStore().layersList = layers as any;
    await flushPromises();
  }
  it("編集中の内容を消さずに、制限先への変更を戻す", async () => {
    const { w } = await setup();
    await w.get("textarea").setValue("未保存の本文");
    await destinations(w, true); // A policy change arriving during editing.
    await w.get("select").setValue("locked");
    expect((w.get("select").element as HTMLSelectElement).value).toBe("layer");
    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("未保存の本文");
    expect(w.emitted("message")!.flat().join()).toContain("移動先を選択してください");
    w.unmount();
  });
  it("制限元から自由なレイヤへ移動する間は読み取り専用を維持する", async () => {
    const { w } = await setup("marker", true);
    await destinations(w, true);
    await w.get("select").setValue("free");
    expect((w.get("textarea").element as HTMLTextAreaElement).readOnly).toBe(true);
    await button(w, "+更新").trigger("click");
    await flushPromises();
    expect(apiClient.put).toHaveBeenCalledWith(
      "/marker/update/one",
      expect.objectContaining({ detail: "本文", layer_id: "free" }),
    );
    await w.setProps({ isOpen: false });
    await w.setProps({ isOpen: true });
    expect((w.get("textarea").element as HTMLTextAreaElement).readOnly).toBe(false);
    w.unmount();
  });
});

describe("回答由来の本文と自由記述の分離", () => {
  it.each(["marker", "shape"] as const)(
    "%s: 自由記述だけを編集し、回答部分と本文トークンを維持する",
    async (kind) => {
      vi.mocked(apiClient.get).mockImplementation(async (url) => ({
        data: String(url).endsWith("/body")
          ? {
              body: "自由記述回答部分",
              free_text: "自由記述",
              body_token: "body-token",
              sync_required: false,
              managed_markdown: "回答部分",
              parts: [
                { type: "text", text: "自由記述" },
                { type: "answer", id: "answer", markdown: "回答部分" },
              ],
            }
          : { form_schema: { fields: [{ id: "n" }] } },
      }));
      const { w } = await setup(kind);
      expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("自由記述");
      expect(w.get(".managed-answers").text()).toContain("回答部分");
      await w.get("textarea").setValue("変更後");
      await button(w, "+更新").trigger("click");
      await flushPromises();
      const body = vi.mocked(apiClient.put).mock.calls.at(-1)![1] as any;
      expect(body.free_text).toBe("変更後");
      expect(body.body_token).toBe("body-token");
      expect(kind === "marker" ? body.detail : body.geojson.properties.memo).toBe("変更後回答部分");
      w.unmount();
    },
  );
  it("旧本文の対応が曖昧な場合は全文を読み取り専用で保つ", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: String(url).endsWith("/body")
        ? {
            body: "本文",
            free_text: "",
            body_token: "token",
            sync_required: true,
            managed_markdown: "回答部分",
            parts: [],
          }
        : { form_schema: { fields: [] } },
    }));
    const { w } = await setup();
    expect((w.get("textarea").element as HTMLTextAreaElement).readOnly).toBe(true);
    expect(w.text()).toContain("対応確認が必要");
    (w.vm as any).insertUploadedMarkdown("変更");
    await flushPromises();
    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("本文");
    w.unmount();
  });
});
