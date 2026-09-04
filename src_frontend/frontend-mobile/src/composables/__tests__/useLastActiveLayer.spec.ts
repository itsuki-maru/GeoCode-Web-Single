import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLastActiveLayerId,
  LAST_ACTIVE_LAYER_STORAGE_KEY,
  resolveInitialLayerId,
  saveLastActiveLayerId,
} from "@/composables/useLastActiveLayer";

describe("最後に開いたレイヤ", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("レイヤIDを保存して読み込む", () => {
    saveLastActiveLayerId("layer-1");

    expect(localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)).toBe("layer-1");
    expect(getLastActiveLayerId()).toBe("layer-1");
  });

  it("保存値が空の場合は未保存として扱う", () => {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, "   ");

    expect(getLastActiveLayerId()).toBeNull();
  });

  it("保存レイヤが存在する場合はそのレイヤを選ぶ", () => {
    expect(resolveInitialLayerId("layer-1", "master", new Set(["master", "layer-1"]))).toBe(
      "layer-1",
    );
  });

  it("保存レイヤが存在しない場合はmasterを選ぶ", () => {
    expect(resolveInitialLayerId("deleted", "master", new Set(["master"]))).toBe("master");
    expect(resolveInitialLayerId(null, "master", new Set(["master"]))).toBe("master");
  });

  it("ストレージの読み書きに失敗しても例外にしない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(getLastActiveLayerId()).toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => saveLastActiveLayerId("layer-1")).not.toThrow();
  });
});
