<script setup lang="ts">
defineProps<{
  isOpen: boolean;
  inline?: boolean;
}>();
</script>

<template>
  <div :class="inline ? 'progress-inline' : 'overlay-progress-bar'" v-show="isOpen">
    <svg class="spinner" width="50" height="50" view-box="0 0 50 50" aria-hidden="true">
      <g transform="rotate(-90 25 25)">
        <circle
          cx="25"
          cy="25"
          r="20"
          fill="none"
          stroke="#76c7c0"
          stroke-width="5"
          stroke-linecap="round"
          stroke-dasharray="31.4 31.4"
        />
      </g>
    </svg>
    <slot name="controls" />
  </div>
</template>

<style scoped>
.overlay-progress-bar {
  z-index: 12;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
}

.spinner {
  transform-origin: 50% 50%;
  transform-box: fill-box;
  animation: spin 1s linear infinite;
  will-change: transform;
}

.progress-inline {
  display: flex;
  align-items: center;
  justify-content: center;
}

:is(.progress-overlay, .overlay-progress-bar) :slotted(.progress-close-button) {
  position: fixed;
  top: max(16px, env(safe-area-inset-top));
  right: max(16px, env(safe-area-inset-right));
  z-index: 1;
  min-height: 44px;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: #5f5f5f;
  color: white;
  font: inherit;
  cursor: pointer;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
</style>
