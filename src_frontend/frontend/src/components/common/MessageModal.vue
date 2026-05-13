<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{
  isOpen: boolean;
  message: string;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="19" @close="emit('close')">
    <div class="message-modal-content">
      <h2 class="modal-h2">メッセージ</h2>
      <div class="input-text-zone">
        <p>
          <strong>{{ message }}</strong>
        </p>
      </div>
      <div class="message-btn-close">
        <button @click="emit('close')">閉じる</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.message-modal-content {
  width: 30vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.input-text-zone {
  text-align: center;
}

.message-btn-close {
  text-align: center;
}
</style>
