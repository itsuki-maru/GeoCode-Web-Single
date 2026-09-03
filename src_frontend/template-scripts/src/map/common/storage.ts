import type { TileServerRecord } from "../types";

const STORAGE_KEYS = {
  mapMobileUiHidden: "geocode-web:map-mobile-ui-hidden",
  markerVisibility: "geocode-web:marker-visible",
  selectedTileServer: "geocode-web:selected-tile-server-id",
  shapeLayerVisibility: "geocode-web:shape-layer-visible",
  shapeNameVisibility: "geocode-web:shape-name-visible",
  userLocationVisibility: "geocode-web:user-location-visible",
} as const;

type TileServers = Record<string, TileServerRecord>;

interface StorageDependencies {
  getStorage?: () => Storage;
  warn?: (message: string, error: unknown) => void;
}

export function createMapStorage(
  tileServers: TileServers,
  {
    getStorage = () => window.localStorage,
    warn = (message, error) => console.warn(message, error),
  }: StorageDependencies = {},
) {
  let isTileServerSelectionPersistenceEnabled = false;

  const readBoolean = (
    key: string,
    fallback: boolean,
    warningMessage: string,
  ): boolean => {
    try {
      const savedValue = getStorage().getItem(key);
      if (savedValue === "true") return true;
      if (savedValue === "false") return false;
    } catch (error) {
      warn(warningMessage, error);
    }
    return fallback;
  };

  const writeBoolean = (
    key: string,
    value: boolean,
    warningMessage: string,
  ): void => {
    try {
      getStorage().setItem(key, value ? "true" : "false");
    } catch (error) {
      warn(warningMessage, error);
    }
  };

  const enableTileServerSelectionPersistence = (): void => {
    isTileServerSelectionPersistenceEnabled = true;
  };

  const getDefaultTileServerId = (): string | undefined => {
    if (tileServers["1"]) return "1";
    return Object.keys(tileServers)[0];
  };

  const getInitialTileServerId = (): string | undefined => {
    const defaultTileServerId = getDefaultTileServerId();
    if (!isTileServerSelectionPersistenceEnabled) return defaultTileServerId;

    try {
      const savedTileServerId = getStorage().getItem(
        STORAGE_KEYS.selectedTileServer,
      );
      if (savedTileServerId && tileServers[savedTileServerId]) {
        return savedTileServerId;
      }
    } catch (error) {
      warn("Failed to restore selected tile server:", error);
    }
    return defaultTileServerId;
  };

  const saveSelectedTileServerId = (tileServerId: string): void => {
    if (
      !isTileServerSelectionPersistenceEnabled ||
      !tileServers[tileServerId]
    ) {
      return;
    }
    try {
      getStorage().setItem(STORAGE_KEYS.selectedTileServer, tileServerId);
    } catch (error) {
      warn("Failed to save selected tile server:", error);
    }
  };

  return {
    enableTileServerSelectionPersistence,
    getDefaultTileServerId,
    getInitialMapMobileUiHidden: () =>
      readBoolean(
        STORAGE_KEYS.mapMobileUiHidden,
        false,
        "Failed to restore mobile map UI visibility:",
      ),
    getInitialMarkerVisibility: () =>
      readBoolean(
        STORAGE_KEYS.markerVisibility,
        true,
        "Failed to restore marker visibility:",
      ),
    getInitialShapeLayerVisibility: () =>
      readBoolean(
        STORAGE_KEYS.shapeLayerVisibility,
        true,
        "Failed to restore shape layer visibility:",
      ),
    getInitialShapeNameVisibility: () =>
      readBoolean(
        STORAGE_KEYS.shapeNameVisibility,
        true,
        "Failed to restore shape name visibility:",
      ),
    getInitialTileServerId,
    getInitialUserLocationVisibility: () =>
      readBoolean(
        STORAGE_KEYS.userLocationVisibility,
        true,
        "Failed to restore user location visibility:",
      ),
    saveMapMobileUiHidden: (isHidden: boolean) =>
      writeBoolean(
        STORAGE_KEYS.mapMobileUiHidden,
        isHidden,
        "Failed to save mobile map UI visibility:",
      ),
    saveMarkerVisibility: (isVisible: boolean) =>
      writeBoolean(
        STORAGE_KEYS.markerVisibility,
        isVisible,
        "Failed to save marker visibility:",
      ),
    saveSelectedTileServerId,
    saveShapeLayerVisibility: (isVisible: boolean) =>
      writeBoolean(
        STORAGE_KEYS.shapeLayerVisibility,
        isVisible,
        "Failed to save shape layer visibility:",
      ),
    saveShapeNameVisibility: (isVisible: boolean) =>
      writeBoolean(
        STORAGE_KEYS.shapeNameVisibility,
        isVisible,
        "Failed to save shape name visibility:",
      ),
    saveUserLocationVisibility: (isVisible: boolean) =>
      writeBoolean(
        STORAGE_KEYS.userLocationVisibility,
        isVisible,
        "Failed to save user location visibility:",
      ),
  };
}

interface TileMap<TLayer, TBounds> {
  removeLayer(layer: TLayer): void;
  setMaxBounds(bounds: TBounds | null): void;
}

interface TileChangeDependencies<TLayer, TBounds> {
  createTileLayer(tileServer: TileServerRecord): TLayer;
  getBounds(): TBounds;
  getMap(): TileMap<TLayer, TBounds>;
  getTileLayer(): TLayer;
  saveSelectedTileServerId(tileServerId: string): void;
  setTileLayer(tileLayer: TLayer): void;
  tileServers: TileServers;
}

export function createTileChangeHandler<TLayer, TBounds>({
  createTileLayer,
  getBounds,
  getMap,
  getTileLayer,
  saveSelectedTileServerId,
  setTileLayer,
  tileServers,
}: TileChangeDependencies<TLayer, TBounds>) {
  return (event: Event): void => {
    const selectedTileServerId = (
      event.target as HTMLInputElement | null
    )?.value;
    if (!selectedTileServerId) return;

    const selectedTile = tileServers[selectedTileServerId];
    if (!selectedTile) return;

    const map = getMap();
    map.removeLayer(getTileLayer());
    map.setMaxBounds(
      selectedTile.include_foreign_tiles ? null : getBounds(),
    );

    const tileLayer = createTileLayer(selectedTile);
    setTileLayer(tileLayer);
    saveSelectedTileServerId(selectedTileServerId);
  };
}
