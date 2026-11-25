<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import apiClient from "@/axiosClient";
import {
  adminGoogleMapsRoutesSettingsUrl as routesUrl,
  adminGoogleMapsSettingsUrl as url,
} from "@/router/urls";

type UsageSettings = {
  revision: string;
  enabled: boolean;
  requestsPerMinute: number;
};
type TileSettings = UsageSettings & {
  hasApiKey: boolean;
  keyStorageConfigured: boolean;
  language: string;
  region: string;
};
type RequestState = { busy: boolean; message: string; error: string };

const settings = ref<TileSettings>();
const routesSettings = ref<UsageSettings>();
const form = reactive({
  enabled: false,
  apiKey: "",
  language: "ja-JP",
  region: "JP",
  requestsPerMinute: 1200,
});
const routesForm = reactive({ enabled: false, requestsPerMinute: 60 });
const tilesState = reactive<RequestState>({ busy: false, message: "", error: "" });
const routesState = reactive<RequestState>({ busy: false, message: "", error: "" });
const routesKeyIssue = computed(() => {
  if (!settings.value) {
    return tilesState.error
      ? "Google Maps APIキーの設定を確認できません。ページを再読み込みしてください。"
      : "Google Maps APIキーの設定を確認しています。";
  }
  if (!settings.value.keyStorageConfigured) {
    return "経路検索を有効にするには、サーバーにGOOGLE_MAPS_ENCRYPTION_KEYを設定してください。";
  }
  if (!settings.value.hasApiKey) {
    return "経路検索を有効にするには、Map Tiles API欄でGoogle Maps APIキーを保存してください。";
  }
  return "";
});
const routesActivationBlocked = computed(
  () => !routesSettings.value?.enabled && !!routesKeyIssue.value,
);

function applyTiles(data: TileSettings) {
  settings.value = data;
  Object.assign(form, {
    enabled: data.enabled,
    apiKey: "",
    language: data.language,
    region: data.region,
    requestsPerMinute: data.requestsPerMinute,
  });
}
function applyRoutes(data: UsageSettings) {
  routesSettings.value = data;
  Object.assign(routesForm, {
    enabled: data.enabled,
    requestsPerMinute: data.requestsPerMinute,
  });
}
async function run(state: RequestState, fallback: string, action: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  state.message = "";
  state.error = "";
  try {
    await action();
  } catch (error) {
    const response = (
      error as { response?: { status?: number; data?: { error?: unknown } } } | null
    )?.response;
    state.error =
      response?.status === 409
        ? "設定が更新されています。再読み込みしてから操作してください。"
        : response?.status === 401 || response?.status === 403
          ? "Google Maps設定を操作するには管理者権限が必要です。"
          : typeof response?.data?.error === "string"
            ? response.data.error
            : fallback;
  } finally {
    state.busy = false;
  }
}
const tilesError = "Google Maps設定を処理できませんでした。設定とAPIの利用上限を確認してください。";
const routesError = "Routes APIの設定を処理できませんでした。時間をおいて再試行してください。";
const load = () =>
  run(tilesState, tilesError, async () => {
    applyTiles((await apiClient.get<TileSettings>(url)).data);
  });
function input() {
  return { ...form, revision: settings.value!.revision, apiKey: form.apiKey || undefined };
}
const save = () =>
  run(tilesState, tilesError, async () => {
    applyTiles((await apiClient.put<TileSettings>(url, input())).data);
    tilesState.message = "保存しました。地図を開き直すと反映されます。";
  });
const check = () =>
  run(tilesState, tilesError, async () => {
    await apiClient.post(`${url}/check`, input());
    tilesState.message = "Map Tiles APIへの接続を確認しました。";
  });
const loadRoutes = () =>
  run(routesState, routesError, async () => {
    applyRoutes((await apiClient.get<UsageSettings>(routesUrl)).data);
  });
const saveRoutes = () => {
  if (!routesSettings.value || (routesForm.enabled && routesActivationBlocked.value)) return;
  const revision = routesSettings.value.revision;
  return run(routesState, routesError, async () => {
    applyRoutes((await apiClient.put<UsageSettings>(routesUrl, { ...routesForm, revision })).data);
    routesState.message = "経路検索の設定を保存しました。地図を開き直すと反映されます。";
  });
};
onMounted(() => {
  void load();
  void loadRoutes();
});
</script>

<template>
  <section class="page-shell" aria-labelledby="google-maps-settings-title">
    <div class="page-heading">
      <h1 id="google-maps-settings-title">Google Maps設定</h1>
    </div>
    <section class="admin-card settings-card" aria-labelledby="google-tiles-title">
      <h2 id="google-tiles-title">Map Tiles API</h2>
      <p>
        Google背景地図のMap Tiles
        API接続を設定します。背景の種類は「背景地図設定」で登録してください。
      </p>
      <p v-if="tilesState.error" role="alert">{{ tilesState.error }}</p>
      <p v-if="tilesState.message" role="status">{{ tilesState.message }}</p>
      <form v-if="settings" @submit.prevent="save">
        <fieldset :disabled="tilesState.busy" aria-labelledby="google-tiles-title">
          <label class="check"
            ><input v-model="form.enabled" type="checkbox" />Google背景地図を有効にする</label
          >
          <div class="field">
            <label class="field-label" for="google-tiles-key">
              Google Maps APIキー（Map Tiles API・Routes API共用、{{
                settings.hasApiKey ? "設定済み・空欄で維持" : "未設定"
              }}）
            </label>
            <input
              id="google-tiles-key"
              v-model="form.apiKey"
              type="password"
              autocomplete="new-password"
              maxlength="512"
            />
          </div>
          <p v-if="!settings.keyStorageConfigured" role="alert">
            APIキーを保存するには、サーバーにGOOGLE_MAPS_ENCRYPTION_KEYを設定してください。
          </p>
          <div class="field">
            <label class="field-label" for="google-language">表示言語</label>
            <input
              id="google-language"
              v-model="form.language"
              required
              maxlength="35"
              placeholder="ja-JP"
              pattern="[A-Za-z0-9-]+"
            />
          </div>
          <div class="field">
            <label class="field-label" for="google-region">地域</label>
            <input
              id="google-region"
              v-model="form.region"
              required
              maxlength="2"
              pattern="[A-Z]{2}"
              placeholder="JP"
            />
          </div>
          <div class="field">
            <label class="field-label" for="google-limit">
              1分あたりの要求上限（サーバープロセス単位）
            </label>
            <input
              id="google-limit"
              v-model.number="form.requestsPerMinute"
              type="number"
              required
              min="60"
              max="60000"
              step="1"
            />
          </div>
          <p>
            Google Cloud側で課金・Map Tiles
            APIの有効化、キーのAPI制限・送信元IP制限、クォータも設定してください。
          </p>
          <div class="actions">
            <button type="button" @click="check">接続確認</button>
            <button type="submit" class="button-primary">保存</button>
            <button type="button" @click="load">再読み込み</button>
          </div>
        </fieldset>
      </form>
    </section>
    <section class="admin-card settings-card routes-settings" aria-labelledby="google-routes-title">
      <h2 id="google-routes-title">Routes API</h2>
      <p>Google Maps背景を表示している地図で、現在位置からの経路検索を設定します。</p>
      <p v-if="routesState.error" role="alert">{{ routesState.error }}</p>
      <p v-if="routesState.message" role="status">{{ routesState.message }}</p>
      <form v-if="routesSettings" @submit.prevent="saveRoutes">
        <fieldset :disabled="routesState.busy" aria-labelledby="google-routes-title">
          <label class="check">
            <input
              id="google-routes-enabled"
              v-model="routesForm.enabled"
              type="checkbox"
              :disabled="routesActivationBlocked"
              :aria-describedby="routesKeyIssue ? 'google-routes-key-issue' : undefined"
            />
            経路検索を有効にする
          </label>
          <p v-if="routesKeyIssue" id="google-routes-key-issue" aria-live="polite">
            {{ routesKeyIssue }}
          </p>
          <div class="field">
            <label class="field-label" for="google-routes-limit">
              1分あたりの経路検索上限（サーバープロセス単位）
            </label>
            <input
              id="google-routes-limit"
              v-model.number="routesForm.requestsPerMinute"
              type="number"
              required
              min="1"
              max="3000"
              step="1"
            />
          </div>
          <p>
            Google CloudでRoutes APIを有効にし、共用キーのAPI制限にMap Tiles APIとRoutes
            APIを指定してください。
          </p>
          <div class="actions">
            <button
              type="submit"
              class="button-primary"
              :disabled="routesForm.enabled && routesActivationBlocked"
            >
              保存
            </button>
            <button type="button" @click="loadRoutes">再読み込み</button>
          </div>
        </fieldset>
      </form>
      <button
        v-else-if="routesState.error"
        type="button"
        :disabled="routesState.busy"
        @click="loadRoutes"
      >
        Routes APIの設定を再読み込み
      </button>
    </section>
  </section>
</template>

<style scoped>
.settings-card {
  margin: 16px 0;
  padding: 16px;
}
h2 {
  font-size: 1.15rem;
}
fieldset {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.check,
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
[role="alert"] {
  color: #aa2631;
}
[role="status"] {
  color: #176737;
}
fieldset p {
  margin: 0;
}
</style>
