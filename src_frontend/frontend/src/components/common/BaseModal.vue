<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    zIndex?: number;
    closeOnOverlayClick?: boolean; // モーダルオーバーレイのクリックでモーダルを閉じるかどうか
  }>(),
  {
    closeOnOverlayClick: true,
  },
);

const emit = defineEmits<{
  close: [];
}>();

const handleOverlayClick = () => {
  if (props.closeOnOverlayClick) emit("close");
};
</script>

<template>
  <div
    v-show="isOpen"
    class="base-modal-overlay"
    :style="{ zIndex: zIndex ?? 1 }"
    @click.self="handleOverlayClick"
  >
    <div class="base-modal-content" @click.stop>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.base-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.base-modal-content {
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}
</style>
