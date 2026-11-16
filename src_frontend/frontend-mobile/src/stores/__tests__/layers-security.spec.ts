import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
vi.mock("@/axiosClient", () => ({ default: { get: vi.fn() } }));
import apiClient from "@/axiosClient";
import { useLayersStore } from "../layers";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
const layer = (id: string, owner: string) => ({
  id,
  user_id: owner,
  layer_name: owner + " private",
  is_master: false,
  marker_icon_id: null,
  marker_icon_filename: null,
});
const seed = () => {
  const store = useLayersStore();
  store.layersList.set("keep", {
    id: "keep",
    user_id: "current",
    name: "current",
    is_master: false,
  } as any);
  return store;
};

it("does not replace the current account list when an earlier AI synchronization finishes after scope changes", async () => {
  const store = seed();
  let current = true,
    finish!: (value: unknown) => void;
  vi.mocked(apiClient.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.initList({ accountId: "old", isCurrent: () => current });
  current = false;
  finish({ data: { old: layer("old", "old") } });
  expect(await pending).toBe(false);
  expect([...store.layersList.keys()]).toEqual(["keep"]);
});

it("does not apply a response after its AbortSignal is cancelled", async () => {
  const store = seed(),
    controller = new AbortController();
  let finish!: (value: unknown) => void;
  vi.mocked(apiClient.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.initList({ accountId: "owner", signal: controller.signal });
  controller.abort();
  finish({ data: { private: layer("private", "owner") } });
  expect(await pending).toBe(false);
  expect([...store.layersList.keys()]).toEqual(["keep"]);
});

it("keeps the captured actor header and rejects another cookie account's data or an empty list", async () => {
  const store = seed();
  vi.mocked(apiClient.get)
    .mockResolvedValueOnce({ data: { other: layer("other", "other") } })
    .mockResolvedValueOnce({ data: {} })
    .mockResolvedValueOnce({ data: { mine: layer("mine", "owner") } });
  expect(await store.initList({ accountId: "owner", isCurrent: () => true })).toBe(false);
  expect(apiClient.get).toHaveBeenLastCalledWith(expect.any(String), {
    headers: { "X-AI-Account-ID": "owner" },
  });
  expect([...store.layersList.keys()]).toEqual(["keep"]);
  expect(await store.initList({ accountId: "owner" })).toBe(false);
  expect([...store.layersList.keys()]).toEqual(["keep"]);
  expect(await store.initList({ accountId: "owner" })).toBe(true);
  expect([...store.layersList.keys()]).toEqual(["mine"]);
});
