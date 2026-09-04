<script setup lang="ts">
import { computed } from "vue";
import type { MapObjectData, ShapeData } from "@/interface";
import { useLayersStore } from "@/stores/layers";
import { getShapeCenter } from "@/composables/useShapeCenter";

const props = defineProps<{
  markerList: Map<string, MapObjectData>;
  shapeList: Map<string, ShapeData>;
  filteredShapeIds: string[] | null;
  height: number;
  activeLayer: string;
}>();

const emit = defineEmits<{
  editObject: [type: "marker" | "shape", id: string];
  focusObject: [type: "marker" | "shape", id: string, lat: number, lng: number];
}>();

const layersStore = useLayersStore();

const getLayerForId = (layer_id: string): string => {
  const layerObj = layersStore.getById(layer_id);
  if (layerObj) {
    return layerObj.name;
  } else {
    return "Layer Name Get Error";
  }
};

function fixFloat(number: number): string {
  return number.toFixed(5);
}

interface TableRow {
  type: "marker" | "shape";
  id: string;
  layerId: string;
  name: string;
  typeLabel: string;
  typeSymbol: string;
  badgeClass: string;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}

const shapeTypeBadges: Record<
  ShapeData["shape_type"],
  { label: string; symbol: string; badgeClass: string }
> = {
  circle: { label: "円", symbol: "○", badgeClass: "type-circle" },
  polyline: { label: "線", symbol: "━", badgeClass: "type-polyline" },
  polygon: { label: "面", symbol: "◆", badgeClass: "type-polygon" },
  rectangle: { label: "矩形", symbol: "□", badgeClass: "type-rectangle" },
};

const compareTableRows = (a: TableRow, b: TableRow): number => {
  const aHasNoName = a.name.trim().length === 0;
  const bHasNoName = b.name.trim().length === 0;
  if (aHasNoName !== bHasNoName) return aHasNoName ? -1 : 1;

  const aUpdatedAt = Date.parse(a.updatedAt.replace(" ", "T")) || 0;
  const bUpdatedAt = Date.parse(b.updatedAt.replace(" ", "T")) || 0;
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt - aUpdatedAt;

  return `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`);
};

const tableRows = computed<TableRow[]>(() => {
  const markerRows = [...props.markerList.values()].map((marker) => ({
    type: "marker" as const,
    id: marker.id,
    layerId: marker.layer_id,
    name: marker.marker_name,
    typeLabel: "マーカー",
    typeSymbol: "●",
    badgeClass: "type-marker",
    latitude: marker.latitude,
    longitude: marker.longitude,
    updatedAt: marker.update_at,
  }));
  const filteredShapeIds = props.filteredShapeIds ? new Set(props.filteredShapeIds) : null;
  const shapeRows = [...props.shapeList.values()]
    .filter((shape) => !filteredShapeIds || filteredShapeIds.has(shape.id))
    .map((shape) => {
      const center = getShapeCenter(shape);
      const badge = shapeTypeBadges[shape.shape_type];
      return {
        type: "shape" as const,
        id: shape.id,
        layerId: shape.layer_id,
        name: shape.name || "",
        typeLabel: badge.label,
        typeSymbol: badge.symbol,
        badgeClass: badge.badgeClass,
        latitude: center?.latitude ?? null,
        longitude: center?.longitude ?? null,
        updatedAt: shape.updated_at,
      };
    });
  return [...markerRows, ...shapeRows].sort(compareTableRows);
});

const focusRow = (row: TableRow): void => {
  if (row.latitude === null || row.longitude === null) return;
  emit("focusObject", row.type, row.id, row.latitude, row.longitude);
};
</script>

<template>
  <div class="table-area">
    <div class="table_sticky" :style="{ height: height + 'vh' }">
      <table>
        <thead>
          <tr>
            <th class="layer-column">Layer</th>
            <th class="object-name-column">Name</th>
            <th class="code-column">Code</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in tableRows" :key="`${row.type}:${row.id}`">
            <td class="layer-name-td layer-column" :title="getLayerForId(row.layerId)">
              {{ getLayerForId(row.layerId) }}
            </td>
            <td
              @click="emit('editObject', row.type, row.id)"
              :title="`${row.typeLabel}: ${row.name}`"
              class="object-name-td pointer"
            >
              <div class="object-name-content">
                <span
                  class="object-type-badge"
                  :class="row.badgeClass"
                  :title="`種別: ${row.typeLabel}`"
                  :aria-label="`種別: ${row.typeLabel}`"
                >
                  <span class="object-type-symbol" aria-hidden="true">{{ row.typeSymbol }}</span>
                </span>
                <span class="object-name-text">{{ row.name }}</span>
              </div>
            </td>
            <td @click="focusRow(row)" class="pointer">
              <template v-if="row.latitude !== null && row.longitude !== null">
                {{ fixFloat(row.latitude) }}<br />{{ fixFloat(row.longitude) }}
              </template>
              <template v-else>--</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.table-area {
  overflow: auto;
}

.table_sticky {
  display: block;
}

.table_sticky table {
  width: 100%;
  table-layout: fixed;
}

.table_sticky .layer-column {
  width: 27%;
}

.table_sticky .object-name-column {
  width: 50%;
}

.table_sticky .code-column {
  width: 23%;
}

.table_sticky table tbody tr:hover {
  background-color: #69a5b8;
}

.table_sticky thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

.object-name-td,
.layer-name-td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.object-name-content {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.object-type-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  box-sizing: border-box;
}

.object-type-symbol {
  font-size: 11px;
  line-height: 1;
}

.object-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-marker {
  color: #174a82;
  background-color: #e7f1ff;
  border-color: #9fc2e9;
}

.type-circle,
.type-polyline,
.type-polygon,
.type-rectangle {
  color: #81311f;
  background-color: #fff0ea;
  border-color: #e5ad9f;
}

.pointer {
  cursor: pointer;
}

.pointer:active {
  transform: scale(0.98);
  filter: brightness(1.15);
}

@media (orientation: portrait) {
  .layer-column {
    display: none;
  }

  .table_sticky th,
  .table_sticky td {
    padding-right: 4px;
    padding-left: 4px;
  }

  .table_sticky .object-name-column {
    width: 65%;
  }

  .table_sticky .code-column {
    width: 35%;
  }
}
</style>
