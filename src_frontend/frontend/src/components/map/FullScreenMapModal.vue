<script setup lang="ts">
import { mapAnatherLayerUrl } from "@/router/urls";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <div class="overlay-fullscreen-map" v-if="isOpen">
    <iframe class="content-fullscreen-map" :src="mapAnatherLayerUrl" frameborder="0"></iframe>
    <button class="fullscreen-close-btn" @click="emit('close')">閉じる</button>
  </div>
</template>

<style scoped>
.overlay-fullscreen-map {
  z-index: 10;
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

.content-fullscreen-map {
  z-index: 11;
  width: 100%;
  height: 95vh;
  padding: 1em;
  background: #444444;
  border-radius: 10px;
}

.fullscreen-close-btn {
  z-index: 12;
  position: fixed;
  bottom: 5%;
  left: 2%;
}
</style>
