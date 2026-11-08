<script setup lang="ts">
import "./desktop-data-modal.css";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import apiClient from "@/axiosClient";
import type { MapObjectData, ShapeData } from "@/interface";
import { answerDateLabel, type FormAnswer } from "@/utils/answer-presentation";
import type { FormBody } from "@/utils/form-body";

const props = defineProps<{ answer: FormAnswer | null; session: number }>();
const emit = defineEmits<{ close: []; deleted: [session: number]; busy: [value: boolean] }>();
const body = shallowRef<FormBody | null>(null);
const loading = ref(false),
  saving = ref(false),
  conflict = ref(false),
  completed = ref(false),
  message = ref("");
const freeText = ref(""),
  confirmed = ref(false);
let generation = 0;
let disposed = false;
let controller: AbortController | undefined;
const revisionValid = computed(
  () => Number.isSafeInteger(props.answer?.revision) && (props.answer?.revision ?? 0) > 0,
);
const canDelete = computed(
  () =>
    !!props.answer &&
    revisionValid.value &&
    !!body.value &&
    !loading.value &&
    !saving.value &&
    !conflict.value &&
    !completed.value &&
    (!body.value.sync_required || confirmed.value),
);
const errorText = (error: unknown, fallback: string) => {
  if (apiClient.isAxiosError(error)) {
    if (error.response?.status === 409)
      return "登録または本文・メモが他で更新されました。閉じて一覧を再検索し、削除内容を確認してください。";
    if (error.response?.status === 404)
      return "登録または対象が見つかりません。閉じて一覧を再検索してください。";
    return (
      (error.response?.data as { error?: string })?.error?.replace(/^validation error:\s*/, "") ||
      fallback
    );
  }
  return fallback;
};
const load = async () => {
  const answer = props.answer;
  if (!answer || saving.value || disposed) return;
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  body.value = null;
  freeText.value = "";
  confirmed.value = false;
  conflict.value = false;
  message.value = "";
  if (!revisionValid.value) {
    loading.value = false;
    message.value = "登録の更新情報がありません。閉じて一覧を再検索してください。";
    return;
  }
  loading.value = true;
  try {
    const data = (
      await apiClient.get<FormBody>(`/${answer.target_type}/${answer.target_id}/form/body`, {
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal,
      })
    ).data;
    if (current !== generation || !props.answer) return;
    if (
      typeof data?.sync_required !== "boolean" ||
      (data.sync_required && typeof data.body_token !== "string")
    )
      throw new Error("本文・メモの応答が不正です。");
    body.value = data;
  } catch (error) {
    if (current === generation)
      message.value = errorText(error, "削除内容を確認できませんでした。再読み込みしてください。");
  } finally {
    if (current === generation) loading.value = false;
  }
};
watch(
  () => [props.answer?.id, props.answer?.target_type, props.answer?.target_id, props.session],
  () => {
    ++generation;
    controller?.abort();
    body.value = null;
    loading.value = false;
    message.value = "";
    conflict.value = false;
    completed.value = false;
    if (props.answer) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  ++generation;
  controller?.abort();
});
const close = () => {
  if (!saving.value) emit("close");
};
const remove = async () => {
  if (!canDelete.value || !props.answer || !body.value) return;
  const answer = props.answer,
    session = props.session,
    current = generation;
  const request = {
    revision: answer.revision,
    ...(body.value.sync_required
      ? { reconcile: { free_text: freeText.value, token: body.value.body_token } }
      : {}),
  };
  saving.value = true;
  emit("busy", true);
  message.value = "";
  try {
    const data = (
      await apiClient.delete<{ message: string; object: MapObjectData | ShapeData }>(
        `/form-answers/${answer.target_type}/${answer.id}`,
        { data: request },
      )
    ).data;
    if (current === generation) completed.value = true;
    // 送信後に一覧を閉じても、確定した削除を地図と親の編集画面へ反映する。
    window.dispatchEvent(new CustomEvent("geocode-answer-updated", { detail: data.object }));
    emit("deleted", session);
  } catch (error) {
    if (current === generation) {
      conflict.value =
        apiClient.isAxiosError(error) && [404, 409].includes(error.response?.status || 0);
      message.value = errorText(error, "削除できませんでした。内容を確認して再試行してください。");
    }
  } finally {
    saving.value = false;
    emit("busy", false);
    // 別の登録へ切り替わった場合は、古い本文を確認画面に残さない。
    if (!disposed && current !== generation && props.answer && !body.value) void load();
  }
};
</script>

<template>
  <BaseModal
    class="desktop-data-modal answer-delete-overlay"
    :isOpen="!!answer"
    :zIndex="50"
    :closeOnOverlayClick="false"
  >
    <section
      v-if="answer"
      class="answer-delete-modal desktop-data-panel"
      role="dialog"
      aria-modal="true"
      aria-label="フォーム登録の削除"
      :aria-busy="loading || saving"
    >
      <header class="desktop-data-header">
        <h2>フォーム登録の削除</h2>
        <button type="button" class="answer-delete-close" :disabled="saving" @click="close">
          閉じる
        </button>
      </header>
      <div class="desktop-data-body">
        <p>この登録を削除しますか？削除した登録は元に戻せません。</p>
        <dl class="answer-delete-target">
          <dt>対象</dt>
          <dd>
            {{ answer.target_type === "marker" ? "マーカー" : "図形" }}：{{ answer.target_name }}
          </dd>
          <dt>投稿日時</dt>
          <dd>{{ answerDateLabel(answer.create_at) }}</dd>
          <dt>フォーム</dt>
          <dd>
            {{ answer.common_form_name || answer.form_snapshot?.form_title || "個別フォーム" }}
          </dd>
        </dl>
        <p>
          この登録と、本文・メモに反映された登録内容を削除します。地図オブジェクトと他の登録は残ります。
        </p>
        <p v-if="loading" role="status">削除内容を確認しています…</p>
        <p v-if="message" class="answer-delete-error" role="alert">{{ message }}</p>
        <button
          v-if="!loading && !body && !conflict && revisionValid"
          type="button"
          :disabled="saving"
          @click="load"
        >
          再読み込み
        </button>
        <section v-if="body?.sync_required" class="answer-delete-reconcile">
          <p>
            本文・メモと登録の対応を自動判定できません。自由記述として残す内容を確認してください。他の登録部分は投稿順で再構成します。
          </p>
          <details>
            <summary>現在の本文・メモ</summary>
            <pre>{{ body.body }}</pre>
          </details>
          <label class="answer-delete-text-label"
            >自由記述として残す内容<textarea
              v-model="freeText"
              class="answer-delete-free-text"
              :disabled="saving || conflict"
            />
          </label>
          <details>
            <summary>現在のフォーム登録部分（選択した登録は削除時に除外）</summary>
            <pre>{{ body.managed_markdown }}</pre>
          </details>
          <label class="answer-delete-check"
            ><input
              v-model="confirmed"
              class="answer-delete-reconcile-confirm"
              type="checkbox"
              :disabled="saving || conflict"
            /><span>自由記述として残す内容と削除対象を確認しました</span></label
          >
        </section>
      </div>
      <footer class="desktop-data-footer">
        <p v-if="saving" role="status">削除しています…</p>
        <button type="button" class="answer-delete-submit" :disabled="!canDelete" @click="remove">
          削除
        </button>
      </footer>
    </section>
  </BaseModal>
</template>

<style scoped>
.answer-delete-overlay {
  --desktop-modal-width: 640px;
}
.answer-delete-modal {
  height: auto;
}
.answer-delete-modal button {
  flex: 0 0 auto;
  border: 1px solid #aeb9c8;
  border-radius: 8px;
  padding: 8px 14px;
  min-height: 40px;
  background: white;
  color: #172033;
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}
.answer-delete-modal button:disabled {
  opacity: 0.5;
  cursor: default;
}
.answer-delete-modal .answer-delete-close {
  border-color: transparent;
  padding: 0.6em 1.2em;
  background: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font-weight: 500;
  transition: border-color 0.25s;
}
.answer-delete-modal .answer-delete-close:hover:not(:disabled) {
  border-color: #396cd8;
}
.answer-delete-modal .answer-delete-close:active:not(:disabled) {
  border-color: #396cd8;
  background: #e8e8e8;
}
.answer-delete-modal .answer-delete-submit {
  background: #b42318;
  border-color: #b42318;
  color: white;
}
.answer-delete-target {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 16px;
  padding: 12px;
  border: 1px solid #dde3ec;
  border-radius: 8px;
  background: #f5f7fb;
}
.answer-delete-target dt {
  font-weight: 600;
}
.answer-delete-target dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.answer-delete-error {
  color: #b42318;
}
.answer-delete-reconcile {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid #d9b777;
  border-radius: 8px;
  background: #fff9eb;
}
.answer-delete-reconcile details {
  margin: 12px 0;
}
.answer-delete-reconcile pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
.answer-delete-text-label {
  display: block;
}
.answer-delete-free-text {
  display: block;
  width: 100%;
  min-height: 140px;
  max-width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 10px;
  font: inherit;
  resize: vertical;
}
.answer-delete-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.answer-delete-check input {
  flex: 0 0 auto;
  margin-top: 5px;
}
@media (max-width: 480px) {
  .answer-delete-target {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .answer-delete-target dd {
    margin-bottom: 8px;
  }
}
</style>
