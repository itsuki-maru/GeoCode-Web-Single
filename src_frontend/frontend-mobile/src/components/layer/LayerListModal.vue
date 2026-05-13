<script setup lang="ts">
import { ref, computed } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";
import { assetsUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  masterLayerId: string;
}>();

const emit = defineEmits<{
  close: [];
  changeActiveLayer: [id: string];
  rename: [id: string, name: string];
  delete: [id: string, name: string];
  message: [text: string];
}>();

const layersStore = useLayersStore();
const layerList = computed(() => layersStore.layersList);

const copiedLayersMap = ref(new Map());
const queryFormLayerData = ref("");

const onLayerSearch = (reset: boolean = false): void => {
  if (reset) {
    copiedLayersMap.value = new Map(
      [...layerList.value.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
    );
    return;
  }
  const result: { id: string; user_id: string; name: string; is_master: boolean }[] = [];
  copiedLayersMap.value.forEach((value) => {
    if (value.name.includes(queryFormLayerData.value)) {
      result.push(value);
    }
  });

  result.sort((a, b) => b.id.localeCompare(a.id));

  const resultLayer: Map<
    string,
    { id: string; user_id: string; name: string; is_master: boolean }
  > = new Map();
  for (const item of result) {
    resultLayer.set(item.id, item);
  }
  copiedLayersMap.value = resultLayer;
};

const handleOpen = (): void => {
  onLayerSearch(true);
};

const handleRename = (id: string, name: string): void => {
  if (props.masterLayerId === id) {
    emit("message", "masterレイヤは名前を変更できません。");
    return;
  }
  emit("rename", id, name);
};

const handleDelete = (id: string): void => {
  if (props.masterLayerId === id) {
    emit("message", "masterレイヤは削除できません。");
    return;
  }
  const layer = layersStore.getById(id);
  emit("delete", id, layer.name);
};

defineExpose({ handleOpen });
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <h2 class="modal-h2">レイヤリスト</h2>
    <div class="search-form">
      <div class="form-text">
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
            <th id="copied-msg">LayerName</th>
            <th>Rename</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[id, layer] in copiedLayersMap" :key="id">
            <td @click="emit('changeActiveLayer', layer.id)">{{ layer.name }}</td>
            <td @click="handleRename(layer.id, layer.name)" class="td-img">
              <img :src="`${assetsUrl}stylus_24.png`" class="btn-img-table" alt="stylus_24.png" />
            </td>
            <td @click="handleDelete(layer.id)" class="td-img">
              <img :src="`${assetsUrl}delete_24.png`" class="btn-img-table" alt="delete_24.png" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="btn-zone">
      <button @click="emit('close')" class="btn-standard">閉じる</button>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.search-form {
  display: flex;
  margin-bottom: 1%;
}

.form-text {
  margin-top: 1px;
  margin-right: 1%;
  margin-bottom: 1%;
}

.query1 {
  text-align: center;
  font-size: 15px;
  width: 200px;
  height: 32px;
  border-radius: 8px;
}

.search-btn-zone {
  display: flex;
  width: 100%;
}

.btn-search-start-reset-imagelist {
  width: 45px;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
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

.table-sticky-imagelist td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50px;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.btn-img-table {
  border: none;
  box-shadow: none;
  width: 26px;
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

.btn-standard {
  min-width: 90px;
}
</style>
