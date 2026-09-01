import { beforeEach, describe, expect, it } from "vitest";
import {
  MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY,
  useMapObjectTableVisibility,
} from "@/composables/useMapObjectTableVisibility";

describe("地図オブジェクトテーブルの表示状態", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("保存値がなければテーブルを表示する", () => {
    const { isMapObjectTableOpen } = useMapObjectTableVisibility();

    expect(isMapObjectTableOpen.value).toBe(true);
  });

  it("保存された非表示状態を復元する", () => {
    localStorage.setItem(MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY, "false");

    const { isMapObjectTableOpen } = useMapObjectTableVisibility();

    expect(isMapObjectTableOpen.value).toBe(false);
  });

  it("開閉時に表示状態を保存する", () => {
    const { isMapObjectTableOpen, toggleMapObjectTable } = useMapObjectTableVisibility();

    toggleMapObjectTable();

    expect(isMapObjectTableOpen.value).toBe(false);
    expect(localStorage.getItem(MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY)).toBe("false");

    toggleMapObjectTable();

    expect(isMapObjectTableOpen.value).toBe(true);
    expect(localStorage.getItem(MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY)).toBe("true");
  });

  it("不正な保存値は表示状態として扱う", () => {
    localStorage.setItem(MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY, "invalid");

    const { isMapObjectTableOpen } = useMapObjectTableVisibility();

    expect(isMapObjectTableOpen.value).toBe(true);
  });
});
