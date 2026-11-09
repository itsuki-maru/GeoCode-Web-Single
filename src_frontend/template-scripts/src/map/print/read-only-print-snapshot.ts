import { isAnswerColoring } from "../answer-coloring";
import type { PrintMapState } from "../common/print-state";
import {
  isStoredShareMapSnapshot,
  MAX_SHARE_BYTES,
  MAX_SHARE_OBJECTS,
  type ShareMapSnapshot,
} from "../common/share-snapshot";
import { getShapeGeometryInfo } from "../common/shape-renderer";
import type { LayerRecord, ShapeRecord } from "../types";

export type ReadOnlyPrintSourcePage = "map-anather" | "temporary-map";

export interface ReadOnlyPrintSnapshot extends ShareMapSnapshot {
  sourcePage: ReadOnlyPrintSourcePage;
  snapshotShare?: boolean;
  shapes: ShapeRecord[];
}

type LegacyLayerRecord = Omit<LayerRecord, "marker_icon_id" | "marker_icon_filename"> &
  Partial<Pick<LayerRecord, "marker_icon_id" | "marker_icon_filename">>;

export interface ReadOnlyPrintSource extends Pick<
  ReadOnlyPrintSnapshot,
  "sourcePage" | "snapshotShare" | "markers" | "shapes" | "tileServers" | "tileOverlays"
> {
  layers: Record<string, LegacyLayerRecord>;
}

const snapshotFields = [
  "version",
  "sourcePage",
  "snapshotShare",
  "state",
  "layers",
  "markers",
  "shapes",
  "tileServers",
  "tileOverlays",
] as const;
const stateFields = [
  "coloring",
  "objectQuery",
  "view",
  "tileServerId",
  "overlays",
  "clusteringEnabled",
  "clusteringAllowed",
  "clusteringMinZoom",
  "markersVisible",
  "shapesVisible",
  "shapeNamesVisible",
  "layerIds",
  "markerIds",
  "shapeIds",
] as const;
const viewFields = ["latitude", "longitude", "zoom"] as const;
const layerFields = [
  "id",
  "layer_name",
  "user_id",
  "is_master",
  "marker_icon_id",
  "marker_icon_filename",
] as const;
const markerFields = ["id", "layer_id", "marker_name", "detail", "latitude", "longitude"] as const;
const shapeFields = ["id", "layer_id", "shape_type", "name", "user_id", "geojson"] as const;
const tileFields = [
  "id",
  "layer_name",
  "label",
  "url",
  "attribution",
  "include_foreign_tiles",
  "min_zoom",
  "max_zoom",
] as const;
const overlayFields = [
  "id",
  "name",
  "url",
  "attribution",
  "min_zoom",
  "max_zoom",
  "opacity",
  "sort_order",
] as const;
const ruleFields = ["id", "label", "color"] as const;
const geometryFields = ["type", "coordinates"] as const;
const propertiesFields = ["memo", "radius", "style"] as const;
const styleFields = [
  "color",
  "weight",
  "dashArray",
  "arrowType",
  "fillColor",
  "fillOpacity",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const owns = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const allowedFields = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> =>
  record(value) && Object.keys(value).every((key) => fields.includes(key));
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\w-]{1,128}$/.test(value) &&
  value !== "__proto__" &&
  value !== "constructor" &&
  value !== "prototype";
const optionalText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function pick<T, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> {
  return Object.fromEntries(fields.map((key) => [key, value[key]])) as Pick<T, K>;
}

function sameIds(ids: string[] | null | undefined, expected: string[]): boolean {
  if (!Array.isArray(ids) || ids.length !== expected.length) return false;
  const wanted = new Set(expected);
  const actual = new Set(ids);
  return (
    wanted.size === ids.length &&
    actual.size === ids.length &&
    expected.every((id) => actual.has(id))
  );
}

function isTileUrl(value: string): boolean {
  try {
    if (!/^(?:https?:\/\/|\/(?![\\/]))/i.test(value) || /[\r\n\t]/.test(value)) return false;
    const url = new URL(value, "https://map.invalid");
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasShapeFields(geojson: unknown): geojson is Record<string, unknown> {
  if (!record(geojson)) return false;
  const { properties } = geojson;
  return (
    (geojson.type === "Feature"
      ? allowedFields(geojson, ["type", "geometry", "properties"]) &&
        allowedFields(geojson.geometry, geometryFields)
      : allowedFields(geojson, ["type", "coordinates", "properties"])) &&
    (properties === undefined ||
      properties === null ||
      (allowedFields(properties, propertiesFields) &&
        (properties.style === undefined ||
          properties.style === null ||
          allowedFields(properties.style, styleFields))))
  );
}

/** 図形の表示に使う座標、メモ、スタイルに絞って受け渡す。 */
function pickShapeGeoJson(geojson: Record<string, unknown>): Record<string, unknown> {
  const geometry =
    geojson.type === "Feature" && record(geojson.geometry)
      ? { type: geojson.type, geometry: pick(geojson.geometry, geometryFields) }
      : pick(geojson, geometryFields);
  const properties = record(geojson.properties)
    ? pick(geojson.properties, propertiesFields)
    : undefined;
  if (properties && record(properties.style))
    properties.style = pick(properties.style, styleFields);
  return { ...geometry, properties };
}

function hasValidFields(value: unknown): value is ReadOnlyPrintSnapshot {
  if (
    !allowedFields(value, snapshotFields) ||
    (value.sourcePage !== "map-anather" && value.sourcePage !== "temporary-map") ||
    (value.snapshotShare !== undefined && typeof value.snapshotShare !== "boolean") ||
    (value.snapshotShare === true && value.sourcePage !== "temporary-map") ||
    !isStoredShareMapSnapshot(value) ||
    !allowedFields(value.state, stateFields) ||
    !allowedFields(value.state.view, viewFields) ||
    !record(value.layers) ||
    !record(value.markers) ||
    !Array.isArray(value.shapes)
  )
    return false;

  const { state, layers, markers, shapes, tileServers, tileOverlays } = value;
  const markerIds = Object.keys(markers);
  const layerIds = Object.keys(layers);
  if (
    markerIds.length + shapes.length > MAX_SHARE_OBJECTS ||
    (!state.markersVisible && markerIds.length > 0) ||
    (!state.shapesVisible && shapes.length > 0) ||
    !sameIds(state.layerIds, layerIds) ||
    !sameIds(state.markerIds, markerIds) ||
    !layerIds.every((id) => {
      const layer = layers[id];
      return (
        identifier(id) &&
        allowedFields(layer, layerFields) &&
        layer.id === id &&
        typeof layer.layer_name === "string" &&
        typeof layer.user_id === "string" &&
        typeof layer.is_master === "boolean" &&
        optionalText(layer.marker_icon_id) &&
        optionalText(layer.marker_icon_filename)
      );
    }) ||
    !Object.entries(markers).every(
      ([id, marker]) =>
        identifier(id) &&
        allowedFields(marker, markerFields) &&
        marker.id === id &&
        typeof marker.layer_id === "string" &&
        owns(layers, marker.layer_id) &&
        typeof marker.marker_name === "string" &&
        typeof marker.detail === "string" &&
        typeof marker.latitude === "number" &&
        Math.abs(marker.latitude) <= 90 &&
        typeof marker.longitude === "number" &&
        Math.abs(marker.longitude) <= 180,
    ) ||
    !Object.entries(tileServers).every(
      ([id, tile]) =>
        allowedFields(tile, tileFields) &&
        Number.isSafeInteger(tile.id) &&
        String(tile.id) === id &&
        isTileUrl(tile.url) &&
        (tile.min_zoom === null || Number.isInteger(tile.min_zoom)) &&
        (tile.max_zoom === null || Number.isInteger(tile.max_zoom)),
    ) ||
    !tileOverlays.every((tile) => allowedFields(tile, overlayFields) && isTileUrl(tile.url))
  )
    return false;

  const shapeIds: string[] = [];
  for (const shape of shapes) {
    if (
      !allowedFields(shape, shapeFields) ||
      !identifier(shape.id) ||
      typeof shape.layer_id !== "string" ||
      !owns(layers, shape.layer_id) ||
      typeof shape.user_id !== "string" ||
      !optionalText(shape.name) ||
      !hasShapeFields(shape.geojson) ||
      !getShapeGeometryInfo(shape)
    )
      return false;
    shapeIds.push(shape.id);
  }
  if (!sameIds(state.shapeIds, shapeIds)) return false;

  const coloring = state.coloring;
  return (
    !coloring ||
    (allowedFields(coloring, ["version", "rules", "targets"]) &&
      coloring.rules.every((rule) => allowedFields(rule, ruleFields)) &&
      isAnswerColoring(
        coloring,
        new Set([...markerIds.map((id) => `marker:${id}`), ...shapeIds.map((id) => `shape:${id}`)]),
      ))
  );
}

function encodeSnapshot(value: unknown): string | null {
  try {
    if (!hasValidFields(value)) return null;
    const json = JSON.stringify(value);
    return json.length <= MAX_SHARE_BYTES &&
      new TextEncoder().encode(json).length <= MAX_SHARE_BYTES
      ? json
      : null;
  } catch {
    return null;
  }
}

export function isReadOnlyPrintSnapshot(value: unknown): value is ReadOnlyPrintSnapshot {
  return encodeSnapshot(value) !== null;
}

/** 共有や所有者向けの追加取得情報を含めず、押下時の論理表示対象を固定する。 */
export function createReadOnlyPrintSnapshot(
  source: ReadOnlyPrintSource,
  state: PrintMapState,
  visibleTargetKeys: ReadonlySet<string>,
): ReadOnlyPrintSnapshot {
  const selected = new Set(state.layerIds ?? Object.keys(source.layers));
  const layers = Object.fromEntries(
    Object.entries(source.layers)
      .filter(([id]) => selected.has(id))
      .map(([id, layer]) => [
        id,
        {
          ...pick(layer, layerFields),
          marker_icon_id: layer.marker_icon_id ?? null,
          marker_icon_filename: layer.marker_icon_filename ?? null,
        },
      ]),
  );
  const markers = Object.fromEntries(
    Object.values(source.markers)
      .filter(
        (marker) =>
          marker.layer_id !== null &&
          owns(layers, marker.layer_id) &&
          visibleTargetKeys.has(`marker:${marker.id}`),
      )
      .map((marker) => [marker.id, pick(marker, markerFields)]),
  );
  const shapes = source.shapes
    .filter((shape) => owns(layers, shape.layer_id) && visibleTargetKeys.has(`shape:${shape.id}`))
    .map((shape) => ({ ...pick(shape, shapeFields), geojson: pickShapeGeoJson(shape.geojson) }));
  const markerIds = Object.keys(markers);
  const shapeIds = shapes.map((shape) => shape.id);
  const targetKeys = new Set([
    ...markerIds.map((id) => `marker:${id}`),
    ...shapeIds.map((id) => `shape:${id}`),
  ]);
  const targets = Object.fromEntries(
    Object.entries(state.coloring?.targets ?? {}).filter(([key]) => targetKeys.has(key)),
  );
  const ruleIds = new Set(Object.values(targets));
  const coloring =
    state.coloring && ruleIds.size > 0
      ? {
          version: state.coloring.version,
          rules: state.coloring.rules
            .filter((rule) => ruleIds.has(rule.id))
            .map((rule) => pick(rule, ruleFields)),
          targets,
        }
      : undefined;
  const snapshot: ReadOnlyPrintSnapshot = {
    version: 1,
    sourcePage: source.sourcePage,
    snapshotShare: source.snapshotShare,
    layers,
    markers,
    shapes,
    tileServers: Object.fromEntries(
      Object.entries(source.tileServers).map(([id, tile]) => [id, pick(tile, tileFields)]),
    ),
    tileOverlays: source.tileOverlays.map((tile) => pick(tile, overlayFields)),
    state: {
      ...pick(state, stateFields),
      view: pick(state.view, viewFields),
      coloring,
      layerIds: Object.keys(layers),
      markerIds,
      shapeIds,
    },
  };
  const json = encodeSnapshot(snapshot);
  if (json === null)
    throw new Error(
      "印刷対象が不正、10,000件超、または32MiB超です。地図を開き直すか、条件を絞ってください。",
    );
  return JSON.parse(json);
}
