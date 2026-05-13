<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { useLayersStore } from "@/stores/layers";

const props = defineProps<{
  isOpen: boolean;
  layerId: string;
  currentName: string;
  masterLayerId: string;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
}>();

const layersStore = useLayersStore();
const editLayerName = ref("");

watch(
  () => props.currentName,
  (name) => {
    editLayerName.value = name;
  },
);

const layerNameChange = (): void => {
  if (props.masterLayerId === props.layerId) {
    emit("message", "masterレイヤは名前を変更できません。");
    return;
  }
  if (editLayerName.value === "") {
    emit("message", "レイヤ名が入力されていません。");
    return;
  }
  layersStore.updateLayer(props.layerId, editLayerName.value);
  emit("close");
  emit("message", "レイヤ名を変更しました。");
};
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="rename-content">
      <h2 class="modal-h2">レイヤ名の変更（15字以内）</h2>
      <div class="setting-contents">
        <input
          type="text"
          maxlength="15"
          title="設定できるレイヤ名は15文字以内です。"
          placeholder="New Layer name"
          class="input-textbox"
          required
          v-model="editLayerName"
        />
        <div class="btn-zone">
          <button @click="emit('close')">閉じる</button>
          <button @click="layerNameChange()">変更</button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.rename-content {
  width: 45vw;
  text-align: center;
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
</style>
