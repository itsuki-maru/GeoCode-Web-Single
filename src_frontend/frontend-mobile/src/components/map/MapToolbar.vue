<script setup lang="ts">
import { computed } from "vue";
import type { LayersData } from "@/interface";
import { assetsUrl } from "@/settingMobile";

const props = defineProps<{
  activeLayer: string;
  masterLayerId: string;
  layerList: Map<string, LayersData>;
  isMasterLayer: boolean;
  isHttpsProtocol: boolean;
}>();

const emit = defineEmits<{
  "update:activeLayer": [value: string];
  openFunction: [];
  openToolbar: [];
  openImageUpload: [];
  openImageList: [];
  openQRCode: [];
  openOnetimeSetting: [];
  openNewLayer: [];
  openLayerList: [];
}>();

const localActiveLayer = computed({
  get: () => props.activeLayer,
  set: (val: string) => emit("update:activeLayer", val),
});
</script>

<template>
  <div class="maptool-btn-area">
    <div class="right-btn-header-zone">
      <div id="search-area">
        <select
          class="select-elm"
          id="layer-select-elm"
          title="レイヤ変更&#10;表示するレイヤを変更します。"
          v-model="localActiveLayer"
        >
          <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
            {{ obj.name }}
          </option>
        </select>
        <button @click="emit('openFunction')" id="function-open-elm">
          <img :src="`${assetsUrl}menu_24.png`" class="btn-img" alt="menu_24.png" />
        </button>
        <button @click="emit('openToolbar')" id="toolbar-open-elm">
          <img :src="`${assetsUrl}tool_24.png`" class="btn-img" alt="tool_24.png" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.maptool-btn-area {
  z-index: 1;
  position: fixed;
  text-align: center;
  top: 7px;
  right: 2%;
  display: flex;
  justify-content: space-between;
  margin-bottom: -7px;
}

.maptool-btn-area a {
  text-align: center;
}

#search-area {
  position: fixed;
  bottom: 6%;
  left: 3%;
  display: flex;
  margin-bottom: 10px;
  justify-content: space-around;
}

#layer-select-elm {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  border: #b8b8b8 solid 1px;
}

.select-elm {
  width: auto;
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

.right-btn-header-zone {
  display: flex;
}

#function-open-elm,
#toolbar-open-elm {
  width: 40px;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 7px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  border: #b8b8b8 solid 1px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 3px;
  text-align: center;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}
</style>
