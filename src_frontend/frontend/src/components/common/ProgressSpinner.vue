<script setup lang="ts">
import {
  progressSpinnerTransform,
  progressSpinnerCircle,
} from "../../../../template-scripts/src/map/common/progress-spinner";
import "../../../../template-scripts/src/map/common/progress-spinner.css";
defineProps<{
  isOpen: boolean;
  inline?: boolean;
}>();
</script>

<template>
  <div :class="inline ? 'progress-inline' : 'progress-overlay'" v-show="isOpen">
    <svg
      class="spinner shared-progress-spinner"
      width="50"
      height="50"
      view-box="0 0 50 50"
      aria-hidden="true"
    >
      <g :transform="progressSpinnerTransform"><circle v-bind="progressSpinnerCircle" /></g>
    </svg>
    <slot name="controls" />
  </div>
</template>

<style scoped>
.progress-overlay {
  z-index: 3;
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
</style>
