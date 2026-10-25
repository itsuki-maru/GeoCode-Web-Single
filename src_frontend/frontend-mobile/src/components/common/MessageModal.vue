<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    message: string;
    confirmLabel?: string;
    zIndex?: number;
    busy?: boolean;
  }>(),
  { zIndex: 30, busy: false },
);

const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<template>
  <BaseModal
    :isOpen="isOpen"
    :zIndex="zIndex"
    :closeOnOverlayClick="!busy"
    @close="!props.busy && emit('close')"
  >
    <h2 class="modal-h2">メッセージ</h2>
    <div class="input-text-zone">
      <p>
        <strong>{{ message }}</strong>
      </p>
    </div>
    <div class="btn-close">
      <button :disabled="busy" @click="emit('close')">閉じる</button>
      <button v-if="confirmLabel" type="button" :disabled="busy" @click="emit('confirm')">
        {{ confirmLabel }}
      </button>
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
