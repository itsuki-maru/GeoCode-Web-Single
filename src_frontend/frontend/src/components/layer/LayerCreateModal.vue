<script setup lang="ts">
import { ref } from "vue";
import TileOverlayChoices from "./TileOverlayChoices.vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";
import { addLayerUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import { AxiosError } from "axios";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  tilesChanged: [tiles: unknown[]];
  message: [text: string];
  loginRedirect: [];
}>();

const layersStore = useLayersStore();
const newLayerName = ref("");
const mode = ref("group");
const tilesSaving = ref(false);

const layerAdd = async (): Promise<void> => {
  if (newLayerName.value === "") {
    emit("message", "レイヤ名を入力してください。");
    return;
  }
  try {
    const postUrl = `${addLayerUrl}?name=${newLayerName.value}`;
    await apiClient.post(postUrl);
    layersStore.initList();
    emit("message", `${newLayerName.value}を作成しました。`);
    newLayerName.value = "";
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const status = axiosError.response.status;
        switch (status) {
          case 400:
            emit("message", `${axiosError.response.data}`);
            console.error("Add Layer Error.", axiosError.response.data);
            break;
          case 401:
            console.error("No token provided.", axiosError.response.data);
            emit("loginRedirect");
            break;
          case 500:
            console.error("Server error, please try again later", axiosError.response.data);
            break;
          default:
            console.error(`An error occurred: ${status}`, axiosError.response.data);
        }
      }
    }
  }
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="!tilesSaving && emit('close')">
    <div class="layer-create-content">
      <h2 class="modal-h2">新規レイヤ作成</h2>
      <div class="layer-type" role="radiogroup" aria-label="レイヤの種類">
        <label
          ><input
            type="radio"
            :disabled="tilesSaving"
            v-model="mode"
            value="group"
          />レイヤ（グループ）</label
        >
        <label
          ><input
            type="radio"
            :disabled="tilesSaving"
            v-model="mode"
            value="tiles"
          />重ね合わせタイル</label
        >
      </div>
      <div v-if="mode === 'tiles'">
        <TileOverlayChoices
          v-if="isOpen"
          @busy="tilesSaving = $event"
          @changed="emit('tilesChanged', $event)"
          @loginRedirect="emit('loginRedirect')"
        />
        <button
          class="tile-close-button"
          type="button"
          :disabled="tilesSaving"
          @click="emit('close')"
        >
          閉じる
        </button>
      </div>
      <div v-else class="setting-contents">
        <div class="input-zone">
          <input
            type="text"
            maxlength="15"
            title="設定できるレイヤ名は15文字以内です。"
            placeholder="レイヤ名称（15字以内）"
            class="input-textbox"
            required
            v-model="newLayerName"
          />
        </div>
        <div class="btn-zone">
          <button @click="emit('close')">閉じる</button>
          <button @click="layerAdd()">追加</button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.tile-close-button {
  margin-top: 20px;
}
.layer-type {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin: 16px 0;
}
.layer-type label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.layer-create-content {
  width: 45vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.setting-contents {
  text-align: center;
}

.input-textbox {
  font-size: 24px;
  width: 90%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

@media (orientation: portrait) {
  .layer-create-content {
    box-sizing: border-box;
    width: min(calc(100vw - 64px), 680px);
  }

  .btn-zone {
    flex-wrap: wrap;
    gap: 12px;
  }
}
</style>
