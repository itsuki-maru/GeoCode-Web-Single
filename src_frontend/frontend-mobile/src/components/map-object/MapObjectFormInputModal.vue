<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import apiClient from "@/axiosClient";
import { resizeImage } from "@/utils/form-image-resize";
import type { MapObjectData, ShapeData } from "@/interface";
interface Field {
  id: string;
  label: string;
  type: string;
  required: boolean;
  max_length: number | null;
  choices: string[];
}
interface InputConfig {
  form_title: string;
  form_description: string;
  form_schema: { fields: Field[] };
  config_token: string;
  values: Record<string, unknown>;
}
const formId = `owner-form-input-${Math.random().toString(36).slice(2)}`;
const props = defineProps<{ isOpen: boolean; targetType: "marker" | "shape"; targetId: string }>();
const emit = defineEmits<{ close: []; saved: [object: MapObjectData | ShapeData] }>();
const config = ref<InputConfig | null>(null),
  values = ref<Record<string, string | boolean>>({});
const images = new Map<string, { blob: Blob; name: string }>();
const imageStatus = ref<Record<string, string>>({});
const preparing = ref(0),
  loading = ref(false),
  saving = ref(false),
  message = ref(""),
  conflict = ref(false);
let generation = 0,
  controller: AbortController | undefined;
const imageVersions = new Map<string, number>();
const endpoint = () => `/${props.targetType}/${props.targetId}/form`;
const errorText = (error: unknown, fallback: string) => {
  if (apiClient.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 409)
      return "フォームの設定が変更されました。再読み込みして入力内容を確認してください。";
    if (status === 404) return "対象またはフォームが見つかりません。編集画面を開き直してください。";
    return (
      (error.response?.data as { error?: string })?.error?.replace(/^validation error:\s*/, "") ||
      fallback
    );
  }
  return fallback;
};
const load = async () => {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  config.value = null;
  images.clear();
  imageVersions.clear();
  imageStatus.value = {};
  preparing.value = 0;
  message.value = "";
  conflict.value = false;
  loading.value = true;
  try {
    const data = (
      await apiClient.get<InputConfig>(endpoint() + "/input", { signal: controller.signal })
    ).data;
    if (current !== generation || !props.isOpen) return;
    config.value = data;
    values.value = Object.fromEntries(
      data.form_schema.fields.map((f) => {
        const v = data.values[f.id];
        return [f.id, f.type === "checkbox" ? v === true : v == null ? "" : String(v)];
      }),
    );
  } catch (error) {
    if (current === generation)
      message.value = errorText(error, "フォームを取得できませんでした。");
  } finally {
    if (current === generation) loading.value = false;
  }
};
watch(
  () => [props.isOpen, props.targetType, props.targetId] as const,
  () => {
    ++generation;
    controller?.abort();
    if (props.isOpen && props.targetId) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++generation;
  controller?.abort();
});
const prepareImage = async (field: Field, event: Event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  const current = generation,
    version = (imageVersions.get(field.id) || 0) + 1;
  imageVersions.set(field.id, version);
  images.delete(field.id);
  imageStatus.value[field.id] = "";
  if (!file) return;
  preparing.value++;
  imageStatus.value[field.id] = "画像を縮小しています…";
  try {
    const blob = await resizeImage(file);
    if (current === generation && imageVersions.get(field.id) === version) {
      images.set(field.id, { blob, name: file.name });
      imageStatus.value[field.id] = "準備完了";
    }
  } catch (error) {
    if (current === generation && imageVersions.get(field.id) === version) {
      input.value = "";
      imageStatus.value[field.id] =
        error instanceof Error ? error.message : "画像を処理できませんでした。";
    }
  } finally {
    if (current === generation) preparing.value--;
  }
};
const submit = async () => {
  if (saving.value || loading.value || preparing.value || conflict.value || !config.value) return;
  const current = generation;
  saving.value = true;
  message.value = "";
  const body = new FormData();
  const answers = Object.fromEntries(
    config.value.form_schema.fields
      .filter((f) => f.type !== "image")
      .map((f) => [f.id, values.value[f.id]]),
  );
  body.append(
    "submission",
    JSON.stringify({ config_token: config.value.config_token, values: answers }),
  );
  for (const [id, image] of images) body.append(`image__${id}`, image.blob, image.name);
  try {
    const data = (
      await apiClient.post<{ object: MapObjectData | ShapeData }>(endpoint() + "/submissions", body)
    ).data;
    if (current === generation && props.isOpen) emit("saved", data.object);
  } catch (error) {
    if (current === generation) {
      conflict.value = apiClient.isAxiosError(error) && error.response?.status === 409;
      message.value = errorText(
        error,
        "保存できませんでした。入力内容を確認して再試行してください。",
      );
    }
  } finally {
    if (current === generation) saving.value = false;
  }
};
</script>
<template>
  <BaseModal :isOpen="isOpen" :zIndex="20" :closeOnOverlayClick="false">
    <section
      class="form-input"
      role="dialog"
      aria-modal="true"
      aria-label="フォームで回答を登録"
      :aria-busy="saving || loading"
    >
      <h2>フォームで回答を登録</h2>
      <p class="intro">回答を分析用データとして保存し、本文・メモにも追記します。</p>
      <p v-if="loading" role="status">フォームを読み込んでいます…</p>
      <p v-if="message" class="error" role="alert">{{ message }}</p>
      <button
        v-if="!loading && (!config || conflict)"
        type="button"
        class="btn-close"
        :disabled="saving"
        @click="load"
      >
        再読み込み
      </button>
      <form v-if="config" :id="formId" @submit.prevent="submit">
        <h3>{{ config.form_title }}</h3>
        <p v-if="config.form_description" class="description">{{ config.form_description }}</p>
        <fieldset :disabled="saving || loading || conflict">
          <div v-for="f in config.form_schema.fields" :key="f.id" class="field">
            <label :for="`owner-form-${f.id}`"
              >{{ f.label }}<span v-if="f.required">（必須）</span></label
            >
            <textarea
              v-if="f.type === 'textarea'"
              :id="`owner-form-${f.id}`"
              v-model="values[f.id] as string"
              :required="f.required"
              :maxlength="f.max_length || 2000"
            />
            <select
              v-else-if="f.type === 'select'"
              :id="`owner-form-${f.id}`"
              v-model="values[f.id]"
              :required="f.required"
            >
              <option value="">選択してください</option>
              <option v-for="c in f.choices" :key="c" :value="c">{{ c }}</option>
            </select>
            <div
              v-else-if="f.type === 'radio'"
              :id="`owner-form-${f.id}`"
              role="radiogroup"
              :aria-label="f.label"
            >
              <label v-for="c in f.choices" :key="c" class="choice"
                ><input
                  v-model="values[f.id]"
                  type="radio"
                  :name="f.id"
                  :value="c"
                  :required="f.required"
                />{{ c }}</label
              ><button
                v-if="!f.required"
                type="button"
                class="btn-close"
                @click="values[f.id] = ''"
              >
                選択を解除
              </button>
            </div>
            <label v-else-if="f.type === 'checkbox'" class="choice"
              ><input
                :id="`owner-form-${f.id}`"
                v-model="values[f.id]"
                type="checkbox"
                :required="f.required"
              />はい</label
            >
            <template v-else-if="f.type === 'image'"
              ><input
                :id="`owner-form-${f.id}`"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                :required="f.required"
                @change="prepareImage(f, $event)"
              /><small>今回の回答に添付する画像を選択してください。過去の画像は保持されます。</small
              ><span role="status">{{ imageStatus[f.id] }}</span></template
            >
            <input
              v-else
              :id="`owner-form-${f.id}`"
              :value="values[f.id]"
              @input="values[f.id] = ($event.target as HTMLInputElement).value"
              :type="f.type"
              :required="f.required"
              :maxlength="f.max_length || 200"
              :step="f.type === 'number' ? 'any' : undefined"
            />
          </div>
        </fieldset>
      </form>
      <div class="actions">
        <button class="btn-close" type="button" :disabled="saving" @click="emit('close')">
          閉じる
        </button>
        <button
          v-if="config"
          class="btn-close btn-save"
          type="submit"
          :form="formId"
          :disabled="saving || loading || !!preparing || conflict"
        >
          {{ saving ? "保存中…" : "回答を保存" }}
        </button>
      </div>
    </section>
  </BaseModal>
</template>
<style scoped>
.form-input {
  width: min(600px, calc(100vw - 64px));
  max-height: calc(100dvh - 96px);
  overflow: auto;
  box-sizing: border-box;
  color: #222;
}
h2 {
  text-align: center;
  border-bottom: 1px solid #aaa;
  margin-top: 0;
}
.intro {
  text-align: center;
  font-size: 14px;
}
.description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.error {
  color: #a02020;
  white-space: pre-wrap;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 16px 0;
}
.field > label {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.field > input:not([type="checkbox"]),
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  min-height: 36px;
  font: inherit;
}
textarea {
  min-height: 100px;
  resize: vertical;
}
.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.actions {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
  gap: 12px;
  flex-wrap: nowrap;
}
.btn-close {
  background: #5f5f5f;
  color: white;
  border: 0;
  border-radius: 8px;
  padding: 10px 16px;
  font: inherit;
  cursor: pointer;
}
.btn-save {
  background: #179b7e;
}
.btn-close:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
