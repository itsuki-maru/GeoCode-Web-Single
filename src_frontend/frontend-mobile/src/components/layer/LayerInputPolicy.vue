<script setup lang="ts">
import { computed, ref } from "vue";
import apiClient from "@/axiosClient";
import { useLayersStore } from "@/stores/layers";
import MessageModal from "@/components/common/MessageModal.vue";

const props = defineProps<{ layerId: string; disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const store = useLayersStore();
const saving = ref(false),
  message = ref("");
const restricted = computed(() => !!store.layersList.get(props.layerId)?.restrict_free_text);
const changePolicy = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const value = input.checked,
    id = props.layerId;
  input.checked = restricted.value;
  if (saving.value || props.disabled) return;
  saving.value = true;
  emit("busy", true);
  try {
    await apiClient.put(`/layer/${id}/input-policy`, { restrict_free_text: value });
    const layer = store.layersList.get(id);
    if (layer) store.layersList.set(id, { ...layer, restrict_free_text: value });
    message.value = value
      ? "マーカー内容・図形メモ作成の自由記述を制限しました。"
      : "マーカー内容・図形メモの自由記述を許可しました。";
  } catch {
    message.value = "自由記述の設定を変更できませんでした。";
  } finally {
    input.checked = restricted.value;
    saving.value = false;
    emit("busy", false);
  }
};
</script>

<template>
  <div class="input-policy">
    <label>
      <input
        type="checkbox"
        :checked="restricted"
        :disabled="disabled || saving"
        @change="changePolicy"
      />
      内容やメモの自由記述を制限する
    </label>
    <p>この項目は切り替えるとすぐに保存されます。</p>
    <p v-if="restricted">
      本文・メモはフォームから登録してください。名前・所属レイヤの変更と、地図上での図形の頂点編集は可能です。
    </p>
  </div>
  <MessageModal v-if="message" :isOpen="true" :message="message" @close="message = ''" />
</template>

<style scoped>
.input-policy {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid #d5dce8;
  border-radius: 10px;
  text-align: left;
}
label {
  display: flex;
  align-items: center;
  gap: 8px;
}
input {
  flex-shrink: 0;
}
p {
  font-size: 13px;
  margin: 8px 0 0;
}
</style>
