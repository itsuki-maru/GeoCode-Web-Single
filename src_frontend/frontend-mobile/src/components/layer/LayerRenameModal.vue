<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";

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

watch(
  () => props.currentName,
  (val) => {
    editName.value = val;
  },
);

const layerNameChange = (): void => {
  if (props.layerId === "" || editName.value === "") {
    emit("message", "レイヤ名が入力されていません。");
    return;
  }
  layersStore.updateLayer(props.layerId, editName.value);
  emit("renamed", props.layerId, editName.value);
  emit("message", "レイヤ名を変更しました。");
  emit("close");
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <h2 class="modal-h2">レイヤ名の変更（15字以内）</h2>
    <div class="setting-contents">
      <input
        type="text"
        maxlength="15"
        title="設定できるレイヤ名は15文字以内です。"
        placeholder="New Layer name"
        class="input-textbox"
        required
        v-model="editName"
      />
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
</style>
