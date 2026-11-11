<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import { adminBackgroundMapsUrl } from "@/router/urls";
import {
  editBackgroundMapForm,
  newBackgroundMapForm,
  validateBackgroundMapForm,
  type BackgroundMapRecord,
} from "@/utils/background-maps";

const backgrounds = ref<BackgroundMapRecord[]>([]);
const form = ref(newBackgroundMapForm());
const editing = ref<number | null>(null);
const loaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const busy = computed(() => loading.value || saving.value);
const loadError = ref("");
const error = ref("");
const message = ref("");

async function load() {
  if (busy.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const { data } = await apiClient.get<BackgroundMapRecord[]>(adminBackgroundMapsUrl);
    backgrounds.value = [...data].sort((a, b) => a.id - b.id);
    loaded.value = true;
  } catch {
    loadError.value = "背景地図の設定を取得できませんでした。再読み込みしてください。";
  } finally {
    loading.value = false;
  }
}

function reset() {
  if (busy.value) return;
  editing.value = null;
  form.value = newBackgroundMapForm();
  error.value = "";
}

function edit(background: BackgroundMapRecord) {
  if (busy.value) return;
  editing.value = background.id;
  form.value = editBackgroundMapForm(background);
  error.value = "";
  message.value = "";
}

async function save() {
  if (!loaded.value || busy.value) return;
  error.value = "";
  message.value = "";
  const result = validateBackgroundMapForm(form.value, editing.value, backgrounds.value);
  if (result.error) {
    error.value = result.error;
    return;
  }
  saving.value = true;
  try {
    const { data } =
      editing.value === null
        ? await apiClient.post<BackgroundMapRecord>(adminBackgroundMapsUrl, result.input)
        : await apiClient.put<BackgroundMapRecord>(
            `${adminBackgroundMapsUrl}/${editing.value}`,
            result.input,
          );
    backgrounds.value = [
      ...backgrounds.value.filter((background) => background.id !== data.id),
      data,
    ].sort((a, b) => a.id - b.id);
    editing.value = null;
    form.value = newBackgroundMapForm();
    message.value = "背景地図を保存しました。地図の再読み込み時に反映されます。";
  } catch {
    error.value =
      "背景地図を保存できませんでした。入力内容と管理者のログイン状態を確認して再試行してください。";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-shell background-settings" aria-labelledby="background-settings-title">
    <div class="page-heading"><h1 id="background-settings-title">背景地図設定</h1></div>
    <p>地図の背景に使用するラスタ画像タイル・ベクタタイルを登録します。</p>
    <p class="hint">
      変更は地図を開き直すと反映されます。保存済みの表示状態を共有するURLは、共有時の背景設定を引き続き使用します。
    </p>
    <p v-if="loadError" role="alert" class="error">
      {{ loadError }} <button type="button" :disabled="busy" @click="load">一覧を再読み込み</button>
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="message" role="status" class="success">{{ message }}</p>
    <form class="admin-card background-form" @submit.prevent="save">
      <fieldset :disabled="busy || !loaded">
        <legend>
          {{ editing === null ? "背景地図を登録" : `背景地図を編集（ID ${editing}）` }}
        </legend>
        <div class="form-grid">
          <label for="background-label"
            >表示名
            <input id="background-label" v-model="form.label" required />
          </label>
          <label for="background-layer-name"
            >識別名
            <input
              id="background-layer-name"
              v-model="form.layer_name"
              required
              aria-describedby="background-name-help"
            />
          </label>
        </div>
        <p id="background-name-help" class="hint">
          表示名・識別名は255文字以内です。識別名は他の背景と異なる名前を指定してください。
        </p>
        <label for="background-kind"
          >種別
          <select
            id="background-kind"
            v-model="form.kind"
            :disabled="editing === 1"
            aria-describedby="background-default-help"
          >
            <option value="raster">ラスタ（画像タイル）</option>
            <option value="vector">ベクタ（スタイルURL）</option>
          </select>
        </label>
        <p v-if="editing === 1" id="background-default-help" class="hint">
          背景ID 1は、代替表示に使用するラスタ背景として維持します。
        </p>
        <label for="background-url"
          >{{ form.kind === "vector" ? "互換用画像タイルURL" : "画像タイルURL" }}
          <input
            id="background-url"
            v-model="form.url"
            required
            placeholder="/tile/{z}/{x}/{y}.png"
            aria-describedby="background-url-help"
          />
        </label>
        <p id="background-url-help" class="hint">
          HTTP・HTTPSのURL、または /
          で始まる同じサイト内のパスを255文字以内で指定してください。{z}・{x}・{y}
          のタイル座標を使用できます。
        </p>
        <p v-if="form.kind === 'vector'" class="hint">
          ベクタの描画にはスタイルURLを使用します。画像URLは従来形式との互換性のため保持します。代替表示には背景ID
          1を使用します。
        </p>
        <template v-if="form.kind === 'vector'">
          <label for="background-style-url"
            >スタイルURL
            <input
              id="background-style-url"
              v-model="form.style_url"
              required
              maxlength="4096"
              placeholder="https://example.com/styles/map.json"
              aria-describedby="background-style-help"
            />
          </label>
          <p id="background-style-help" class="hint">
            HTTPSのURL、または /
            で始まる同じサイト内のパスを指定してください（UTF-8で4096バイト以内）。公開してよいURLを使用し、外部配信元の接続許可とCORS対応は別途設定してください。
          </p>
        </template>
        <label for="background-attribution"
          >出典（テキスト・リンクHTML）
          <textarea
            id="background-attribution"
            v-model="form.attribution"
            rows="2"
            aria-describedby="background-attribution-help"
          ></textarea>
        </label>
        <p id="background-attribution-help" class="hint">
          255文字以内で入力してください。新規・変更した出典は、保存時にテキストと安全なリンク・書式へ整えます。
        </p>
        <div class="form-grid zoom-fields">
          <label for="background-min-zoom"
            >最小ズーム
            <input
              id="background-min-zoom"
              v-model.number="form.min_zoom"
              type="number"
              min="0"
              max="22"
              step="1"
              placeholder="5"
              aria-describedby="background-zoom-help"
            />
          </label>
          <label for="background-max-zoom"
            >最大ズーム
            <input
              id="background-max-zoom"
              v-model.number="form.max_zoom"
              type="number"
              min="0"
              max="22"
              step="1"
              placeholder="18"
              aria-describedby="background-zoom-help"
            />
          </label>
        </div>
        <p id="background-zoom-help" class="hint">
          0〜22の整数を指定できます。空欄は最小5・最大18として表示し、未設定のまま保存します。
        </p>
        <label class="checkbox-label" for="background-foreign">
          <input
            id="background-foreign"
            v-model="form.include_foreign_tiles"
            type="checkbox"
          />海外の地図も表示する
        </label>
        <div class="actions">
          <button type="submit" class="button-primary">保存</button>
          <button v-if="editing !== null" type="button" class="button-secondary" @click="reset">
            編集をやめる
          </button>
        </div>
      </fieldset>
    </form>
    <div class="list-heading">
      <h2>登録済み背景地図</h2>
      <button type="button" class="button-secondary" :disabled="busy" @click="load">
        一覧を再読み込み
      </button>
    </div>
    <p v-if="loaded && !backgrounds.length">登録された背景地図はありません。</p>
    <ul class="background-list">
      <li v-for="background in backgrounds" :key="background.id" class="admin-card">
        <div class="background-details">
          <h3>
            {{ background.label }}
            <span class="kind-badge">{{ background.kind === "vector" ? "ベクタ" : "ラスタ" }}</span>
          </h3>
          <p class="hint">
            ID {{ background.id }} ・ 識別名：{{ background.layer_name
            }}<span v-if="background.id === 1"> ・ 代替表示用</span>
          </p>
          <p v-if="background.kind === 'vector'">
            <span class="detail-label">スタイルURL：</span><code>{{ background.style_url }}</code>
          </p>
          <p>
            <span class="detail-label">{{
              background.kind === "vector" ? "互換用画像URL：" : "画像URL："
            }}</span
            ><code>{{ background.url }}</code>
          </p>
        </div>
        <button
          type="button"
          :disabled="busy"
          :aria-label="`${background.label}を編集`"
          @click="edit(background)"
        >
          編集
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.background-settings > p {
  margin: 8px 0;
}
.background-form {
  margin: 20px 0 28px;
  padding: 20px;
}
fieldset {
  min-width: 0;
  border: 0;
  margin: 0;
  padding: 0;
}
legend {
  font-size: 1.15rem;
  font-weight: 700;
  padding: 0;
  margin-bottom: 16px;
}
label {
  display: block;
  margin: 12px 0 4px;
  font-weight: 600;
}
input,
select,
textarea {
  display: block;
  margin-top: 4px;
}
textarea {
  resize: vertical;
}
select {
  max-width: 26rem;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.zoom-fields {
  max-width: 32rem;
}
.hint {
  color: var(--admin-text-muted);
  font-size: 0.9rem;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.checkbox-label input {
  margin: 0;
  flex-shrink: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}
.list-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.background-list {
  display: grid;
  gap: 12px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.background-list li {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 18px;
}
.background-details {
  flex: 1;
  min-width: 0;
}
.background-details h3 {
  font-size: 1rem;
  margin: 0 0 6px;
  overflow-wrap: anywhere;
}
.background-details p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
code {
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
.kind-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border: 1px solid var(--admin-border);
  border-radius: 12px;
  color: var(--admin-text-muted);
  font-size: 0.8rem;
  font-weight: 400;
}
.error {
  color: var(--admin-danger);
}
.success {
  color: var(--admin-success);
}
@media (max-width: 600px) {
  .form-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .background-form {
    padding: 16px;
  }
  .background-list li {
    flex-direction: column;
  }
}
</style>
