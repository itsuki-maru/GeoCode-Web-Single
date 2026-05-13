<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{
  isOpen: boolean;
  title: string;
  message: string;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="15" @close="emit('cancel')">
    <h2 class="modal-h2">{{ title }}</h2>
    <div class="input-text-zone">
      <p><strong v-html="message"></strong></p>
    </div>
    <div class="btn-zone">
      <button @click="emit('cancel')" class="btn-standard">戻る</button>
      <button @click="emit('confirm')" class="btn-standard btn-delete">削除</button>
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

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

.btn-standard {
  min-width: 90px;
}

.btn-delete {
  background-color: #961414a6;
}
</style>
