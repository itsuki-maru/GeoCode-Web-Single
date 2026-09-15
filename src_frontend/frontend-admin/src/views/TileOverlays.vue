<script setup lang="ts">
import { onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import { baseUrl } from "@/setting";
import ConfirmModal from "@/components/common/ConfirmModal.vue";

type Tile = {
  id: string;
  name: string;
  url: string;
  attribution: string;
  min_zoom: number;
  max_zoom: number;
  opacity: number;
  sort_order: number;
  enabled: boolean;
};
const defaults = (): Omit<Tile, "id"> => ({
  name: "",
  url: "",
  attribution: "",
  min_zoom: 0,
  max_zoom: 18,
  opacity: 0.7,
  sort_order: 0,
  enabled: true,
});
const tiles = ref<Tile[]>([]);
const form = ref(defaults());
const editing = ref<string | null>(null);
const deleting = ref<Tile | null>(null);
const busy = ref(false);
const error = ref("");
const message = ref("");
const endpoint = `${baseUrl}/admin/tile-overlays`;
async function load() {
  busy.value = true;
  error.value = "";
  try {
    tiles.value = (await apiClient.get(endpoint)).data;
  } catch {
    error.value = "タイル設定を取得できませんでした。";
  } finally {
    busy.value = false;
  }
}
function reset() {
  editing.value = null;
  form.value = defaults();
}
function edit(tile: Tile) {
  editing.value = tile.id;
  form.value = { ...tile };
  message.value = "";
}
async function save() {
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const response = editing.value
      ? await apiClient.put(`${endpoint}/${editing.value}`, form.value)
      : await apiClient.post(endpoint, form.value);
    tiles.value = [...tiles.value.filter((t) => t.id !== response.data.id), response.data].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
    );
    reset();
    message.value = "タイル設定を保存しました。各地図の再読み込み時に反映されます。";
  } catch {
    error.value = "保存できませんでした。入力内容と管理者のログイン状態を確認してください。";
  } finally {
    busy.value = false;
  }
}
async function remove() {
  const tile = deleting.value;
  deleting.value = null;
  if (!tile || busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await apiClient.delete(`${endpoint}/${tile.id}`);
    tiles.value = tiles.value.filter((t) => t.id !== tile.id);
    if (editing.value === tile.id) reset();
    message.value = "タイル設定を削除しました。各アカウントの登録も解除されます。";
  } catch {
    error.value = "削除できませんでした。再試行してください。";
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="tile-settings">
    <h1>タイル追加設定</h1>
    <p>ユーザーが地図に重ねて表示できる画像タイルを登録します。</p>
    <p v-if="error" role="alert">
      {{ error }} <button :disabled="busy" @click="load">一覧を再読み込み</button>
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="busy" role="status">処理中…</p>
    <form @submit.prevent="save">
      <fieldset :disabled="busy">
        <legend>{{ editing ? "タイルを編集" : "タイルを登録" }}</legend>
        <label>表示名<input v-model="form.name" required maxlength="100" /></label>
        <label
          >画像タイルURL<input
            v-model="form.url"
            required
            maxlength="4096"
            placeholder="https://example.com/{z}/{x}/{y}.png"
        /></label>
        <p class="hint">HTTPSのURLに {z}・{x}・{y} を含めてください。</p>
        <label
          >出典（テキスト・リンクHTML）<input
            v-model="form.attribution"
            maxlength="1000"
            aria-describedby="tile-attribution-help"
        /></label>
        <p id="tile-attribution-help" class="hint">
          例：<code
            >&lt;a
            href="https://disaportal.gsi.go.jp/"&gt;ハザードマップポータルサイト&lt;/a&gt;</code
          ><br />
          HTTP・HTTPSのリンクは別タブで開きます。通常のテキストも入力できます。
        </p>
        <div class="number-fields">
          <label
            >最小ズーム<input
              v-model.number="form.min_zoom"
              type="number"
              min="0"
              max="22"
              required
          /></label>
          <label
            >最大ズーム<input
              v-model.number="form.max_zoom"
              type="number"
              :min="form.min_zoom"
              max="22"
              required
          /></label>
          <label
            >不透明度（0〜1）<input
              v-model.number="form.opacity"
              type="number"
              min="0"
              max="1"
              step="0.05"
              required
          /></label>
          <label
            >表示順<input
              v-model.number="form.sort_order"
              type="number"
              min="-2147483648"
              max="2147483647"
              required
          /></label>
        </div>
        <label class="enabled"><input v-model="form.enabled" type="checkbox" />有効</label>
        <div class="actions">
          <button type="submit">保存</button
          ><button v-if="editing" type="button" @click="reset">編集をやめる</button>
        </div>
      </fieldset>
    </form>
    <h2>登録済みタイル</h2>
    <p v-if="!busy && !tiles.length">登録されたタイルはありません。</p>
    <ul class="tile-list">
      <li v-for="tile in tiles" :key="tile.id">
        <div>
          <strong>{{ tile.name }}</strong> <span>{{ tile.enabled ? "有効" : "無効" }}</span>
          <p>{{ tile.url }}</p>
        </div>
        <div class="actions">
          <button :disabled="busy" @click="edit(tile)">編集</button
          ><button :disabled="busy" @click="deleting = tile">削除</button>
        </div>
      </li>
    </ul>
    <ConfirmModal
      :isOpen="deleting !== null"
      title="タイル設定の削除"
      :message="`${deleting?.name ?? ''}を削除し、全アカウントの登録を解除しますか？`"
      confirmLabel="削除"
      danger
      @confirm="remove"
      @cancel="deleting = null"
    />
  </div>
</template>

<style scoped>
.tile-settings {
  max-width: 1000px;
  margin: 24px auto;
  padding: 0 20px 40px;
}
h1,
h2 {
  margin: 20px 0 12px;
}
fieldset {
  border: 1px solid #aaa;
  border-radius: 8px;
  padding: 20px;
  margin-top: 20px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}
input:not([type="checkbox"]) {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  font-size: 16px;
}
.number-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
}
.enabled {
  flex-direction: row;
  align-items: center;
}
.hint {
  font-size: 0.9rem;
}
.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
button {
  padding: 8px 16px;
  cursor: pointer;
}
.tile-list {
  list-style: none;
  padding: 0;
}
.tile-list li {
  border-bottom: 1px solid #aaa;
  padding: 18px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.tile-list .actions {
  align-items: center;
}
.tile-list p {
  overflow-wrap: anywhere;
}
</style>
