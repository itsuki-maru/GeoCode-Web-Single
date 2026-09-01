import { ref } from "vue";

export const MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY = "geocode-web:map-object-table-open";

const getInitialVisibility = (): boolean => {
  try {
    const storedValue = localStorage.getItem(MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY);
    if (storedValue === "true") return true;
    if (storedValue === "false") return false;
  } catch (error) {
    console.warn("地図オブジェクトテーブルの表示状態を読み込めませんでした。", error);
  }
  return true;
};

export const useMapObjectTableVisibility = () => {
  const isMapObjectTableOpen = ref(getInitialVisibility());

  const toggleMapObjectTable = (): void => {
    isMapObjectTableOpen.value = !isMapObjectTableOpen.value;
    try {
      localStorage.setItem(
        MAP_OBJECT_TABLE_VISIBILITY_STORAGE_KEY,
        String(isMapObjectTableOpen.value),
      );
    } catch (error) {
      console.warn("地図オブジェクトテーブルの表示状態を保存できませんでした。", error);
    }
  };

  return { isMapObjectTableOpen, toggleMapObjectTable };
};
