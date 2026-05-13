<script setup lang="ts">
defineProps<{
  isOpen: boolean;
}>();
</script>

<template>
  <div class="progress-overlay" v-show="isOpen">
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

.spinner {
  transform-origin: 50% 50%;
  transform-box: fill-box;
  animation: spin 1s linear infinite;
  will-change: transform;
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
