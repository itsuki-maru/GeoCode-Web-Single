<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

withDefaults(
  defineProps<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }>(),
  { confirmLabel: "実行", danger: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <BaseModal
    :is-open="isOpen"
    title-id="confirm-modal-title"
    :close-on-overlay-click="false"
    @close="emit('cancel')"
  >
    <h2 id="confirm-modal-title" class="modal-title">{{ title }}</h2>
    <p class="confirm-message">
      <strong>{{ message }}</strong>
    </p>
    <div class="button-row">
      <button type="button" class="button-secondary" @click="emit('cancel')">やめる</button>
      <button
        type="button"
        :class="danger ? 'button-danger' : 'button-primary'"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-title {
  margin-bottom: 12px;
  font-size: 1.35rem;
  text-align: center;
}

.confirm-message {
  margin-bottom: 24px;
  color: var(--admin-text-muted);
  text-align: center;
}
</style>
