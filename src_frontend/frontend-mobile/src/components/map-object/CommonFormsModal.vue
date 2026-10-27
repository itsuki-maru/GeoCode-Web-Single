<script setup lang="ts">
import "./form-modal-buttons.css";
import { ref, watch } from "vue";
import MessageModal from "@/components/common/MessageModal.vue";
import BaseModal from "@/components/common/BaseModal.vue";
import FormAnswersModal from "./FormAnswersModal.vue";
import MapObjectFormSettingsModal from "./MapObjectFormSettingsModal.vue";
import apiClient from "@/axiosClient";
const props = defineProps<{ isOpen: boolean }>();
const emit = defineEmits<{ close: [] }>();
const tab = ref<"create" | "list">("create");
const forms = ref<{ id: string; version: number; form_title: string; form_description: string }[]>(
  [],
);
const loading = ref(false);
const busy = ref(false);
const message = ref("");
const editorOpen = ref(false);
const editingId = ref("");
const deletingId = ref("");
const answersOpen = ref(false);
const answersFormId = ref("");
const openAnswers = (id = "") => {
  answersFormId.value = id;
  answersOpen.value = true;
};
const load = async () => {
  loading.value = true;
  message.value = "";
  try {
    forms.value = (await apiClient.get("/common-forms")).data;
  } catch {
    message.value = "一覧を読み込めませんでした。再読み込みしてください。";
  } finally {
    loading.value = false;
  }
};
watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      tab.value = "create";
      editorOpen.value = false;
      deletingId.value = "";
      answersOpen.value = false;
      void load();
    }
  },
);
const edit = (id = "") => {
  editingId.value = id;
  editorOpen.value = true;
};
const remove = async () => {
  const id = deletingId.value;
  if (!id || busy.value) return;
  deletingId.value = "";
  busy.value = true;
  try {
    await apiClient.delete(`/common-forms/${id}`);
    await load();
    message.value = "削除しました。";
  } catch {
    message.value = "削除できませんでした。";
  } finally {
    busy.value = false;
  }
};
const saved = async () => {
  editorOpen.value = false;
  tab.value = "list";
  await load();
  message.value = "共通フォームを保存しました。";
};
</script>
<template>
  <BaseModal :isOpen="isOpen && !editorOpen" :zIndex="20" @close="emit('close')">
    <div class="common-forms">
      <header>
        <h2 class="modal-h2">共通フォーム</h2>
        <button type="button" class="close-button btn-close" @click="emit('close')">閉じる</button>
      </header>
      <div class="layer-type" role="radiogroup" aria-label="共通フォームの操作">
        <label><input v-model="tab" type="radio" value="create" />作成</label>
        <label><input v-model="tab" type="radio" value="list" />一覧</label>
      </div>
      <p v-if="message" role="status">{{ message }}</p>
      <section v-if="tab === 'create'">
        <p class="create-description">再利用・分析用のフォーム作成と回答履歴の一覧</p>
        <div class="create-actions">
          <button class="btn-close" @click="edit()">共通フォームを作成</button>
          <button type="button" class="btn-close" @click="openAnswers()">回答一覧と分析</button>
        </div>
      </section>
      <section v-else class="form-list-section">
        <button class="btn-close" :disabled="loading || busy" @click="load">再読み込み</button>
        <p v-if="loading">読み込み中…</p>
        <p v-else-if="!forms.length">共通フォームはありません。</p>
        <div class="form-list">
          <article v-for="form in forms" :key="form.id">
            <strong>{{ form.form_title }}</strong
            ><span>第{{ form.version }}版</span>
            <p>{{ form.form_description }}</p>
            <button class="btn-close" type="button" :disabled="busy" @click="openAnswers(form.id)">
              回答一覧
            </button>
            <button class="btn-close" :disabled="busy" @click="edit(form.id)">編集</button>
            <button class="btn-close" :disabled="busy" @click="deletingId = form.id">削除</button>
          </article>
        </div>
      </section>
    </div>
  </BaseModal>
  <MessageModal
    class="common-form-confirm"
    :isOpen="isOpen && !!deletingId"
    message="共通フォームを削除しますか？適用済みのフォームと回答履歴は残ります。"
    confirmLabel="削除"
    @close="deletingId = ''"
    @confirm="remove"
  />
  <MapObjectFormSettingsModal
    :isOpen="isOpen && editorOpen"
    targetType="marker"
    targetId=""
    commonMode
    :commonId="editingId"
    @close="editorOpen = false"
    @saved="saved"
    @message="(text) => (message = text)"
  />
  <FormAnswersModal
    v-if="isOpen && answersOpen"
    :isOpen="isOpen && answersOpen"
    :initialFormId="answersFormId"
    @close="answersOpen = false"
  />
</template>
<style scoped>
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}
.create-description {
  text-align: center;
}
.create-actions {
  display: flex;
  justify-content: center;
  align-items: stretch;
  flex-wrap: nowrap;
  gap: 12px;
}
.common-forms .create-actions .btn-close {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0.6em 0.5em;
  min-height: 40px;
  font-size: clamp(12px, 3.8vw, 15px);
  white-space: nowrap;
}

.common-forms {
  width: min(720px, calc(100vw - 64px));
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  padding: 8px;
}
header {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}
.modal-h2 {
  width: 100%;
  box-sizing: border-box;
  grid-column: 1;
  grid-row: 1;
  margin: 0;
  padding-bottom: 12px;
}
header > .close-button {
  position: relative;
  top: -8px;
  grid-column: 1;
  grid-row: 1;
  justify-self: end;
}
@media (max-width: 480px) {
  header {
    gap: 8px;
  }
  .modal-h2 {
    grid-row: 2;
  }
}
.layer-type {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 32px;
  margin: 16px 0;
  flex-shrink: 0;
}
.layer-type label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.form-list-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.form-list-section > button {
  align-self: flex-start;
  flex-shrink: 0;
}
.form-list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
header,
[role="status"] {
  flex-shrink: 0;
}
button {
  padding: 9px 12px;
  margin: 4px;
  border: 1px solid #aeb9c8;
  border-radius: 8px;
  background: white;
  color: #172033;
  cursor: pointer;
}
.close-button {
  align-self: flex-start;
  flex-shrink: 0;
  border: 1px solid transparent;
  padding: 0.4em 0.8em;
  background-color: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  transition: border-color 0.25s;
}
.close-button:hover {
  border-color: #396cd8;
}
.close-button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}
article {
  border: 1px solid #ccd5e1;
  border-radius: 10px;
  margin-top: 12px;
  padding: 12px;
  overflow-wrap: anywhere;
}
span {
  margin-left: 12px;
}
</style>
