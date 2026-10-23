<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import apiClient from "@/axiosClient";
interface LayerForm {
  common_form_id: string | null;
  common_form_version: number | null;
  revision: number;
  marker_count: number;
  shape_count: number;
}
interface Common {
  id: string;
  version: number;
  form_title: string;
  is_password_protected: boolean;
}
const props = defineProps<{ layerId: string; isOpen: boolean; disabled?: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const forms = ref<Common[]>([]),
  binding = ref<LayerForm | null>(null),
  selected = ref(""),
  error = ref("");
let sequence = 0,
  controller: AbortController | undefined;
const load = async () => {
  const seq = ++sequence;
  controller?.abort();
  binding.value = null;
  error.value = "";
  selected.value = "";
  if (!props.isOpen || !props.layerId) {
    emit("busy", false);
    return;
  }
  controller = new AbortController();
  emit("busy", true);
  try {
    const [current, list] = await Promise.all([
      apiClient.get<LayerForm>(`/layer/${props.layerId}/form`, { signal: controller.signal }),
      apiClient.get<Common[]>("/common-forms", { signal: controller.signal }),
    ]);
    if (seq !== sequence) return;
    binding.value = current.data;
    forms.value = list.data;
    selected.value = current.data.common_form_id || "";
  } catch {
    if (seq === sequence)
      error.value = "フォーム設定を取得できませんでした。閉じてから開き直してください。";
  } finally {
    if (seq === sequence) emit("busy", false);
  }
};
watch(() => [props.layerId, props.isOpen] as const, load, { immediate: true });
onBeforeUnmount(() => {
  ++sequence;
  controller?.abort();
});
const getChange = () => {
  if (!binding.value) return null; // 読み込めない場合も名前・アイコンだけの従来更新は維持する。
  if (selected.value === (binding.value.common_form_id || "")) return null;
  const form = forms.value.find((f) => f.id === selected.value);
  if (selected.value && !form) throw Error("共通フォームを選び直してください。");
  const count = binding.value.marker_count + binding.value.shape_count;
  return {
    payload: {
      update_common_form: true,
      common_form_id: form?.id || null,
      common_form_version: form?.version || null,
      form_binding_revision: binding.value.revision,
      form_target_count: count,
    },
    message: form
      ? `このレイヤのマーカー${binding.value.marker_count}件・図形${binding.value.shape_count}件のフォームを「${form.form_title}」に置き換えます。パスワードも共通フォームの設定（${form.is_password_protected ? "設定済み" : "未設定"}）に揃います。今後の作成・項目変更も自動反映します。回答履歴・本文・画像は残ります。変更しますか？`
      : `このレイヤの${count}件のフォーム設定を解除し、公開URLを無効にします。回答履歴・本文・画像は残ります。解除前の個別設定は復元されません。変更しますか？`,
  };
};
defineExpose({ getChange });
</script>
<template>
  <section class="layer-common-form">
    <label
      >共通フォームを設定<select
        v-model="selected"
        :disabled="disabled || !binding"
        aria-label="レイヤの共通フォーム"
      >
        <option value="">未設定</option>
        <option v-for="f in forms" :key="f.id" :value="f.id">
          {{ f.form_title }}（第{{ f.version }}版）
        </option>
      </select></label
    >
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!binding">読み込んでいます…</p>
    <p v-else>
      マーカー{{ binding.marker_count }}件・図形{{
        binding.shape_count
      }}件。設定すると既存・新規の対象に適用し、共通フォームの項目変更を自動反映します。
    </p>
  </section>
</template>
<style scoped>
.layer-common-form {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid #d5dce8;
  border-radius: 14px;
  background: #f8fafc;
  text-align: left;
}
.layer-common-form label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-weight: 700;
}
.layer-common-form select {
  width: 100%;
  min-width: 0;
  padding: 10px;
  box-sizing: border-box;
  font: inherit;
}
.layer-common-form p {
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
