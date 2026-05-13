<script setup lang="ts">
import type { UploadProgressState } from '@/interface';
import BaseModal from './BaseModal.vue';

defineProps<{
  isOpen: boolean;
  progress: UploadProgressState;
}>();
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="20">
    <div class="progress-dialog">
      <h2 class="modal-h2">アップロード状況</h2>
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

      <p class="progress-title">{{ progress.fileName || '処理を実行しています' }}</p>
      <p class="progress-message">{{ progress.message || 'しばらくお待ちください。' }}</p>

      <div class="progress-track">
        <div
          class="progress-bar"
          :class="{ indeterminate: progress.percent === null }"
          :style="progress.percent !== null ? { width: `${progress.percent}%` } : undefined"
        />
      </div>

      <p class="progress-percent" v-if="progress.percent !== null">{{ progress.percent }}%</p>
      <p class="progress-percent" v-else>進捗を計測中です</p>

      <p class="progress-bytes" v-if="progress.loadedBytes !== undefined && progress.totalBytes">
        {{ (progress.loadedBytes / 1024 / 1024).toFixed(1) }}MB /
        {{ (progress.totalBytes / 1024 / 1024).toFixed(1) }}MB
      </p>
    </div>
  </BaseModal>
</template>

<style scoped>
.progress-dialog {
  width: min(30vw, 420px);
  min-width: 320px;
  text-align: center;
}

.modal-h2 {
  margin-top: 0;
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.spinner {
  transform-origin: 50% 50%;
  transform-box: fill-box;
  animation: spin 1s linear infinite;
  will-change: transform;
  margin: 8px 0 12px;
}

.progress-title {
  margin: 0 0 8px;
  font-weight: 700;
  word-break: break-word;
}

.progress-message {
  margin: 10px 0 14px;
  color: #333;
  font-size: 0.95rem;
}

.progress-track {
  width: 100%;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: #d8d8d8;
}

.progress-bar {
  height: 100%;
  border-radius: 999px;
  background: rgb(28, 58, 190);
  transition: width 0.2s ease;
}

.progress-bar.indeterminate {
  width: 40%;
  animation: indeterminate 1.1s ease-in-out infinite;
}

.progress-percent,
.progress-bytes {
  margin: 10px 0 0;
  color: #333;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes indeterminate {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(280%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }

  .progress-bar.indeterminate {
    animation: none;
    width: 65%;
  }
}

@media (max-width: 1024px) {
  .progress-dialog {
    width: min(90vw, 420px);
    min-width: auto;
  }
}
</style>
