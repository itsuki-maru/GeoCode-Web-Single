<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";
import MarkerIconPicker from "@/components/layer/MarkerIconPicker.vue";

const props = defineProps<{
  isOpen: boolean;
  layerId: string;
  currentName: string;
}>();

const emit = defineEmits<{
  close: [];
  renamed: [id: string, newName: string];
  message: [text: string];
}>();

const layersStore = useLayersStore();
const editName = ref("");
const selectedIconId = ref<string | null>(null);

watch(
  () => [props.currentName, props.layerId, props.isOpen],
  () => {
    editName.value = props.currentName;
    selectedIconId.value = layersStore.layersList.get(props.layerId)?.marker_icon_id ?? null;
  },
  { immediate: true },
);

const layerNameChange = async (): Promise<void> => {
  if (props.layerId === "" || editName.value === "") {
    emit("message", "レイヤ名が入力されていません。");
    return;
  }
  await layersStore.updateLayer(props.layerId, editName.value, selectedIconId.value);
  emit("renamed", props.layerId, editName.value);
  emit("message", "レイヤ設定を変更しました。");
  emit("close");
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <h2 class="modal-h2">レイヤ設定</h2>
    <div class="setting-contents">
      <div class="name-setting">
        <label for="layer-name-mobile">レイヤ名</label>
        <input
          id="layer-name-mobile"
          type="text"
          maxlength="15"
          title="設定できるレイヤ名は15文字以内です。"
          placeholder="レイヤ名称（15字以内）"
          class="input-textbox"
          required
          v-model="editName"
          :disabled="layersStore.layersList.get(layerId)?.is_master"
        />
      </div>
      <MarkerIconPicker v-model="selectedIconId" @message="emit('message', $event)" />
      <div class="btn-zone">
        <button @click="emit('close')" class="btn-standard">閉じる</button>
        <button @click="layerNameChange()" class="btn-standard btn-primary">変更</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
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

.btn-standard {
  min-width: 90px;
}

.btn-primary {
  background-color: #173e92;
}
.name-setting {
  padding: 14px 16px;
  border: 1px solid #d5dce8;
  border-radius: 14px;
  background: #f8fafc;
  text-align: left;
}

.name-setting label {
  display: block;
  margin-bottom: 7px;
  color: #39465d;
  font-size: 13px;
  font-weight: 700;
}

.name-setting .input-textbox {
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  font-size: 18px;
}
</style>
