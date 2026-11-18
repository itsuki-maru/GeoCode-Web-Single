<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import apiClient from "@/axiosClient";
import { adminGoogleMapsSettingsUrl as url } from "@/router/urls";

type Settings = {
  revision: string;
  enabled: boolean;
  hasApiKey: boolean;
  keyStorageConfigured: boolean;
  language: string;
  region: string;
  requestsPerMinute: number;
};
const settings = ref<Settings>();
const form = reactive({
  enabled: false,
  apiKey: "",
  language: "ja-JP",
  region: "JP",
  requestsPerMinute: 1200,
});
const busy = ref(false),
  message = ref(""),
  error = ref("");
function apply(data: Settings) {
  settings.value = data;
  Object.assign(form, {
    enabled: data.enabled,
    apiKey: "",
    language: data.language,
    region: data.region,
    requestsPerMinute: data.requestsPerMinute,
  });
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  error.value = "";
  try {
    await action();
  } catch (e: any) {
    error.value =
      e.response?.status === 409
        ? "設定が更新されています。再読み込みしてから操作してください。"
        : e.response?.status === 401 || e.response?.status === 403
          ? "Google Maps設定を操作するには管理者権限が必要です。"
          : (e.response?.data?.error ??
            "Google Maps設定を処理できませんでした。設定とAPIの利用上限を確認してください。");
  } finally {
    busy.value = false;
  }
}
const load = () =>
  run(async () => {
    apply((await apiClient.get<Settings>(url)).data);
  });
function input() {
  return { ...form, revision: settings.value!.revision, apiKey: form.apiKey || undefined };
}
const save = () =>
  run(async () => {
    apply((await apiClient.put<Settings>(url, input())).data);
    message.value = "保存しました。地図を開き直すと反映されます。";
  });
const check = () =>
  run(async () => {
    await apiClient.post(`${url}/check`, input());
    message.value = "Map Tiles APIへの接続を確認しました。";
  });
onMounted(load);
</script>

<template>
  <section class="google-settings">
    <h1>Google Maps設定</h1>
    <p>
      Google背景地図のMap Tiles
      API接続を設定します。背景の種類は「背景地図設定」で登録してください。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <form v-if="settings" @submit.prevent="save">
      <fieldset :disabled="busy">
        <legend>Map Tiles API</legend>
        <label class="check"
          ><input v-model="form.enabled" type="checkbox" />Google背景地図を有効にする</label
        >
        <label for="google-tiles-key"
          >APIキー（{{ settings.hasApiKey ? "設定済み・空欄で維持" : "未設定" }}）</label
        >
        <input
          id="google-tiles-key"
          v-model="form.apiKey"
          type="password"
          autocomplete="new-password"
          maxlength="512"
        />
        <p v-if="!settings.keyStorageConfigured" role="alert">
          APIキーを保存するには、サーバーにGOOGLE_MAPS_ENCRYPTION_KEYを設定してください。
        </p>
        <label for="google-language">表示言語</label>
        <input
          id="google-language"
          v-model="form.language"
          required
          maxlength="35"
          placeholder="ja-JP"
          pattern="[A-Za-z0-9-]+"
        />
        <label for="google-region">地域</label>
        <input
          id="google-region"
          v-model="form.region"
          required
          maxlength="2"
          pattern="[A-Z]{2}"
          placeholder="JP"
        />
        <label for="google-limit">1分あたりの要求上限（サーバープロセス単位）</label>
        <input
          id="google-limit"
          v-model.number="form.requestsPerMinute"
          type="number"
          required
          min="60"
          max="60000"
          step="1"
        />
        <p>
          Google Cloud側で課金・Map Tiles
          APIの有効化、キーのAPI制限・送信元IP制限、クォータも設定してください。
        </p>
        <div class="actions">
          <button type="button" @click="check">接続確認</button>
          <button type="submit">保存</button>
          <button type="button" @click="load">再読み込み</button>
        </div>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.google-settings {
  max-width: 820px;
  margin: 0 auto;
  padding: 24px;
}
fieldset {
  display: grid;
  gap: 12px;
  padding: 20px;
  border: 1px solid #b7c2d0;
  border-radius: 8px;
}
input:not([type="checkbox"]) {
  box-sizing: border-box;
  width: 100%;
  padding: 10px;
  font: inherit;
}
.check,
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
button {
  padding: 10px 18px;
  cursor: pointer;
  font: inherit;
}
[role="alert"] {
  color: #aa2631;
}
[role="status"] {
  color: #176737;
}
p {
  line-height: 1.7;
}
</style>
