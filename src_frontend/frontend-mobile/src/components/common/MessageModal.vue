<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{
  isOpen: boolean;
  message: string;
  confirmLabel?: string;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="30" @close="emit('close')">
    <h2 class="modal-h2">メッセージ</h2>
    <div class="input-text-zone">
      <p>
        <strong>{{ message }}</strong>
      </p>
    </div>
    <div class="btn-close">
      <button @click="emit('close')">閉じる</button>
      <button v-if="confirmLabel" type="button" @click="emit('confirm')">{{ confirmLabel }}</button>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.input-text-zone {
  text-align: center;
}

.btn-close {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 20px;
  text-align: center;
  align-items: center;
}
</style>
