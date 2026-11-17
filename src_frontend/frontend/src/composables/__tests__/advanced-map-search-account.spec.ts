import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  isAxiosError: vi.fn(),
}));
const modal = vi.hoisted(() => ({
  options: null as any,
  open: vi.fn(),
  close: vi.fn(),
  recall: vi.fn(),
}));
vi.mock("@/axiosClient", () => ({ default: api }));
vi.mock("../../../../template-scripts/src/map/common/advanced-map-search", async (original) => ({
  ...(await original<object>()),
  createAdvancedMapSearchModal: (options: any) => {
    modal.options = options;
    return { open: modal.open, close: modal.close, recallPreset: modal.recall, dispose: vi.fn() };
  },
}));
import { useAdvancedMapSearch } from "../useAdvancedMapSearch";
import { useAuthStore } from "@/stores/auth";

let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.isAxiosError.mockReturnValue(false);
});
afterEach(() => wrapper?.unmount());

function setup() {
  const notify = vi.fn();
  let search!: ReturnType<typeof useAdvancedMapSearch>;
  useAuthStore().accountId = "account-a";
  wrapper = mount(
    defineComponent({
      setup() {
        search = useAdvancedMapSearch(ref("layer-a"), ref("master"), vi.fn(), notify);
        return () => null;
      },
    }),
  );
  return { search, notify };
}

it("保存条件の各HTTP操作に元のactorを送り、不一致後は取得と書込みを再開しない", async () => {
  const { search, notify } = setup();
  const signal = new AbortController().signal;
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: null });
  await modal.options.transport("/form-answers/map-presets?versions=1,2", undefined, signal);
  await modal.options.transport("/form-answers/map-presets", { name: "編集済み" }, signal);
  await modal.options.transport("/form-answers/map-presets/saved-a", undefined, signal, "DELETE");
  for (const request of [api.get, api.post, api.delete]) {
    expect(request.mock.calls.at(-1)!.at(-1)).toMatchObject({
      signal,
      headers: { "X-AI-Account-ID": "account-a" },
    });
  }
  api.isAxiosError.mockReturnValue(true);
  api.post.mockRejectedValueOnce({
    response: { status: 409, data: { error: "ai_account_changed" } },
  });
  await expect(
    modal.options.transport("/form-answers/map-presets", { name: "再保存" }, signal),
  ).rejects.toThrow("ai_account_changed");
  expect(useAuthStore().accountId).toBe("account-a");
  expect(modal.close).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("再読み込み"));
  const reads = api.get.mock.calls.length,
    writes = api.post.mock.calls.length;
  useAuthStore().accountId = "account-b";
  await expect(modal.options.transport("/common-forms", undefined, signal)).rejects.toThrow(
    "再読み込み",
  );
  await expect(search.recallSavedPreset({} as any)).rejects.toThrow("再読み込み");
  search.openAdvancedSearch();
  expect(modal.open).not.toHaveBeenCalled();
  expect(api.get.mock.calls.length).toBe(reads);
  expect(api.post.mock.calls.length).toBe(writes);
});

it("通常の409競合はアカウント不一致と混同せず、既存の取得を継続できる", async () => {
  setup();
  const signal = new AbortController().signal;
  api.isAxiosError.mockReturnValue(true);
  api.get.mockRejectedValueOnce({ response: { status: 409, data: { error: "form changed" } } });
  await expect(modal.options.transport("/common-forms", undefined, signal)).rejects.toThrow(
    "共通フォームが変更されました",
  );
  api.get.mockResolvedValueOnce({ data: [] });
  await expect(modal.options.transport("/common-forms", undefined, signal)).resolves.toEqual([]);
  expect(modal.close).not.toHaveBeenCalled();
  expect(api.get.mock.calls.at(-1)![1]).toEqual({ signal });
});
