import { isAnswerColoring } from "../answer-coloring";
import { isPrintMapState, type PrintMapState } from "./print-state";

// Vue と地図iframeの境界で使う型は、地図の描画モジュールへ依存させない。
interface LayerRecord {
  id: string;
  layer_name: string;
  user_id: string;
  is_master: boolean;
  marker_icon_id: string | null;
  marker_icon_filename: string | null;
}
interface MarkerRecord {
  id: string;
  layer_id: string | null;
  marker_name: string;
  detail: string;
  latitude: number;
  longitude: number;
}
interface ShapeRecord {
  id: string;
  layer_id: string;
  geojson: Record<string, unknown>;
  shape_type: string;
  name: string | null;
}
interface TileServerRecord {
  id: number;
  url: string;
  attribution: string;
  label: string;
  layer_name: string;
  include_foreign_tiles: boolean;
  min_zoom: number | null;
  max_zoom: number | null;
}
interface TileOverlayRecord {
  id: string;
  name: string;
  url: string;
  attribution: string;
  min_zoom: number;
  max_zoom: number;
  opacity: number;
  sort_order: number;
}

export interface StoredShareMapSnapshot {
  version: 1;
  state: PrintMapState;
  tileServers: Record<string, TileServerRecord>;
  tileOverlays: TileOverlayRecord[];
}

export interface ShareMapSnapshot extends StoredShareMapSnapshot {
  layers: Record<string, LayerRecord>;
  markers: Record<string, MarkerRecord>;
  shapes: ShapeRecord[];
}

export const MAX_SHARE_OBJECTS = 10_000;
export const MAX_SHARE_BYTES = 32 * 1024 * 1024;

/** 同一origin、またはサーバーが明示した開発用originにだけ機密データを送る。 */
export function resolveShareParentOrigin(
  referrer: string,
  ownOrigin: string,
  trustedOrigins: readonly string[] = [],
): string | null {
  try {
    const origin = referrer ? new URL(referrer).origin : ownOrigin;
    return origin === ownOrigin || trustedOrigins.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const owns = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const identifier = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 128 &&
  !["__proto__", "prototype", "constructor"].includes(v);

export function isStoredShareMapSnapshot(v: unknown): v is StoredShareMapSnapshot {
  if (
    !record(v) ||
    v.version !== 1 ||
    !isPrintMapState(v.state) ||
    !record(v.tileServers) ||
    !Array.isArray(v.tileOverlays)
  )
    return false;
  if (!owns(v.tileServers, "1") || !owns(v.tileServers, v.state.tileServerId)) return false;
  if (
    !Object.entries(v.tileServers).every(
      ([id, t]) =>
        identifier(id) &&
        record(t) &&
        typeof t.url === "string" &&
        typeof t.attribution === "string" &&
        typeof t.label === "string" &&
        typeof t.layer_name === "string" &&
        typeof t.include_foreign_tiles === "boolean",
    )
  )
    return false;
  const overlayIds = new Set<string>();
  for (const tile of v.tileOverlays) {
    if (
      !record(tile) ||
      !identifier(tile.id) ||
      overlayIds.has(tile.id) ||
      typeof tile.url !== "string" ||
      typeof tile.name !== "string" ||
      typeof tile.attribution !== "string" ||
      !Number.isFinite(tile.opacity) ||
      tile.opacity < 0 ||
      tile.opacity > 1 ||
      !Number.isInteger(tile.min_zoom) ||
      !Number.isInteger(tile.max_zoom) ||
      !Number.isFinite(tile.sort_order)
    )
      return false;
    overlayIds.add(tile.id);
  }
  return (
    Object.keys(v.state.overlays).every((id) => overlayIds.has(id)) &&
    [...overlayIds].every((id) => typeof v.state.overlays[id] === "boolean")
  );
}

/** 公開用データの境界。実際の所有権とタイル定義はサーバーでも検証する。 */
export function isShareMapSnapshot(value: unknown): value is ShareMapSnapshot {
  if (!isStoredShareMapSnapshot(value)) return false;
  const v = value as StoredShareMapSnapshot & Record<string, any>;
  if (!record(v.layers) || !record(v.markers) || !Array.isArray(v.shapes)) return false;
  const layers = Object.keys(v.layers);
  if (
    !layers.every(
      (id) =>
        identifier(id) &&
        record(v.layers[id]) &&
        v.layers[id].id === id &&
        typeof v.layers[id].layer_name === "string",
    )
  )
    return false;
  if (
    !Array.isArray(v.state.layerIds) ||
    new Set(v.state.layerIds).size !== layers.length ||
    v.state.layerIds.length !== layers.length ||
    !v.state.layerIds.every((id) => owns(v.layers, id))
  )
    return false;
  const markers = Object.entries(v.markers);
  if (markers.length + v.shapes.length > MAX_SHARE_OBJECTS) return false;
  const keys = new Set<string>();
  for (const [id, marker] of markers) {
    if (
      !identifier(id) ||
      !record(marker) ||
      marker.id !== id ||
      !owns(v.layers, marker.layer_id) ||
      !Number.isFinite(marker.latitude) ||
      Math.abs(marker.latitude) > 90 ||
      !Number.isFinite(marker.longitude) ||
      Math.abs(marker.longitude) > 180 ||
      typeof marker.marker_name !== "string" ||
      typeof marker.detail !== "string"
    )
      return false;
    keys.add(`marker:${id}`);
  }
  for (const shape of v.shapes) {
    if (
      !record(shape) ||
      !identifier(shape.id) ||
      keys.has(`shape:${shape.id}`) ||
      !owns(v.layers, shape.layer_id) ||
      !record(shape.geojson) ||
      typeof shape.shape_type !== "string"
    )
      return false;
    keys.add(`shape:${shape.id}`);
  }
  if (v.state.coloring !== undefined && !isAnswerColoring(v.state.coloring, keys)) return false;
  for (const [kind, ids] of [
    ["marker", v.state.markerIds],
    ["shape", v.state.shapeIds],
  ] as const) {
    if (ids !== undefined && ids !== null && ids.some((id) => !keys.has(`${kind}:${id}`)))
      return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_SHARE_BYTES;
  } catch {
    return false;
  }
}

/** 対象は画面内のLeafletレイヤではなく、保持済みレコードの論理表示条件から渡す。 */
export function createShareMapSnapshot(
  data: Pick<ShareMapSnapshot, "layers" | "markers" | "shapes" | "tileServers" | "tileOverlays">,
  state: PrintMapState,
  targets: ReadonlySet<string>,
): ShareMapSnapshot {
  // 共有先は閲覧時にサーバーから管理者設定を受け取る。
  const { clusteringMinZoom: _clusteringMinZoom, ...shareState } = state;
  const selected = new Set(state.layerIds ?? Object.keys(data.layers));
  const layers = Object.fromEntries(Object.entries(data.layers).filter(([id]) => selected.has(id)));
  const markers = Object.fromEntries(
    Object.values(data.markers)
      .filter((m) => owns(layers, m.layer_id!) && targets.has(`marker:${m.id}`))
      .map((m) => [m.id, m]),
  );
  const shapes = data.shapes.filter(
    (s) => owns(layers, s.layer_id) && targets.has(`shape:${s.id}`),
  );
  const keys = new Set([
    ...Object.keys(markers).map((id) => `marker:${id}`),
    ...shapes.map((s) => `shape:${s.id}`),
  ]);
  const coloring = state.coloring
    ? {
        ...state.coloring,
        targets: Object.fromEntries(
          Object.entries(state.coloring.targets).filter(([key]) => keys.has(key)),
        ),
      }
    : undefined;
  const snapshot: ShareMapSnapshot = {
    version: 1,
    layers,
    markers,
    shapes,
    tileServers: data.tileServers,
    tileOverlays: data.tileOverlays,
    state: {
      ...shareState,
      coloring,
      layerIds: Object.keys(layers),
      markerIds: Object.keys(markers),
      shapeIds: shapes.map((s) => s.id),
    },
  };
  if (!isShareMapSnapshot(snapshot))
    throw Error(
      "共有対象が不正、10,000件超、または32MiB超です。地図を再読み込みするか条件を絞ってください。",
    );
  return JSON.parse(JSON.stringify(snapshot));
}
