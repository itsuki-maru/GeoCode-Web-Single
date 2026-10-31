<script setup lang="ts">
import { computed, toRef, watch } from "vue";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useMapObjectTableRows } from "@/composables/useMapObjectTableRows";
import { useVirtualTable, TABLE_ROW_HEIGHT } from "@/composables/useVirtualTable";
import type { TableRow } from "@/composables/map-object-table-index";

const props = withDefaults(
  defineProps<{ height: number; activeLayer: string; active?: boolean }>(),
  { active: true },
);
const emit = defineEmits<{
  editObject: [type: "marker" | "shape", id: string];
  focusObject: [type: "marker" | "shape", id: string, lat: number, lng: number];
}>();
const layersStore = useLayersStore();
const mapobjStore = useMapObjectStore();
const active = toRef(props, "active");
const { count, rows } = useMapObjectTableRows(active);
const { viewport, range, onScroll, resetScroll } = useVirtualTable(count, active);
const visibleRows = computed(() => rows(range.value.start, range.value.end));
watch(
  () => [
    props.activeLayer,
    mapobjStore.search?.query1,
    mapobjStore.search?.query2,
    mapobjStore.attributeRevision,
  ],
  resetScroll,
);
const getLayerForId = (id: string) => layersStore.getById(id)?.name ?? "Layer Name Get Error";
const fixFloat = (value: number) => value.toFixed(5);
const focusRow = (row: TableRow): void => {
  if (row.latitude !== null && row.longitude !== null)
    emit("focusObject", row.type, row.id, row.latitude, row.longitude);
};
</script>

<template>
  <div
    v-if="active"
    ref="viewport"
    class="table-area"
    tabindex="0"
    role="region"
    aria-label="地図オブジェクト一覧"
    :style="{ height: height + 'vh', '--map-table-row-height': TABLE_ROW_HEIGHT + 'px' }"
    @scroll.passive="onScroll"
  >
    <div class="table_sticky">
      <table :aria-rowcount="count + 1">
        <thead>
          <tr>
            <th class="layer-column">Layer</th>
            <th class="object-name-column">Name</th>
            <th class="code-column">Code</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="range.top" class="virtual-spacer" aria-hidden="true">
            <td colspan="3" :style="{ height: range.top + 'px' }"></td>
          </tr>
          <tr
            v-for="row in visibleRows"
            :key="row.key"
            :data-row-key="row.key"
            :aria-rowindex="row.index + 2"
            class="object-row"
            :class="{ 'even-row': row.index % 2 === 1 }"
          >
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
          <tr v-if="range.bottom" class="virtual-spacer" aria-hidden="true">
            <td colspan="3" :style="{ height: range.bottom + 'px' }"></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.table-area {
  overflow-anchor: none;
  overflow: auto;
}

.table_sticky {
  display: block;
}

.table_sticky table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
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

/* CSS ピクセル単位の固定高には、境界線と座標の二行を含める。 */
.table_sticky .object-row {
  height: var(--map-table-row-height);
  background: white;
}
.table_sticky .object-row.even-row {
  background: rgb(238, 238, 238);
}
.table_sticky .object-row td {
  height: var(--map-table-row-height);
  box-sizing: border-box;
  line-height: 18px;
  font-size: 12px;
  padding: 6px 13px;
}
.table_sticky .virtual-spacer,
.table_sticky .virtual-spacer:hover {
  border: 0;
  background: transparent;
}
.table_sticky .virtual-spacer td {
  padding: 0;
  border: 0;
  font-size: 0;
  line-height: 0;
}
.table_sticky .object-row:hover {
  background: #69a5b8;
}

@media (orientation: portrait) {
  .table_sticky .object-row td {
    padding-right: 4px;
    padding-left: 4px;
  }
}
</style>
