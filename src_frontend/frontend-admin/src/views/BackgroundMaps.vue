<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { isAxiosError } from "axios";
import apiClient from "@/axiosClient";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";
import { adminBackgroundMapsUrl } from "@/router/urls";
import {
  editBackgroundMapForm,
  newBackgroundMapForm,
  validateBackgroundMapForm,
  type BackgroundMapFallbacks,
  type BackgroundMapRecord,
  type BackgroundMapSettings,
} from "@/utils/background-maps";

const fallbackLabels = { normal: "通常の地図", temporary: "共有URL", live: "ライブマップ" };
const backgrounds = ref<BackgroundMapRecord[]>([]);
const fallbacks = ref<BackgroundMapFallbacks>({ normal: null, temporary: null, live: null });
const fallbackForm = ref<Pick<BackgroundMapFallbacks, "temporary" | "live">>({
  temporary: null,
  live: null,
});
const form = ref(newBackgroundMapForm());
const editing = ref<number | null>(null);
const deleting = ref<BackgroundMapRecord | null>(null);
const loaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const busy = computed(() => loading.value || saving.value);
const loadError = ref("");
const error = ref("");
const message = ref("");
const fallbackMessage = ref("");

const normalFallback = computed(() =>
  backgrounds.value.find((background) => String(background.id) === fallbacks.value.normal),
);
const fallbackOptions = computed(() =>
  backgrounds.value.filter(
    (background) =>
      background.enabled &&
      (background.provider ?? "generic") === "generic" &&
      (background.kind ?? "raster") === "raster",
  ),
);
const sharedFallbackOptions = computed(() =>
  fallbackOptions.value.filter((background) => background.allow_temporary_share),
);
const liveFallbackOptions = computed(() =>
  fallbackOptions.value.filter((background) => background.allow_live_map),
);
const canSaveFallbacks = computed(
  () =>
    (fallbackForm.value.temporary !== fallbacks.value.temporary ||
      fallbackForm.value.live !== fallbacks.value.live) &&
    sharedFallbackOptions.value.some(
      (background) => String(background.id) === fallbackForm.value.temporary,
    ) &&
    liveFallbackOptions.value.some(
      (background) => String(background.id) === fallbackForm.value.live,
    ),
);
const enabledCount = computed(
  () => backgrounds.value.filter((background) => background.enabled).length,
);
const editingScopes = computed(() => fallbackUsages(editing.value));
const keepEnabled = computed(
  () =>
    editingScopes.value.length > 0 ||
    (enabledCount.value === 1 &&
      backgrounds.value.some(
        (background) => background.id === editing.value && background.enabled,
      )),
);

function fallbackUsages(id: number | null) {
  return (Object.keys(fallbackLabels) as (keyof BackgroundMapFallbacks)[]).filter(
    (scope) => fallbacks.value[scope] === String(id),
  );
}

function deletionRestriction(background: BackgroundMapRecord): string {
  if (fallbackUsages(background.id).length > 0) return "フォールバックに使用中";
  if (backgrounds.value.length === 1) return "最後の登録済み背景";
  if (background.enabled && enabledCount.value === 1) return "最後の有効な背景";
  return "";
}

function updateFallbacks(settings: BackgroundMapFallbacks) {
  fallbacks.value = settings;
  fallbackForm.value = { temporary: settings.temporary, live: settings.live };
}

function validationMessage(failure: unknown, fallback: string): string {
  if (isAxiosError<{ error?: string }>(failure) && failure.response?.status === 400) {
    const detail = failure.response.data?.error;
    const prefix = "validation error: ";
    if (typeof detail === "string" && detail.startsWith(prefix)) {
      return detail.slice(prefix.length);
    }
  }
  return fallback;
}

async function load() {
  if (busy.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const { data } = await apiClient.get<BackgroundMapSettings>(adminBackgroundMapsUrl);
    backgrounds.value = [...data.backgrounds].sort((a, b) => a.id - b.id);
    updateFallbacks(data.fallbacks);
    loaded.value = true;
  } catch {
    loadError.value = "背景地図の設定を取得できませんでした。再読み込みしてください。";
  } finally {
    loading.value = false;
  }
}

function reset() {
  editing.value = null;
  form.value = newBackgroundMapForm();
  error.value = "";
}

function edit(background: BackgroundMapRecord) {
  if (busy.value) return;
  editing.value = background.id;
  form.value = editBackgroundMapForm(background);
  error.value = "";
  fallbackMessage.value = "";
}

async function save() {
  if (!loaded.value || busy.value) return;
  error.value = "";
  fallbackMessage.value = "";
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
    reset();
    message.value = "背景地図を保存しました。地図の再読み込み時に反映されます。";
  } catch (failure) {
    error.value = validationMessage(
      failure,
      "背景地図を保存できませんでした。入力内容と管理者のログイン状態を確認して再試行してください。",
    );
  } finally {
    saving.value = false;
  }
  // ID 1 がない旧データでは、ラスタの登録・有効化によって既定の代替背景が変わる。
  if (message.value && fallbacks.value.normal !== "1") await load();
}

async function saveFallbacks() {
  if (!canSaveFallbacks.value || busy.value) return;
  error.value = "";
  fallbackMessage.value = "";
  saving.value = true;
  try {
    const { data } = await apiClient.put<BackgroundMapFallbacks>(
      `${adminBackgroundMapsUrl}/fallbacks`,
      fallbackForm.value,
    );
    updateFallbacks(data);
    fallbackMessage.value = "フォールバックを保存しました。";
  } catch (failure) {
    error.value = validationMessage(
      failure,
      "フォールバックを保存できませんでした。一覧を再読み込みして再試行してください。",
    );
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const background = deleting.value;
  deleting.value = null;
  if (!background || busy.value || deletionRestriction(background)) return;
  error.value = "";
  fallbackMessage.value = "";
  saving.value = true;
  try {
    await apiClient.delete(`${adminBackgroundMapsUrl}/${background.id}`);
    backgrounds.value = backgrounds.value.filter((record) => record.id !== background.id);
    if (editing.value === background.id) reset();
    message.value = "背景地図を削除しました。地図の再読み込み時に反映されます。";
  } catch (failure) {
    error.value = validationMessage(
      failure,
      "背景地図を削除できませんでした。一覧を再読み込みして再試行してください。",
    );
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-shell background-settings" aria-labelledby="background-settings-title">
    <div class="page-heading"><h1 id="background-settings-title">背景地図設定</h1></div>
    <p class="hint">発行済みの共有URLにも、地図を開き直したときに現在の利用設定が反映されます。</p>
    <p v-if="loadError" role="alert" class="error">
      {{ loadError }} <button type="button" :disabled="busy" @click="load">一覧を再読み込み</button>
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="fallbackMessage" role="status" class="success">{{ fallbackMessage }}</p>
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
        <label for="background-provider"
          >配信元
          <select
            id="background-provider"
            v-model="form.provider"
            :disabled="editing === 1 || editingScopes.length > 0"
            @change="form.provider === 'google' && (form.kind = 'raster')"
          >
            <option value="generic">通常のタイル・スタイルURL</option>
            <option value="google">Google Maps（Map Tiles API）</option>
          </select>
        </label>
        <label v-if="form.provider === 'google'" for="background-google-type"
          >Google地図の種類
          <select id="background-google-type" v-model="form.google_map_type">
            <option value="roadmap">道路地図</option>
            <option value="satellite">衛星写真</option>
            <option value="terrain">地形地図</option>
          </select>
        </label>
        <p v-if="form.provider === 'google'" class="hint">
          「Google
          Maps設定」でAPIキーを設定してください。出典は地図の表示範囲に応じて自動表示します。
        </p>
        <label for="background-kind"
          >種別
          <select
            id="background-kind"
            v-model="form.kind"
            :disabled="editing === 1 || editingScopes.length > 0 || form.provider === 'google'"
            :aria-describedby="editingScopes.length > 0 ? 'background-default-help' : undefined"
          >
            <option value="raster">ラスタ（画像タイル）</option>
            <option value="vector">ベクタ（スタイルURL）</option>
          </select>
        </label>
        <p v-if="editingScopes.length" id="background-default-help" class="hint">
          {{
            editingScopes.map((scope) => fallbackLabels[scope]).join("・")
          }}のフォールバックとして使用中です。
        </p>
        <template v-if="form.provider !== 'google'">
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
            ベクタの描画にはスタイルURLを使用します。画像URLは従来形式との互換性のため保持します。
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
        </template>
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
        <label class="checkbox-label" for="background-enabled">
          <input
            id="background-enabled"
            v-model="form.enabled"
            type="checkbox"
            :disabled="keepEnabled"
          />
          有効
        </label>
        <label class="checkbox-label" for="background-allow-temporary">
          <input
            id="background-allow-temporary"
            v-model="form.allow_temporary_share"
            type="checkbox"
            :disabled="editingScopes.includes('temporary')"
          />
          共有URLで使用可
        </label>
        <label class="checkbox-label" for="background-allow-live">
          <input
            id="background-allow-live"
            v-model="form.allow_live_map"
            type="checkbox"
            :disabled="editingScopes.includes('live')"
          />
          ライブマップで使用可
        </label>
        <p class="hint">
          無効にすると、すべての地図の背景候補から外れます。
          <template v-if="editingScopes.length">
            公開先でフォールバックとして使用中の場合は、その公開先のフォールバックを変更してから利用を制限できます。
          </template>
        </p>
        <div class="actions">
          <button type="submit" class="button-primary">保存</button>
          <button v-if="editing !== null" type="button" class="button-secondary" @click="reset">
            編集をやめる
          </button>
        </div>
      </fieldset>
    </form>
    <form class="admin-card background-form" @submit.prevent="saveFallbacks">
      <fieldset :disabled="busy || !loaded">
        <legend>フォールバック（代替背景）</legend>
        <p class="hint">
          選択された背景が利用できないときに表示します。共有URL・ライブマップでは、その公開先で使用できる有効な通常ラスタ背景を指定できます。
        </p>
        <p v-if="normalFallback">
          通常の地図：{{ normalFallback.label }}（ID {{ normalFallback.id }}）
        </p>
        <div class="form-grid">
          <label for="background-fallback-temporary">
            共有URL
            <select id="background-fallback-temporary" v-model="fallbackForm.temporary" required>
              <option :value="null" disabled>背景を選択</option>
              <option v-for="item in sharedFallbackOptions" :key="item.id" :value="String(item.id)">
                {{ item.label }}（ID {{ item.id }}）
              </option>
            </select>
          </label>
          <label for="background-fallback-live">
            ライブマップ
            <select id="background-fallback-live" v-model="fallbackForm.live" required>
              <option :value="null" disabled>背景を選択</option>
              <option v-for="item in liveFallbackOptions" :key="item.id" :value="String(item.id)">
                {{ item.label }}（ID {{ item.id }}）
              </option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button type="submit" class="button-primary" :disabled="!canSaveFallbacks">
            フォールバックを保存
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
            <span class="kind-badge">{{
              background.provider === "google"
                ? "Google Maps / " + background.google_map_type
                : background.kind === "vector"
                  ? "ベクタ"
                  : "ラスタ"
            }}</span>
          </h3>
          <p class="hint">ID {{ background.id }} ・ 識別名：{{ background.layer_name }}</p>
          <p v-if="background.enabled">
            有効 ・
            {{ background.allow_temporary_share ? "共有URLで使用可" : "共有URLで使用不可" }} ・
            {{ background.allow_live_map ? "ライブマップで使用可" : "ライブマップで使用不可" }}
          </p>
          <p v-else>無効（すべての地図で非表示）</p>
          <p v-if="fallbackUsages(background.id).length" class="hint">
            {{
              fallbackUsages(background.id)
                .map((scope) => fallbackLabels[scope])
                .join("・")
            }}のフォールバック
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
        <div class="background-actions">
          <button
            type="button"
            :disabled="busy"
            :aria-label="`${background.label}を編集`"
            @click="edit(background)"
          >
            編集
          </button>
          <button
            type="button"
            class="button-danger"
            :disabled="busy || !!deletionRestriction(background)"
            :aria-label="`${background.label}を削除`"
            :title="deletionRestriction(background) || undefined"
            @click="deleting = background"
          >
            削除
          </button>
        </div>
      </li>
    </ul>
    <ConfirmModal
      :is-open="deleting !== null"
      title="背景地図の削除"
      :message="`「${deleting?.label ?? ''}」を削除しますか？ この背景を選択している地図では代替背景が表示されます。`"
      confirm-label="削除"
      danger
      @confirm="remove"
      @cancel="deleting = null"
    />
    <MessageModal :is-open="message !== ''" :message="message" @close="message = ''" />
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
.background-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
