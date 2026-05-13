<script setup lang="ts">
defineProps<{
  isOpen: boolean;
  zIndex?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <transition>
    <div
      v-show="isOpen"
      class="image-preview-modal-overlay"
      :style="{ zIndex: zIndex ?? 10 }"
      @click.self="emit('close')"
    >
      <div class="image-pereview-modal-content" :style="{ zIndex: (zIndex ?? 10) + 1 }" @click.stop>
        <slot />
      </div>
    </div>
  </transition>
</template>

<style scoped>
.image-preview-modal-overlay {
  position: fixed;
  inset: 0; /* top/right/bottom/left を 0 に一括指定 */
  width: 100%;
  height: 100dvh; /* dvh = dynamic viewport height（モバイル対応） */
  background-color: rgba(0, 0, 0, 0.5);
}

.image-pereview-modal-content {
  width: 100%;
  padding: 0;
  background: whitesmoke;
  border-radius: 10px;
}

.v-enter-active,
.v-leave-active {
  transition: all 0.3s ease-in-out;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}
</style>
