<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { MapObjectData, QueryForm } from '@/interface';
import { useMapObjectStore } from '@/stores/mapobjects';
import { useLayersStore } from '@/stores/layers';

const props = defineProps<{
  mapobjList: Map<string, MapObjectData>;
  height: number;
  activeLayer: string;
}>();

const emit = defineEmits<{
  editMarker: [id: string];
  focusMarker: [id: string, lat: number, lng: number];
}>();

const layersStore = useLayersStore();

const getLayerForId = (layer_id: string): string => {
  const layerObj = layersStore.getById(layer_id);
  if (layerObj) {
    return layerObj.name;
  } else {
    return 'Layer Name Get Error';
  }
};

function fixFloat(number: number): string {
  return number.toFixed(5);
}
</script>

<template>
  <div class="table-area">
    <div class="table_sticky" :style="{ height: height + 'vh' }">
      <table>
        <thead>
          <tr>
            <th>Layer</th>
            <th>Name</th>
            <th>Code</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[id, obj] in mapobjList" :key="id">
            <td id="layer-name-td" :title="getLayerForId(obj.layer_id)">
              {{ getLayerForId(obj.layer_id) }}
            </td>
            <td
              @click="emit('editMarker', obj.id)"
              :title="obj.marker_name"
              id="marker-name-td"
              class="pointer"
            >
              {{ obj.marker_name }}
            </td>
            <td @click="emit('focusMarker', obj.id, obj.latitude, obj.longitude)" class="pointer">
              {{ fixFloat(obj.latitude) }}<br />{{ fixFloat(obj.longitude) }}
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

#marker-name-td,
#layer-name-td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.pointer {
  cursor: pointer;
}

.pointer:active {
  transform: scale(0.98);
  filter: brightness(1.15);
}
</style>
