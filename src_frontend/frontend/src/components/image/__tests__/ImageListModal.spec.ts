import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ imageList: new Map(), getById: vi.fn(), queryImage: vi.fn() }));
vi.mock("@/stores/images", () => ({ useImageStore: () => store }));
vi.mock("@/setting", () => ({ baseUrl: "https://media.test", assetsUrl: "/assets/" }));
import Modal from "../ImageListModal.vue";
enableAutoUnmount(afterEach);
const items = [
  { id: "photo", filename: "photo.png", uuid_filename: "one.png", prefix: "!" },
  { id: "movie", filename: "movie.MP4", uuid_filename: "two.MP4", prefix: "?" },
  { id: "document", filename: "document.PDF", uuid_filename: "three.PDF", prefix: "" },
];
beforeEach(() => {
  store.imageList = new Map(items.map((item) => [item.id, item]));
  store.getById.mockImplementation((id) => store.imageList.get(id));
  store.queryImage.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const render = (https = true, attached = false) =>
  mount(Modal, {
    props: { isOpen: true, isHttps: https },
    ...(attached ? { attachTo: document.body } : {}),
  });
describe("media library actions", () => {
  it.each(items)("copies the correct $id markdown over HTTPS", async (item) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = render();
    const row = wrapper.findAll("tbody tr")[items.indexOf(item)]!;
    await row.findAll("td")[0]!.trigger("click");
    expect(writeText).toHaveBeenCalledWith(
      `${item.prefix}[${item.filename}](https://media.test/static/images/${item.uuid_filename})`,
    );
    expect(wrapper.emitted("message")).toContainEqual(["クリップボードにコピーしました。"]);
  });
  it.each(items)("offers selectable markdown for $id over HTTP", async (item) => {
    const wrapper = render(false, true);
    const cell = wrapper.findAll("tbody tr")[items.indexOf(item)]!.findAll("td")[0]!;
    expect(cell.text()).toBe(
      `${item.prefix}[${item.filename}](https://media.test/static/images/${item.uuid_filename})`,
    );
    await cell.trigger("click");
    expect(window.getSelection()?.toString().trim()).toBe(cell.text());
    window.getSelection()?.removeAllRanges();
  });
  it("searches the entered query and resets without deleting any library item", async () => {
    const wrapper = render();
    await wrapper.get("input").setValue("photo");
    await wrapper.get('[title="検索実行"]').trigger("click");
    await flushPromises();
    expect(store.queryImage).toHaveBeenLastCalledWith("photo");
    await wrapper.get('[title="検索結果をクリア"]').trigger("click");
    await flushPromises();
    expect(store.queryImage).toHaveBeenLastCalledWith("");
    expect(store.imageList.size).toBe(3);
  });
  it("keeps the library available after a failed search", async () => {
    store.queryImage.mockRejectedValueOnce(new Error("offline"));
    const wrapper = render();
    await wrapper.get('[title="検索実行"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
    expect(wrapper.emitted("close")).toBeUndefined();
  });
  it.each([true, false])(
    "forwards preview and deletion IDs without changing the source list (HTTPS %s)",
    async (https) => {
      const wrapper = render(https);
      for (const [index, item] of items.entries()) {
        const cells = wrapper.findAll("tbody tr")[index]!.findAll("td");
        await cells[1]!.trigger("click");
        await cells[2]!.trigger("click");
        expect(wrapper.emitted("preview")?.at(-1)).toEqual([item.uuid_filename, item.id]);
        expect(wrapper.emitted("deleteRequest")?.at(-1)).toEqual([item.id]);
      }
      expect(store.imageList.size).toBe(3);
      await wrapper
        .findAll("button")
        .find((b) => b.text() === "閉じる")!
        .trigger("click");
      expect(wrapper.emitted("close")).toHaveLength(1);
    },
  );
  it("renders an empty library without a selectable or deletable row", () => {
    store.imageList = new Map();
    expect(render().findAll("tbody tr")).toHaveLength(0);
  });
  it("does not throw when HTTP selection has no selection object", async () => {
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    const wrapper = render(false, true);
    await wrapper.findAll("tbody td")[0]!.trigger("click");
    expect(wrapper.emitted("message")).toBeUndefined();
  });
});
