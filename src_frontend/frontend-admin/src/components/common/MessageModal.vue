<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{ isOpen: boolean; message: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <BaseModal
    :is-open="isOpen"
    title-id="message-modal-title"
    overlay-id="overlay-message"
    content-id="content-message"
    @close="emit('close')"
  >
    <h2 id="message-modal-title" class="modal-title">メッセージ</h2>
    <p class="message-text" aria-live="polite">
      <strong>{{ message }}</strong>
    </p>
    <div class="button-row">
      <button type="button" class="btn-modal-yes" @click="emit('close')">閉じる</button>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-title {
  margin-bottom: 18px;
  padding-bottom: 10px;
  border-bottom: 2px solid #acacac;
  font-size: 1.35rem;
  text-align: center;
}

.message-text {
  margin: 0 0 24px;
  overflow-wrap: anywhere;
  text-align: center;
}
</style>
