<script setup lang="ts">
import { ref, computed, watch, toRef, onScopeDispose } from "vue";
import type { QueryForm } from "@/interface";
import { assetsUrl } from "@/settingMobile";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useMapObjectTableRows } from "@/composables/useMapObjectTableRows";
import { useVirtualTable, TABLE_ROW_HEIGHT } from "@/composables/useVirtualTable";
import type { TableRow } from "@/composables/map-object-table-index";

const props = withDefaults(
  defineProps<{
    attributeSearchActive?: boolean;
    activeLayer: string;
    mapObjectQueryFormData: QueryForm;
    active?: boolean;
  }>(),
  { active: true },
);
const emit = defineEmits<{
  advancedSearch: [];
  editObject: [type: "marker" | "shape", id: string];
  focusObject: [type: "marker" | "shape", id: string, lat: number, lng: number];
  deleteMarker: [id: string];
  message: [text: string];
  mapObjectSearch: [query: QueryForm, reset: boolean];
  "update:mapObjectQueryFormData": [query: QueryForm];
}>();
const mapobjStore = useMapObjectStore();
const layersStore = useLayersStore();
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

const getLayerForId = (id: string) => layersStore.getById(id)?.name;
const fixFloat = (value: number) => value.toFixed(5);
const focusRow = (row: TableRow): void => {
  if (row.latitude !== null && row.longitude !== null)
    emit("focusObject", row.type, row.id, row.latitude, row.longitude);
};

// One gesture belongs to a typed ID, never to the recycled row position.
const swipe = ref<{ key: string; offset: number; moving: boolean; confirm: boolean } | null>(null);
let startX: number | null = null;
let deleteTimer: ReturnType<typeof setTimeout> | undefined;
function clearSwipe() {
  clearTimeout(deleteTimer);
  deleteTimer = undefined;
  swipe.value = null;
  startX = null;
}
function getRowsStyle(key: string) {
  const state = swipe.value?.key === key ? swipe.value : null;
  return {
    transform: `translateX(${state?.offset ?? 0}px)`,
    transition: state?.moving ? "none" : "transform 0.3s ease",
  };
}
function onTouchStart(row: TableRow, event: TouchEvent) {
  clearSwipe();
  if (row.type !== "marker" || !event.touches[0]) return;
  startX = event.touches[0].clientX;
  swipe.value = { key: row.key, offset: 0, moving: false, confirm: false };
}
function onTouchMove(row: TableRow, event: TouchEvent) {
  if (startX === null || swipe.value?.key !== row.key || !event.touches[0]) return;
  swipe.value.offset = Math.min(0, event.touches[0].clientX - startX);
  swipe.value.moving = true;
}
function onTouchEnd(row: TableRow, event: TouchEvent) {
  if (startX === null || swipe.value?.key !== row.key || !event.changedTouches[0]) return;
  const distance = startX - event.changedTouches[0].clientX;
  startX = null;
  if (distance <= 100) {
    clearSwipe();
    return;
  }
  swipe.value.offset = -100;
  swipe.value.moving = false;
  swipe.value.confirm = true;
  deleteTimer = setTimeout(() => {
    if (
      active.value &&
      swipe.value?.key === row.key &&
      visibleRows.value.some((visible) => visible.key === row.key) &&
      window.confirm("このマーカーを削除しますか?")
    )
      emit("deleteMarker", row.id);
    clearSwipe();
  }, 300);
}
watch([active, visibleRows], () => {
  if (!active.value || !visibleRows.value.some((row) => row.key === swipe.value?.key)) clearSwipe();
});
onScopeDispose(clearSwipe);
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
    <button
      class="btn-head-image-search advanced-search-button"
      type="button"
      :title="attributeSearchActive ? '詳しい検索（適用中）' : '詳しい検索'"
      aria-label="詳しい検索"
      @click="emit('advancedSearch')"
      :aria-pressed="!!attributeSearchActive"
    >
      <img :src="`${assetsUrl}search_fill24.png`" class="btn-img" alt="" />
    </button>
  </div>

  <div
    v-if="active"
    ref="viewport"
    class="table-area"
    tabindex="0"
    role="region"
    aria-label="地図オブジェクト一覧"
    :style="{ '--map-table-row-height': TABLE_ROW_HEIGHT + 'px' }"
    @scroll.passive="onScroll"
  >
    <div class="table_sticky">
      <table :aria-rowcount="count + 1">
        <thead>
          <tr>
            <th>Layer</th>
            <th>Name</th>
            <th>Code</th>
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
            class="object-row swipe-tr"
            :class="{
              'even-row': row.index % 2 === 1,
              swiping: swipe?.key === row.key && swipe.moving,
              'confirm-delete': swipe?.key === row.key && swipe.confirm,
            }"
            :style="getRowsStyle(row.key)"
            @touchstart="onTouchStart(row, $event)"
            @touchmove="onTouchMove(row, $event)"
            @touchend="onTouchEnd(row, $event)"
            @touchcancel="clearSwipe"
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
          <tr v-if="range.bottom" class="virtual-spacer" aria-hidden="true">
            <td colspan="3" :style="{ height: range.bottom + 'px' }"></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.btn-head-image-search {
  box-sizing: border-box;
  display: inline-flex;
  flex: 0 0 40px;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 8px 5px;
  border: 1px solid transparent;
  border-radius: 15px;
  background: white;
  color: #000;
  transition: background-color 0.3s;
  cursor: pointer;
}
.btn-head-image-search:hover {
  background: rgb(192, 192, 192);
}
.btn-head-image-search[aria-pressed="true"] {
  border-color: #2165bb;
  background: #eaf2ff;
}
.btn-img {
  display: block;
  width: 24px;
  border: none;
  box-shadow: none;
}

#map-object-search-row {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  min-width: 0;
  margin: 30px auto;
}

.search-map-object-box {
  box-sizing: border-box;
  flex: 1 1 0;
  min-width: 0;
  width: 0;
  height: 30px;
  text-align: center;
  font-size: 16px;
  border-color: #acacac;
  border-radius: 8px;
}

.table-area {
  overflow-anchor: none;
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

.swipe-tr {
  transition:
    transform 0.3s ease,
    background-color 0.3s ease;
  position: relative;
}

.on-focus:active {
  background-color: black;
}

/* Fixed CSS-pixel height includes borders and both coordinate lines. */
.table_sticky table {
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}
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
.table_sticky .swipe-tr.swiping {
  background: #ffcccc;
}
.table_sticky .swipe-tr.confirm-delete {
  background: #ff6666;
  color: white;
}

.table_sticky th:nth-child(1) {
  width: 20%;
}
.table_sticky th:nth-child(2) {
  width: 45%;
}
.table_sticky th:nth-child(3) {
  width: 35%;
}
</style>
