export const LAST_ACTIVE_LAYER_STORAGE_KEY = "geocode-web:last-active-layer-id";

export const getLastActiveLayerId = (): string | null => {
  try {
    const layerId = localStorage.getItem(LAST_ACTIVE_LAYER_STORAGE_KEY)?.trim();
    return layerId || null;
  } catch (error) {
    console.warn("最後に開いたレイヤを読み込めませんでした。", error);
    return null;
  }
};

export const saveLastActiveLayerId = (layerId: string): void => {
  try {
    localStorage.setItem(LAST_ACTIVE_LAYER_STORAGE_KEY, layerId);
  } catch (error) {
    console.warn("最後に開いたレイヤを保存できませんでした。", error);
  }
};

export const resolveInitialLayerId = (
  storedLayerId: string | null,
  masterLayerId: string,
  availableLayerIds: ReadonlySet<string>,
): string => {
  if (storedLayerId && availableLayerIds.has(storedLayerId)) return storedLayerId;
  return masterLayerId;
};
