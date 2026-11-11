<script setup lang="ts">
import { onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import { adminMapDisplaySettingsUrl } from "@/router/urls";

type MapDisplaySettings = { clusteringMinZoom: number };
const zoom = ref<number | string>("");
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const message = ref("");

async function load() {
  busy.value = true;
  error.value = "";
  try {
    const { data } = await apiClient.get<MapDisplaySettings>(adminMapDisplaySettingsUrl);
    zoom.value = data.clusteringMinZoom;
    loaded.value = true;
  } catch {
    error.value = "地図表示設定を取得できませんでした。";
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (!loaded.value || busy.value) return;
  error.value = "";
  message.value = "";
  const value = zoom.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 22) {
    error.value = "0〜22の整数を入力してください。";
    return;
  }
  busy.value = true;
  try {
    const { data } = await apiClient.put<MapDisplaySettings>(adminMapDisplaySettingsUrl, {
      clusteringMinZoom: value,
    });
    zoom.value = data.clusteringMinZoom;
    message.value = "地図表示設定を保存しました。地図の再読み込み時に反映されます。";
  } catch {
    error.value = "地図表示設定を保存できませんでした。再試行してください。";
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-shell" aria-labelledby="map-display-settings-title">
    <div class="page-heading">
      <h1 id="map-display-settings-title">地図表示設定</h1>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error && !loaded" type="button" @click="load">設定を再読み込み</button>
    <form class="admin-card" @submit.prevent="save">
      <fieldset :disabled="busy || !loaded">
        <legend>マーカーのクラスタ表示</legend>
        <label for="clustering-min-zoom">クラスタを解除できる最小ズーム</label>
        <input
          id="clustering-min-zoom"
          v-model.number="zoom"
          type="number"
          min="0"
          max="22"
          step="1"
          required
          aria-describedby="clustering-min-zoom-help"
        />
        <p id="clustering-min-zoom-help">
          0〜22の整数を指定できます。未設定時は15です。この値より縮小するとクラスタ表示に戻ります。
        </p>
        <button type="submit" class="button-primary">保存</button>
      </fieldset>
    </form>
    <MessageModal :is-open="message !== ''" :message="message" @close="message = ''" />
  </section>
</template>

<style scoped>
.admin-card {
  padding: 16px;
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 8px;
  padding: 0;
}
label {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
}
input {
  max-width: 8rem;
}
#clustering-min-zoom-help {
  color: var(--admin-text-muted);
}
</style>
