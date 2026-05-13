<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { LayersData, QueryForm } from "@/interface";
import { baseUrl, assetsUrl } from "@/setting";
import { useMapObjectStore } from "@/stores/mapobjects";

const mapobjStore = useMapObjectStore();

const props = defineProps<{
  activeLayer: string;
  masterLayerId: string;
  layerList: Map<string, LayersData>;
  isMasterLayer: boolean;
  isHttpsProtocol: boolean;
  markerQueryFormData: QueryForm;
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
  "update:activeLayer": [id: string];
}>();

const markerQueryFormData = ref<QueryForm>({
  query1: "",
  query2: "",
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

watch(markerQueryFormData.value, () => {
  onMarkerSearch();
});

const selectedLayer = computed({
  get: () => props.activeLayer,
  set: (val: string) => emit("update:activeLayer", val),
});

defineExpose({ markerQueryFormData, onMarkerSearch });
</script>

<template>
  <div class="header-btn-zone">
    <div class="left-btn-header-zone">
      <button
        @click="emit('newLayer')"
        class="btn-head-image"
        title="新規レイヤの追加&#10;マーカーを保存するグループを作成します。"
      >
        <img :src="`${assetsUrl}layer_add_24.png`" class="btn-img" alt="layer_add_24.png" />
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
    <div class="right-btn-header-zone">
      <input
        type="text"
        maxlength="15"
        title="15字以内で入力してください。"
        placeholder="検索ワード1"
        id="search-textbox1"
        class="search-box"
        required
        v-model="markerQueryFormData.query1"
      />
      <input
        type="text"
        maxlength="15"
        title="15字以内で入力してください。"
        placeholder="検索ワード2"
        id="search-textbox2"
        class="search-box"
        required
        v-model="markerQueryFormData.query2"
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
        title="レイヤ一覧&#10;作成したレイヤ一覧を確認したり、レイヤを検索したりできます。"
      >
        <img :src="`${assetsUrl}list_24.png`" class="btn-img" alt="list_24.png" />
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
  border: none;
  box-shadow: none;
  width: 24px;
}
.left-btn-header-zone {
  justify-content: flex-start;
}

.right-btn-header-zone {
  display: flex;
  justify-content: flex-end;
  margin-left: -100px;
}

.right-btn-header-zone .select-elm {
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
  font-size: 18px;
  width: 20%;
  height: 38px;
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
</style>
