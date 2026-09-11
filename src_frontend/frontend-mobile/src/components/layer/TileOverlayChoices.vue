<script setup lang="ts">
import { onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import { baseUrl } from "@/settingMobile";
const emit = defineEmits<{
  changed: [tiles: unknown[]];
  busy: [value: boolean];
  loginRedirect: [];
}>();
const available = ref<Array<{ id: string; name: string }>>([]);
const selected = ref<string[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const response = await apiClient.get(`${baseUrl}/tile-overlays`);
    available.value = response.data.available;
    selected.value = response.data.selected;
  } catch (e) {
    error.value = "タイル一覧を取得できませんでした。再試行してください。";
    if (apiClient.isAxiosError(e) && e.response?.status === 401) emit("loginRedirect");
  } finally {
    loading.value = false;
  }
}
async function toggle(id: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const checked = input.checked;
  input.checked = selected.value.includes(id);
  saving.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const response = await apiClient.put(`${baseUrl}/tile-overlays/${id}`, { selected: checked });
    selected.value = response.data.map((tile: { id: string }) => tile.id);
    emit("changed", response.data);
  } catch (e) {
    error.value = "設定を保存できませんでした。チェックは変更されていません。";
    if (apiClient.isAxiosError(e) && e.response?.status === 401) emit("loginRedirect");
  } finally {
    saving.value = false;
    emit("busy", false);
  }
}
onMounted(load);
</script>
<template>
  <section class="tile-choices" aria-label="重ね合わせタイル" :aria-busy="loading || saving">
    <p>チェックしたタイルを地図の表示切替に追加します。変更は自動保存されます。</p>
    <p v-if="loading" role="status">読み込み中…</p>
    <p v-if="error" role="alert">
      {{ error }}
      <button type="button" :disabled="saving || loading" @click="load">再読み込み</button>
    </p>
    <p v-if="!loading && !error && !available.length">利用できるタイルがありません。</p>
    <div v-if="available.length" class="tile-choice-list">
      <table aria-label="重ね合わせタイルの選択">
        <thead>
          <tr>
            <th scope="col">タイル名</th>
            <th scope="col" class="tile-choice-selection">追加</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tile in available" :key="tile.id">
            <td>
              <label :for="`tile-choice-${tile.id}`">{{ tile.name }}</label>
            </td>
            <td class="tile-choice-selection">
              <input
                :id="`tile-choice-${tile.id}`"
                type="checkbox"
                :checked="selected.includes(tile.id)"
                :disabled="loading || saving"
                @change="toggle(tile.id, $event)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="saving" role="status">保存中…</p>
  </section>
</template>
<style scoped>
.tile-choices {
  text-align: left;
}
.tile-choice-list {
  max-height: 45vh;
  overflow-y: auto;
}
.tile-choice-list table {
  margin-top: 0;
  width: 100%;
  table-layout: fixed;
}
.tile-choice-list th,
.tile-choice-list td {
  padding: 6px 13px;
  vertical-align: middle;
  overflow-wrap: anywhere;
}
.tile-choice-list thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}
.tile-choice-list .tile-choice-selection {
  width: 64px;
  text-align: center;
}
.tile-choice-list label {
  display: block;
  cursor: pointer;
}
.tile-choice-list input {
  width: 20px;
  height: 20px;
  margin: 0;
  vertical-align: middle;
}
</style>
