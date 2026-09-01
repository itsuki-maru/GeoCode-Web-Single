<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { LayersData, QueryForm } from "@/interface";
import { baseUrl, assetsUrl } from "@/setting";
import { useWindowSize } from "@/composables/useWindowSize";

const props = defineProps<{
  activeLayer: string;
  masterLayerId: string;
  layerList: Map<string, LayersData>;
  isMasterLayer: boolean;
  isHttpsProtocol: boolean;
  mapObjectQueryFormData: QueryForm;
}>();

const emit = defineEmits<{
  newLayer: [];
  imageUpload: [];
  imageList: [];
  qrCode: [];
  onetimeSetting: [];
  fullScreenMap: [];
  exportJson: [];
  importJson: [];
  userSetting: [];
  reloadMap: [url: string, absolute: boolean];
  layerList: [];
  mapObjectSearch: [query: QueryForm, reset: boolean];
  "update:mapObjectQueryFormData": [query: QueryForm];
  "update:activeLayer": [id: string];
}>();

const mapObjectQueryFormData = ref<QueryForm>({ ...props.mapObjectQueryFormData });
const { width, height } = useWindowSize();
const isPortrait = computed((): boolean => height.value >= width.value);
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

watch(
  isPortrait,
  (portrait) => {
    if (!portrait || mapObjectQueryFormData.value.query2 === "") return;
    mapObjectQueryFormData.value.query2 = "";
  },
  { immediate: true },
);

const selectedLayer = computed({
  get: () => props.activeLayer,
  set: (val: string) => emit("update:activeLayer", val),
});

defineExpose({ mapObjectQueryFormData, onMapObjectSearch });
</script>

<template>
  <div class="header-btn-zone">
    <div class="left-btn-header-zone">
      <button
        @click="emit('newLayer')"
        class="btn-head-image"
        title="新規レイヤの追加&#10;マーカーを保存するグループを作成します。"
      >
        <img
          :src="`${assetsUrl}layer_add_combined_24.png`"
          class="btn-img"
          alt="layer_add_combined_24.png"
        />
      </button>
      <button
        @click="emit('imageUpload')"
        class="btn-head-image"
        title="ファイルの追加&#10;画像、動画、PDFファイルに対応しています。&#10;追加したファイルはマーカー情報に組み込むことが可能です。"
      >
        <img
          :src="`${assetsUrl}smartphone_line24.png`"
          class="btn-img"
          alt="smartphone_line24.png"
        />
      </button>
      <button
        @click="emit('imageList')"
        class="btn-head-image"
        title="ファイル一覧&#10;追加した画像や動画、PDFを確認したり、検索したりできます。"
      >
        <img :src="`${assetsUrl}documents_line24.png`" class="btn-img" alt="documents_line24.png" />
      </button>
      <button
        @click="emit('qrCode')"
        class="btn-head-image"
        title="QRコード生成&#10;文字列からQRコードを生成します。"
      >
        <img
          :src="`${assetsUrl}code_reader_line24.png`"
          class="btn-img"
          alt="code_reader_line24.png"
        />
      </button>
      <button
        @click="emit('onetimeSetting')"
        class="btn-head-image"
        title="レイヤーの共有URLを作成"
      >
        <img :src="`${assetsUrl}family_line24.png`" class="btn-img" alt="family_line24.png" />
      </button>
      <button @click="emit('fullScreenMap')" class="btn-head-image" title="フルスクリーンマップ">
        <img
          :src="`${assetsUrl}new_window_fill24.png`"
          class="btn-img"
          alt="new_window_fill24.png"
        />
      </button>
      <button
        v-if="!isMasterLayer"
        @click="emit('exportJson')"
        class="btn-head-image"
        title="エクスポート&#10;マーカーやレイヤ情報をエクスポートします。画像はエクスポートされません。&#10;エクスポートしたデータは別の端末でインポートすることができます。"
      >
        <img :src="`${assetsUrl}download_24.png`" class="btn-img" alt="download_24.png" />
      </button>
      <button
        @click="emit('importJson')"
        class="btn-head-image"
        title="インポート&#10;マーカーやレイヤ情報をインポートします。"
      >
        <img :src="`${assetsUrl}upload_24.png`" class="btn-img" alt="upload_24.png" />
      </button>
      <button
        @click="emit('userSetting')"
        class="btn-head-image"
        title="ユーザー設定&#10;アカウントのプライバシー設定を変更します。"
      >
        <img
          :src="`${assetsUrl}manage_accounts_24.png`"
          class="btn-img"
          alt="manage_accounts_24.png"
        />
      </button>
    </div>
    <div class="right-btn-header-zone" role="search" aria-label="地図オブジェクト検索">
      <input
        type="text"
        name="map-object-search-query-1"
        autocomplete="off"
        aria-label="検索ワード1"
        maxlength="15"
        title="15字以内で入力してください。"
        :placeholder="isPortrait ? '検索ワード' : '検索ワード1'"
        id="search-textbox1"
        class="search-box"
        required
        v-model="mapObjectQueryFormData.query1"
      />
      <input
        v-show="!isPortrait"
        type="text"
        name="map-object-search-query-2"
        autocomplete="off"
        aria-label="検索ワード2"
        maxlength="15"
        title="15字以内で入力してください。"
        placeholder="検索ワード2"
        id="search-textbox2"
        class="search-box"
        required
        v-model="mapObjectQueryFormData.query2"
      />
      <button
        v-if="isMasterLayer"
        @click="emit('reloadMap', `${baseUrl}/map?layer=${activeLayer}&is_master=true`, true)"
        class="btn-head-image-search"
        title="リロード&#10;検索結果や地図の状態をリセットします。"
      >
        <img :src="`${assetsUrl}update_fill24.png`" class="btn-img" alt="update_fill24.png" />
      </button>
      <button
        v-if="!isMasterLayer"
        @click="emit('reloadMap', `${baseUrl}/map?layer=${activeLayer}&is_master=false`, true)"
        class="btn-head-image-search"
        title="リロード&#10;検索結果や地図の状態をリセットします。"
      >
        <img :src="`${assetsUrl}update_fill24.png`" class="btn-img" alt="update_fill24.png" />
      </button>
      <button
        @click="emit('layerList')"
        class="btn-head-image-search"
        title="レイヤ一覧&#10;作成したレイヤ一覧を確認したり、マーカーを変更したりできます。"
      >
        <img :src="`${assetsUrl}layer_add_24.png`" class="btn-img" alt="layer_add_24.png" />
      </button>
      <select
        class="select-elm"
        id="layer-select-elm"
        title="レイヤ変更&#10;表示するレイヤを変更します。"
        v-model="selectedLayer"
      >
        <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
          {{ obj.name }}
        </option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.header-btn-zone {
  display: flex;
  justify-content: space-between;
  margin-bottom: -7px;
}

.header-btn-zone a {
  text-align: center;
}

.btn-head-image {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 53px;
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

.btn-head-image:hover {
  background: rgb(192, 192, 192);
}

.btn-head-image-search {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
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

.btn-head-image-search:hover {
  background: rgb(192, 192, 192);
}

.btn-img {
  display: block;
  border: none;
  box-shadow: none;
  width: 24px;
}
.left-btn-header-zone {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  min-width: 0;
  justify-content: flex-start;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
}

.right-btn-header-zone {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-left: -100px;
}

.right-btn-header-zone .select-elm {
  box-sizing: border-box;
  width: auto;
  max-width: 130px;
  height: 40px;
  overflow-x: hidden;
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

.select-elm:hover {
  background: rgb(236, 236, 236);
}

.search-box {
  box-sizing: border-box;
  font-size: 18px;
  width: 20%;
  height: 40px;
  text-align: center;
  border-radius: 11px;
  margin-right: 1%;
}

.search-box:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

#search-textbox1 {
  margin-right: 2%;
}

@media (orientation: portrait) {
  .header-btn-zone {
    align-items: flex-start;
    justify-content: flex-start;
    flex-wrap: nowrap;
    margin-bottom: 0;
  }

  .left-btn-header-zone {
    margin-right: 12px;
    padding-bottom: 7px;
  }

  .right-btn-header-zone {
    flex: 0 0 auto;
    justify-content: flex-start;
    width: max-content;
    margin-left: 0;
  }

  .btn-head-image,
  .btn-head-image-search,
  .right-btn-header-zone .select-elm {
    flex: 0 0 auto;
  }

  .search-box {
    flex: 0 0 150px;
    width: 150px;
  }
}
</style>
