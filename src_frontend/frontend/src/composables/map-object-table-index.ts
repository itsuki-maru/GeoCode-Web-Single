import type { MapObjectData, ShapeData } from "@/interface";
import { getShapeCenter, type ShapeCenter } from "./useShapeCenter";
import type { TableObjectType } from "@/stores/map-table-changes";

export interface TableSummary {
  key: string;
  type: TableObjectType;
  id: string;
  layerId: string;
  name: string;
  unnamed: boolean;
  timestamp: number;
  typeLabel: string;
  typeSymbol: string;
  badgeClass: string;
}
export interface TableRow extends TableSummary {
  index: number;
  latitude: number | null;
  longitude: number | null;
}
const badges = {
  circle: { typeLabel: "円", typeSymbol: "○", badgeClass: "type-circle" },
  polyline: { typeLabel: "線", typeSymbol: "━", badgeClass: "type-polyline" },
  polygon: { typeLabel: "面", typeSymbol: "◆", badgeClass: "type-polygon" },
  rectangle: { typeLabel: "矩形", typeSymbol: "□", badgeClass: "type-rectangle" },
};
export function compareTableSummaries(a: TableSummary, b: TableSummary): number {
  if (a.unnamed !== b.unnamed) return a.unnamed ? -1 : 1;
  return b.timestamp - a.timestamp || a.key.localeCompare(b.key);
}

// 通常のメタデータのみを扱い、GeoJSON は既存の正規ストアに保持する。
export class MapObjectTableIndex {
  readonly rows = new Map<string, TableSummary>();
  readonly keys: string[] = [];
  private centers = new Map<string, ShapeCenter | null>();

  clear(): void {
    this.rows.clear();
    this.keys.length = 0;
    this.centers.clear();
  }
  private summary(kind: TableObjectType, record: MapObjectData | ShapeData): TableSummary {
    const marker = record as MapObjectData,
      shape = record as ShapeData;
    const name = (kind === "marker" ? marker.marker_name : shape.name) || "";
    return {
      key: `${kind}:${record.id}`,
      type: kind,
      id: record.id,
      layerId: record.layer_id,
      name,
      unnamed: name.trim().length === 0,
      timestamp:
        Date.parse((kind === "marker" ? marker.update_at : shape.updated_at).replace(" ", "T")) ||
        0,
      ...(kind === "marker"
        ? { typeLabel: "マーカー", typeSymbol: "●", badgeClass: "type-marker" }
        : badges[shape.shape_type]),
    };
  }
  reset(markers: Iterable<MapObjectData>, shapes: Iterable<ShapeData>): void {
    this.clear();
    for (const [kind, records] of [
      ["marker", markers],
      ["shape", shapes],
    ] as const)
      for (const record of records) {
        const row = this.summary(kind, record);
        this.rows.set(row.key, row);
        this.keys.push(row.key);
      }
    this.keys.sort((a, b) => compareTableSummaries(this.rows.get(a)!, this.rows.get(b)!));
  }
  private position(row: TableSummary): number {
    let low = 0,
      high = this.keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareTableSummaries(this.rows.get(this.keys[mid]!)!, row) < 0) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  remove(kind: TableObjectType, id: string): void {
    const key = `${kind}:${id}`,
      old = this.rows.get(key);
    if (!old) return;
    this.keys.splice(this.position(old), 1);
    this.rows.delete(key);
    this.centers.delete(key);
  }
  upsert(kind: TableObjectType, record: MapObjectData | ShapeData): void {
    this.remove(kind, record.id);
    const row = this.summary(kind, record);
    this.keys.splice(this.position(row), 0, row.key);
    this.rows.set(row.key, row);
  }
  slice(
    start: number,
    end: number,
    marker: (id: string) => MapObjectData | undefined,
    shape: (id: string) => ShapeData | undefined,
  ): TableRow[] {
    return this.keys.slice(start, end).map((key, offset) => {
      const row = this.rows.get(key)!;
      let center: ShapeCenter | null = null;
      if (row.type === "marker") {
        const record = marker(row.id);
        if (record) center = { latitude: record.latitude, longitude: record.longitude };
      } else {
        if (!this.centers.has(key)) {
          const record = shape(row.id);
          this.centers.set(key, record ? getShapeCenter(record) : null);
        }
        center = this.centers.get(key) ?? null;
      }
      return {
        ...row,
        index: start + offset,
        latitude: center?.latitude ?? null,
        longitude: center?.longitude ?? null,
      };
    });
  }
}
