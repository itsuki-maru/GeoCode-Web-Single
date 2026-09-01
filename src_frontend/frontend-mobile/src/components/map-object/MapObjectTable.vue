<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { MapObjectData, QueryForm, ShapeData } from "@/interface";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { useLayersStore } from "@/stores/layers";
import { getShapeCenter } from "@/composables/useShapeCenter";

const props = defineProps<{
  activeLayer: string;
  mapObjectQueryFormData: QueryForm;
}>();

const emit = defineEmits<{
  editObject: [type: "marker" | "shape", id: string];
  focusObject: [type: "marker" | "shape", id: string, lat: number, lng: number];
  deleteMarker: [id: string];
  message: [text: string];
  mapObjectSearch: [query: QueryForm, reset: boolean];
  "update:mapObjectQueryFormData": [query: QueryForm];
}>();

const mapobjStore = useMapObjectStore();
const shapeStore = useShapeStore();
const layersStore = useLayersStore();

const markerList = computed((): Map<string, MapObjectData> => {
  return mapobjStore.mapObjectList;
});

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
  const markerRows = [...markerList.value.values()].map((marker) => ({
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
  const filteredShapeIds = mapobjStore.filteredShapeIds
    ? new Set(mapobjStore.filteredShapeIds)
    : null;
  const shapeRows = [...shapeStore.shapeList.values()]
    .filter((shape: ShapeData) => !filteredShapeIds || filteredShapeIds.has(shape.id))
    .map((shape: ShapeData) => {
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

const mapObjectQueryFormData = ref<QueryForm>({ ...props.mapObjectQueryFormData });
let suppressNextWatchSearch = false;

const isSameQuery = (a: QueryForm, b: QueryForm): boolean => {
  return a.query1 === b.query1 && a.query2 === b.query2;
};

const onMapObjectSearch = (reset: boolean = false): void => {
  if (reset) {
    suppressNextWatchSearch = true;
    mapObjectQueryFormData.value = { query1: "", query2: "" };
  }
  emit("mapObjectSearch", { ...mapObjectQueryFormData.value }, reset);
};

watch(
  () => props.mapObjectQueryFormData,
  (query) => {
    if (isSameQuery(query, mapObjectQueryFormData.value)) return;
    suppressNextWatchSearch = true;
    mapObjectQueryFormData.value = { ...query };
  },
);

watch(
  mapObjectQueryFormData,
  () => {
    emit("update:mapObjectQueryFormData", { ...mapObjectQueryFormData.value });
    if (suppressNextWatchSearch) {
      suppressNextWatchSearch = false;
      return;
    }
    onMapObjectSearch();
  },
  { deep: true },
);

const getLayerForId = (layer_id: string): string | void => {
  const layerObj = layersStore.getById(layer_id);
  if (layerObj) {
    return layerObj.name;
  }
};

function fixFloat(number: number): string {
  return number.toFixed(5);
}

const focusRow = (row: TableRow): void => {
  if (row.latitude === null || row.longitude === null) return;
  emit("focusObject", row.type, row.id, row.latitude, row.longitude);
};

// スワイプ削除機能
const startX = ref<number | null>(null);
const isSwiping = ref<Record<string, boolean>>({});
const confirmDelete = ref<Record<string, boolean>>({});
const rowOffsets = ref<Record<string, number>>({});
const selectedMarkerId = ref("");

function getRowsStyle(index: string) {
  return {
    transform: `translateX(${rowOffsets.value[index] || 0}px)`,
    transition: isSwiping.value[index] ? "none" : "transform 0.3s ease",
  };
}

function onTouchStart(index: string, event: TouchEvent) {
  if (!event.touches[0]) return;
  selectedMarkerId.value = index;
  startX.value = event.touches[0].clientX;
  isSwiping.value[index] = false;
  confirmDelete.value[index] = false;
}

function onTouchMove(index: string, event: TouchEvent) {
  if (startX.value === null) {
    selectedMarkerId.value = "";
    return;
  }
  if (!event.touches[0]) return;
  const diffX = event.touches[0].clientX - startX.value;
  if (diffX < 0) {
    isSwiping.value[index] = true;
    rowOffsets.value[index] = diffX;
  }
}

function onTouchEnd(index: string, event: TouchEvent) {
  if (startX.value === null) {
    selectedMarkerId.value = "";
    return;
  }
  if (!event.changedTouches?.[0]) return;
  const diffX = startX.value - event?.changedTouches?.[0].clientX;
  if (diffX > 100) {
    confirmDelete.value[index] = true;
    rowOffsets.value[index] = -100;
    setTimeout(() => {
      if (window.confirm("このマーカーを削除しますか?")) {
        emit("deleteMarker", index);
        delete rowOffsets.value[index];
      } else {
        confirmDelete.value[index] = false;
        rowOffsets.value[index] = 0;
      }
    }, 300);
  } else {
    isSwiping.value[index] = false;
    rowOffsets.value[index] = 0;
  }
  startX.value = null;
  isSwiping.value[index] = false;
  selectedMarkerId.value = "";
}
</script>

<template>
  <div id="map-object-search-row" role="search" aria-label="地図オブジェクト検索">
    <input
      type="text"
      name="map-object-search-query-1"
      autocomplete="off"
      aria-label="検索ワード1"
      maxlength="15"
      title="15字以内で入力してください。"
      placeholder="検索ワード1"
      id="search-textbox1"
      class="search-map-object-box"
      required
      v-model="mapObjectQueryFormData.query1"
    />
    <input
      type="text"
      name="map-object-search-query-2"
      autocomplete="off"
      aria-label="検索ワード2"
      maxlength="15"
      title="15字以内で入力してください。"
      placeholder="検索ワード2"
      id="search-textbox2"
      class="search-map-object-box"
      required
      v-model="mapObjectQueryFormData.query2"
    />
  </div>

  <div class="table-area">
    <div class="table_sticky">
      <table>
        <thead>
          <tr>
            <th>Layer</th>
            <th>Name</th>
            <th>Code</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in tableRows"
            :key="`${row.type}:${row.id}`"
            :class="{ swiping: isSwiping[row.id], 'confirm-delete': confirmDelete[row.id] }"
            :style="getRowsStyle(row.id)"
            id="swipe-tr"
            @touchstart="row.type === 'marker' && onTouchStart(row.id, $event)"
            @touchmove="row.type === 'marker' && onTouchMove(row.id, $event)"
            @touchend="row.type === 'marker' && onTouchEnd(row.id, $event)"
          >
            <td>{{ getLayerForId(row.layerId) }}</td>
            <td
              @click="emit('editObject', row.type, row.id)"
              :title="`${row.typeLabel}: ${row.name}`"
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
            <td @click="focusRow(row)">
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
#map-object-search-row {
  display: flex;
  margin: 30px auto;
}

#search-textbox1 {
  margin-right: 1%;
}

.search-map-object-box {
  width: 90%;
  height: 30px;
  text-align: center;
  font-size: 16px;
  border-color: #acacac;
  border-radius: 8px;
}

.table-area {
  overflow: auto;
  margin-top: 20px;
  margin-bottom: 10px;
  height: 68vh;
}

.table_sticky {
  display: block;
  width: 100%;
}

.table_sticky td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
}

.object-name-content {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.object-type-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.35;
  box-sizing: border-box;
}

.object-type-symbol {
  font-size: 10px;
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

.table_sticky thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

table {
  width: 100%;
  padding: 0;
}

table tr {
  border-top: 1px solid #cccccc;
  background-color: rgb(255, 255, 255);
  margin: 0;
  padding: 0;
}

table tr:nth-child(2n) {
  background-color: rgb(238, 238, 238);
}

table tr th {
  font-weight: bold;
  border: 1px solid #cccccc;
  text-align: left;
  margin: 0;
  padding: 6px 13px;
  background-color: #a5cef7;
}

table tr td {
  border: 1px solid #cccccc;
  text-align: left;
  margin: 0;
  padding: 6px 13px;
  font-size: 14px;
}

th:nth-child(1) {
  width: 20%;
}

th:nth-child(2) {
  width: auto;
}

th:nth-child(3) {
  width: 10%;
}

#swipe-tr {
  transition:
    transform 0.3s ease,
    background-color 0.3s ease;
  position: relative;
}

#swipe-tr.swiping {
  background-color: #ffcccc;
}

#swipe-tr.confirm-delete {
  background-color: #ff6666;
  color: white;
}

.on-focus:active {
  background-color: black;
}
</style>
