<script setup lang="ts">
import { ref, watch } from "vue";
import LayerCommonFormSetting from "./LayerCommonFormSetting.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import apiClient from "@/axiosClient";
import BaseModal from "@/components/common/BaseModal.vue";
import MarkerIconPicker from "@/components/layer/MarkerIconPicker.vue";
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
const selectedIconId = ref<string | null>(null);
const formSetting = ref<InstanceType<typeof LayerCommonFormSetting> | null>(null);
const saving = ref(false),
  formLoading = ref(false),
  confirmOpen = ref(false),
  confirmMessage = ref("");
let pending: Record<string, unknown> = {};

watch(
  () => [props.currentName, props.layerId, props.isOpen],
  () => {
    confirmOpen.value = false;
    editLayerName.value = props.currentName;
    selectedIconId.value = layersStore.layersList.get(props.layerId)?.marker_icon_id ?? null;
  },
  { immediate: true },
);

const layerNameChange = async (): Promise<void> => {
  if (editLayerName.value === "") {
    emit("message", "レイヤ名が入力されていません。");
    return;
  }
  try {
    const change = formSetting.value?.getChange();
    if (change) {
      pending = change.payload;
      confirmMessage.value = change.message;
      confirmOpen.value = true;
      return;
    }
    await saveLayer({});
  } catch (error) {
    emit("message", error instanceof Error ? error.message : "設定を確認してください。");
  }
};
const saveLayer = async (formPayload: Record<string, unknown>) => {
  if (saving.value) return;
  saving.value = true;
  const savedLayerId = props.layerId,
    savedName = editLayerName.value;
  confirmOpen.value = false;
  try {
    await apiClient.put(`/layer/update/${savedLayerId}`, {
      name: savedName,
      marker_icon_id: selectedIconId.value,
      update_marker_icon: true,
      ...formPayload,
    });
    const refreshed = await layersStore.initList();

    if (props.isOpen && props.layerId === savedLayerId) emit("close");
    emit(
      "message",
      refreshed
        ? "レイヤ設定を変更しました。"
        : "設定は保存しました。画面を再読み込みしてください。",
    );
  } catch (error) {
    emit(
      "message",
      apiClient.isAxiosError(error) && error.response?.status === 409
        ? "対象件数またはフォームが更新されました。設定を開き直してください。"
        : "レイヤ設定を変更できませんでした。",
    );
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :closeOnOverlayClick="!saving" @close="emit('close')">
    <div class="rename-content" :inert="saving">
      <h2 class="modal-h2">レイヤ設定</h2>
      <div class="setting-contents" :inert="saving">
        <div class="name-setting">
          <label for="layer-name">レイヤ名</label>
          <input
            id="layer-name"
            type="text"
            maxlength="15"
            title="設定できるレイヤ名は15文字以内です。"
            placeholder="レイヤ名称（15字以内）"
            class="input-textbox"
            required
            v-model="editLayerName"
            :disabled="masterLayerId === layerId"
          />
        </div>
        <LayerCommonFormSetting
          ref="formSetting"
          :layerId="layerId"
          :isOpen="isOpen"
          :disabled="saving"
          @busy="formLoading = $event"
        />

        <MarkerIconPicker v-model="selectedIconId" @message="emit('message', $event)" />
        <div class="btn-zone">
          <button :disabled="saving" @click="emit('close')">閉じる</button>
          <button :disabled="saving || formLoading" @click="layerNameChange()">変更</button>
        </div>
      </div>
    </div>
  </BaseModal>
  <MessageModal
    :isOpen="isOpen && confirmOpen"
    :message="confirmMessage"
    confirmLabel="変更する"
    @close="confirmOpen = false"
    @confirm="saveLayer(pending)"
  />
</template>

<style scoped>
.rename-content {
  width: min(72vw, 820px);
  max-height: 85vh;
  overflow-y: auto;
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
