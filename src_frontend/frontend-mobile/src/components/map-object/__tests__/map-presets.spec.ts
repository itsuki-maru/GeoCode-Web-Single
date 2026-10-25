import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "@/axiosClient";
import SaveMapPresetModal from "../SaveMapPresetModal.vue";
import SavedMapPresetsModal from "../SavedMapPresetsModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import type { MapPresetDraft, SavedMapPreset } from "@/utils/answer-map-presets";

vi.mock("@/axiosClient", () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const endpoint = "/form-answers/map-presets";
const draft = (): MapPresetDraft => ({
  kind: "filter",
  definition: {
    common_form_id: "form",
    conditions: [{ field_id: "year", field_type: "number", op: "gte", value: "50", upper: null }],
  },
});
const preset = (): SavedMapPreset => ({
  ...draft(),
  id: "saved-one",
  name: "50年以上",
  schema_version: 1,
  display: {
    form_label: "点検台帳",
    fields: [{ id: "year", field_type: "number", label: "耐用年数" }],
  },
  create_at: "2026-10-25T01:00:00",
});
const wrappers: VueWrapper[] = [];
const saveModal = (value = draft()) => {
  const wrapper = mount(SaveMapPresetModal, { props: { isOpen: true, draft: value, endpoint } });
  wrappers.push(wrapper);
  return wrapper;
};
const listModal = () => {
  const wrapper = mount(SavedMapPresetsModal, { props: { isOpen: true, endpoint } });
  wrappers.push(wrapper);
  return wrapper;
};
const button = (wrapper: VueWrapper, label: string) =>
  wrapper.findAll("button").find((item) => item.text() === label)!;
const confirm = (wrapper: VueWrapper) => wrapper.getComponent(MessageModal);
const page = (items = [preset()], total = items.length, number = 1) => ({
  data: { items, total, page: number, page_size: 20 },
});
beforeEach(() => {
  vi.mocked(apiClient.get).mockResolvedValue(page());
  vi.mocked(apiClient.post).mockResolvedValue({ data: preset() });
  vi.mocked(apiClient.delete).mockResolvedValue({});
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("検索条件の保存モーダル", () => {
  it("閉じる・Escapeは保存せず、空の条件名は送信しない", async () => {
    const wrapper = saveModal();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.get('[role="alert"]').text()).toContain("条件名");
    expect(apiClient.post).not.toHaveBeenCalled();
    await button(wrapper, "閉じる").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted("close")).toHaveLength(2);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it("開始時の入力を複製し、名前の空白を除いた新規保存だけを送る", async () => {
    const value = draft(),
      wrapper = saveModal(value);
    await wrapper.get('[aria-label="条件名"]').setValue("  50年以上  ");
    value.definition.conditions[0].value = "999";
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledWith(
      endpoint,
      { ...draft(), name: "50年以上", schema_version: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(wrapper.emitted("saved")![0][0]).toEqual(preset());
  });
  it("送信中の二重送信・閉じる・印刷を防止し、失敗後は名前を維持して再試行できる", async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(apiClient.post).mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const wrapper = saveModal();
    await wrapper.get('[aria-label="条件名"]').setValue("再試行用");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    await button(wrapper, "閉じる").trigger("click");
    const printEvent = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(printEvent);
    expect(printEvent.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    reject({ response: { data: { error: "保存に失敗しました" } } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("保存に失敗しました");
    expect(wrapper.get<HTMLInputElement>('[aria-label="条件名"]').element.value).toBe("再試行用");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("saved")).toHaveLength(1);
  });
  it("閉じた後に届いた保存応答を通知しない", async () => {
    let resolve!: (result: unknown) => void;
    vi.mocked(apiClient.post).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const wrapper = saveModal();
    await wrapper.get('[aria-label="条件名"]').setValue("遅延");
    await wrapper.get("form").trigger("submit");
    const signal = vi.mocked(apiClient.post).mock.calls[0][2]!.signal!;
    await wrapper.setProps({ isOpen: false });
    expect(signal.aborted).toBe(true);
    resolve({ data: preset() });
    await flushPromises();
    expect(wrapper.emitted("saved")).toBeUndefined();
  });
});

describe("保存した検索条件の一覧", () => {
  it("取得した名前・種別・項目名を表示し、呼び出しは複製を通知するだけ", async () => {
    const wrapper = listModal();
    await flushPromises();
    expect(apiClient.get).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ params: { page: 1, page_size: 20 } }),
    );
    const row = wrapper.get("tbody tr");
    expect(row.text()).toContain("地図上で絞り込み");
    expect(row.text()).toContain("50年以上");
    expect(row.text()).toContain("点検台帳");
    expect(row.text()).toContain("耐用年数 以上 50");
    await button(wrapper, "呼び出し").trigger("click");
    const restored = wrapper.emitted("restore")![0][0] as SavedMapPreset;
    expect(restored).toEqual(preset());
    restored.definition.conditions[0].value = "100";
    expect(row.text()).toContain("耐用年数 以上 50");
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(apiClient.delete).not.toHaveBeenCalled();
  });
  it("削除の閉じるは変更せず、確認後にだけDELETEして一覧を再取得する", async () => {
    const wrapper = listModal();
    await flushPromises();
    await button(wrapper, "削除").trigger("click");
    expect(confirm(wrapper).props()).toMatchObject({
      isOpen: true,
      message: "削除しますか？",
      zIndex: 120,
    });
    expect(apiClient.delete).not.toHaveBeenCalled();
    await button(confirm(wrapper), "閉じる").trigger("click");
    expect(confirm(wrapper).props("isOpen")).toBe(false);
    expect(apiClient.delete).not.toHaveBeenCalled();
    await button(wrapper, "削除").trigger("click");
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([]));
    await button(confirm(wrapper), "削除").trigger("click");
    await flushPromises();
    expect(apiClient.delete).toHaveBeenCalledWith(
      `${endpoint}/saved-one`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(wrapper.find("tbody").exists()).toBe(false);
    expect(wrapper.text()).toContain("保存した検索条件はありません。");
    expect(confirm(wrapper).props("isOpen")).toBe(false);
  });
  it("Escapeは最前面の削除確認だけ閉じ、送信中は確認も一覧も閉じない", async () => {
    const wrapper = listModal();
    await flushPromises();
    await button(wrapper, "削除").trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushPromises();
    expect(confirm(wrapper).props("isOpen")).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
    let resolve!: (result: unknown) => void;
    vi.mocked(apiClient.delete).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    await button(wrapper, "削除").trigger("click");
    await button(confirm(wrapper), "削除").trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushPromises();
    expect(confirm(wrapper).props("isOpen")).toBe(true);
    expect(confirm(wrapper).props("busy")).toBe(true);
    expect(wrapper.emitted("close")).toBeUndefined();
    resolve({});
    await flushPromises();
  });
  it("削除失敗は確認を閉じて一覧に表示し、条件を維持して再試行できる", async () => {
    const wrapper = listModal();
    await flushPromises();
    await button(wrapper, "削除").trigger("click");
    vi.mocked(apiClient.delete).mockRejectedValueOnce({
      response: { data: { error: "削除できませんでした" } },
    });
    await button(confirm(wrapper), "削除").trigger("click");
    await flushPromises();
    expect(confirm(wrapper).props("isOpen")).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("削除できませんでした");
    expect(wrapper.get("tbody tr").text()).toContain("50年以上");
    await button(wrapper, "削除").trigger("click");
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([]));
    await button(confirm(wrapper), "削除").trigger("click");
    await flushPromises();
    expect(apiClient.delete).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("保存した検索条件はありません。");
  });
  it("ページを切り替え、最終ページの最後の条件を削除したら前ページに戻る", async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([preset()], 21));
    const wrapper = listModal();
    await flushPromises();
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([{ ...preset(), id: "last" }], 21, 2));
    await button(wrapper, "次へ").trigger("click");
    await flushPromises();
    expect(apiClient.get).toHaveBeenLastCalledWith(
      endpoint,
      expect.objectContaining({ params: { page: 2, page_size: 20 } }),
    );
    await button(wrapper, "削除").trigger("click");
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([preset()], 20));
    await button(confirm(wrapper), "削除").trigger("click");
    await flushPromises();
    expect(apiClient.delete).toHaveBeenCalledWith(`${endpoint}/last`, expect.anything());
    expect(apiClient.get).toHaveBeenLastCalledWith(
      endpoint,
      expect.objectContaining({ params: { page: 1, page_size: 20 } }),
    );
  });
  it("読込中も閉じられ、再表示後に古い取得結果が上書きされない", async () => {
    let resolve!: (result: unknown) => void;
    vi.mocked(apiClient.get).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const wrapper = listModal();
    await button(wrapper, "閉じる").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    const signal = vi.mocked(apiClient.get).mock.calls[0][1]!.signal!;
    await wrapper.setProps({ isOpen: false });
    expect(signal.aborted).toBe(true);
    vi.mocked(apiClient.get).mockResolvedValueOnce(page([]));
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    resolve(page([{ ...preset(), name: "古い結果" }]));
    await flushPromises();
    expect(wrapper.text()).not.toContain("古い結果");
    expect(wrapper.text()).toContain("保存した検索条件はありません。");
  });
  it("呼出し中は操作を無効にし、復元失敗を一覧内に表示する", async () => {
    const wrapper = listModal();
    await flushPromises();
    await wrapper.setProps({ restoring: true });
    await button(wrapper, "呼び出し").trigger("click");
    await button(wrapper, "削除").trigger("click");
    await button(wrapper, "閉じる").trigger("click");
    expect(wrapper.emitted("restore")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(confirm(wrapper).props("isOpen")).toBe(false);
    await wrapper.setProps({ restoring: false, restoreError: "保存した項目が見つかりません" });
    expect(wrapper.get('[role="alert"]').text()).toContain("保存した項目が見つかりません");
  });
});
