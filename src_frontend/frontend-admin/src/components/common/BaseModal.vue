<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";

const openModalIds: symbol[] = [];

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    titleId: string;
    overlayId?: string;
    contentId?: string;
    closeOnOverlayClick?: boolean;
  }>(),
  {
    overlayId: undefined,
    contentId: undefined,
    closeOnOverlayClick: true,
  },
);

const emit = defineEmits<{ close: [] }>();
const modalId = Symbol("admin-modal");
let ownsScrollLock = false;

const updateScrollLock = (isOpen: boolean) => {
  if (isOpen === ownsScrollLock) return;
  ownsScrollLock = isOpen;
  if (isOpen) {
    openModalIds.push(modalId);
  } else {
    const modalIndex = openModalIds.indexOf(modalId);
    if (modalIndex >= 0) openModalIds.splice(modalIndex, 1);
  }
  document.body.style.overflow = openModalIds.length > 0 ? "hidden" : "";
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape" && props.isOpen && openModalIds[openModalIds.length - 1] === modalId) {
    emit("close");
  }
};

watch(() => props.isOpen, updateScrollLock, { immediate: true });

onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
  updateScrollLock(false);
});
</script>

<template>
  <div
    v-show="isOpen"
    :id="overlayId"
    class="base-modal-overlay"
    @click.self="closeOnOverlayClick && emit('close')"
  >
    <section
      :id="contentId"
      class="base-modal-content"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <slot />
    </section>
  </div>
</template>

<style scoped>
.base-modal-overlay {
  z-index: 30;
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
}

.base-modal-content {
  width: min(100%, 520px);
  max-height: calc(100dvh - 48px);
  overflow-y: auto;
  padding: 24px;
  border: 1px solid var(--admin-border);
  border-radius: 14px;
  background: var(--admin-surface);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24);
}

@media (max-width: 600px) {
  .base-modal-overlay {
    align-items: flex-end;
    padding: 12px;
  }

  .base-modal-content {
    width: 100%;
    max-height: calc(100dvh - 24px);
    padding: 20px;
  }
}
</style>
