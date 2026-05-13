<script setup lang="ts">
import { ref, computed } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";
import type { LayersData } from "@/interface";
import { assetsUrl } from "@/setting";

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  changeActiveLayer: [id: string];
  rename: [id: string, name: string];
  deleteLayer: [id: string];
}>();

const layersStore = useLayersStore();
const layerList = computed((): Map<string, LayersData> => layersStore.layersList);

const copiedLayersMap = ref(new Map<string, LayersData>());
const queryFormLayerData = ref("");

const onLayerSearch = (reset: boolean = false): void => {
  if (reset) {
    copiedLayersMap.value = new Map(
      [...layerList.value.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
    );
    return;
  }
  let result: LayersData[] = [];
  copiedLayersMap.value.forEach((value) => {
    if (value.name.includes(queryFormLayerData.value)) {
      result.push(value);
    }
  });

  result.sort((a, b) => b.id.localeCompare(a.id));

  let resultLayer = new Map<string, LayersData>();
  for (let item of result) {
    resultLayer.set(item.id, item);
  }
  copiedLayersMap.value = resultLayer;
};

const initSearch = (): void => {
  onLayerSearch(true);
};

defineExpose({ initSearch });
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="layer-list-content">
      <h2 class="modal-h2">レイヤリスト</h2>
      <div class="search-form">
        <div>
          <input
            type="text"
            maxlength="15"
            title=""
            class="query1"
            placeholder="検索ワード"
            v-model="queryFormLayerData"
          />
        </div>
        <div class="search-btn-zone">
          <button
            class="btn-search-start-reset-imagelist"
            type="submit"
            title="検索実行"
            @click.prevent="onLayerSearch(false)"
          >
            <img :src="`${assetsUrl}search_fill24.png`" class="btn-img" alt="search_fill24.png" />
          </button>
          <button
            class="btn-search-start-reset-imagelist"
            type="submit"
            title="検索結果をクリア"
            @click.prevent="onLayerSearch(true)"
          >
            <img :src="`${assetsUrl}update_fill24.png`" class="btn-img" alt="update_fill24.png" />
          </button>
        </div>
      </div>
      <div class="table-sticky-imagelist">
        <table>
          <thead>
            <tr>
              <th>LayerName</th>
              <th>Rename</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[id, layer] in copiedLayersMap" :key="id">
              <td @click="emit('changeActiveLayer', layer.id)">{{ layer.name }}</td>
              <td @click="emit('rename', layer.id, layer.name)" class="td-img">
                <img :src="`${assetsUrl}stylus_24.png`" class="btn-img-table" alt="stylus_24.png" />
              </td>
              <td @click="emit('deleteLayer', layer.id)" class="td-img">
                <img :src="`${assetsUrl}delete_24.png`" class="btn-img-table" alt="delete_24.png" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="btn-zone">
        <button @click="emit('close')">閉じる</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.layer-list-content {
  width: 50vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.search-form {
  display: flex;
  margin-bottom: 1%;
}

.query1 {
  margin-top: 1px;
  margin-right: 1%;
  font-size: 17px;
  width: 100%;
  padding: 0.6em 1.2em;
  display: flex;
  text-align: center;
  margin-bottom: 2%;
  border-radius: 5px;
  box-sizing: border-box;
}

.query1:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.search-btn-zone {
  display: flex;
}

.btn-search-start-reset-imagelist {
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  background: #ffffff;
  width: 50px;
  height: 45px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  text-decoration: none;
  border: 1px solid rgb(207, 207, 207);
  border-radius: 50%;
  padding: 0;
  transition-duration: 0.5s;
  transition: background-color 0.3s;
  margin-left: 8px;
  margin-right: 2%;
}

.btn-search-start-reset-imagelist:hover {
  background: rgb(235, 235, 235);
}

.table-sticky-imagelist table {
  margin-top: 0;
}

.table-sticky-imagelist {
  display: block;
  overflow-y: auto;
  height: 40vh;
}

.table-sticky-imagelist thead th {
  position: sticky;
  top: 0;
  width: 100%;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

.table-sticky-imagelist table tbody tr:hover {
  background-color: #69a5b8;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.btn-img-table {
  border: none;
  box-shadow: none;
  width: 28px;
}

.btn-img-table:hover {
  opacity: 0.5;
}

.td-img {
  text-align: center;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}
</style>
