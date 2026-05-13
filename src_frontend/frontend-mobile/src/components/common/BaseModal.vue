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
  <transition>
    <div
      v-show="isOpen"
      class="base-modal-overlay"
      :style="{ zIndex: zIndex ?? 10 }"
      @click.self="handleOverlayClick"
    >
      <div class="base-modal-content" :style="{ zIndex: (zIndex ?? 10) + 1 }" @click.stop>
        <slot />
      </div>
    </div>
  </transition>
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
  width: 90%;
  padding: 1em;
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
