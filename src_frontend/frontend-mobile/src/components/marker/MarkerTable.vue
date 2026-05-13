<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { MapObjectData } from "@/interface";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";

const props = defineProps<{
  activeLayer: string;
}>();

const emit = defineEmits<{
  editMarker: [id: string];
  focusMarker: [id: string, lat: number, lng: number];
  deleteMarker: [id: string];
  message: [text: string];
}>();

const mapobjStore = useMapObjectStore();
const layersStore = useLayersStore();

const mapobjList = computed((): Map<string, MapObjectData> => {
  return mapobjStore.mapObjectList;
});

const markerQueryFormData = ref({ query1: "", query2: "" });
watch(markerQueryFormData.value, () => {
  onMarkerSearch();
});

const onMarkerSearch = (reset: boolean = false): void => {
  try {
    if (reset) {
      mapobjStore.queryWordMapObject("", "", props.activeLayer);
    } else {
      mapobjStore.queryWordMapObject(
        markerQueryFormData.value.query1,
        markerQueryFormData.value.query2,
        props.activeLayer,
      );
    }
  } catch (error) {
    console.error(error);
  }
};

const getLayerForId = (layer_id: string): string | void => {
  const layerObj = layersStore.getById(layer_id);
  if (layerObj) {
    return layerObj.name;
  }
};

function fixFloat(number: number): string {
  return number.toFixed(5);
}

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
  <div id="marker-search-row">
    <input
      type="text"
      maxlength="15"
      title="15字以内で入力してください。"
      placeholder="検索ワード1"
      id="search-textbox1"
      class="search-marker-box"
      required
      v-model="markerQueryFormData.query1"
    />
    <input
      type="text"
      maxlength="15"
      title="15字以内で入力してください。"
      placeholder="検索ワード2"
      id="search-textbox2"
      class="search-marker-box"
      required
      v-model="markerQueryFormData.query2"
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
            v-for="[id, obj] in mapobjList"
            :key="id"
            :class="{ swiping: isSwiping[id], 'confirm-delete': confirmDelete[id] }"
            :style="getRowsStyle(id)"
            id="swipe-tr"
            @touchstart="onTouchStart(id, $event)"
            @touchmove="onTouchMove(id, $event)"
            @touchend="onTouchEnd(id, $event)"
          >
            <td>{{ getLayerForId(obj.layer_id) }}</td>
            <td @click="emit('editMarker', obj.id)">{{ obj.marker_name }}</td>
            <td @click="emit('focusMarker', obj.id, obj.latitude, obj.longitude)">
              {{ fixFloat(obj.latitude) }}<br />{{ fixFloat(obj.longitude) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
#marker-search-row {
  display: flex;
  margin: 30px auto;
}

#search-textbox1 {
  margin-right: 1%;
}

.search-marker-box {
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
