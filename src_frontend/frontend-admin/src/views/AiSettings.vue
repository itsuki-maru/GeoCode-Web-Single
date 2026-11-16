<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import { adminAiSettingsUrl } from "@/router/urls";

type Provider = "openai" | "anthropic" | "gemini";
type KeyAction = "keep" | "replace" | "clear";
type Configuration = {
  enabled: boolean;
  writeEnabled: boolean;
  provider: Provider;
  baseUrl: string;
  model: string;
  speechEnabled: boolean;
  speechBaseUrl: string;
  speechModel: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  maxRequestsPerMinute: number;
};
type Settings = Configuration & {
  revision: string | null;
  hasApiKey: boolean;
  hasSpeechApiKey: boolean;
  keyStorageConfigured: boolean;
};

const settings = ref<Settings | null>(null);
const draft = reactive<Configuration>({
  enabled: false,
  writeEnabled: false,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  speechEnabled: false,
  speechBaseUrl: "https://api.openai.com/v1",
  speechModel: "",
  timeoutSeconds: 60,
  maxOutputTokens: 2048,
  maxRequestsPerMinute: 20,
});
const apiKey = ref("");
const speechApiKey = ref("");
const keyAction = ref<KeyAction>("keep");
const speechKeyAction = ref<KeyAction>("keep");
const busy = ref(false);
const needsReload = ref(false);
const message = ref("");
const blocked = computed(() => busy.value || !settings.value || needsReload.value);
const canConfigure = computed(() => !blocked.value && settings.value?.keyStorageConfigured);
let disposed = false;

watch(keyAction, () => {
  apiKey.value = "";
});
watch(speechKeyAction, () => {
  speechApiKey.value = "";
});

function clearKeys() {
  apiKey.value = "";
  speechApiKey.value = "";
}

function receive(next: Settings) {
  settings.value = next;
  Object.assign(draft, {
    enabled: next.enabled,
    writeEnabled: next.writeEnabled ?? false,
    provider: next.provider,
    baseUrl: next.baseUrl,
    model: next.model,
    speechEnabled: next.speechEnabled,
    speechBaseUrl: next.speechBaseUrl,
    speechModel: next.speechModel,
    timeoutSeconds: next.timeoutSeconds,
    maxOutputTokens: next.maxOutputTokens,
    maxRequestsPerMinute: next.maxRequestsPerMinute,
  });
  clearKeys();
  keyAction.value = speechKeyAction.value = "keep";
  needsReload.value = false;
}

function failureDetails(failure: unknown): string {
  const data: unknown = isAxiosError(failure) ? failure.response?.data : undefined;
  if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string")
    return "";
  let detail = data.error.trim();
  for (const key of [apiKey.value, speechApiKey.value]) {
    if (key) detail = detail.split(key).join("[非表示]");
  }
  return detail.slice(0, 1200);
}

async function run(action: () => Promise<void>, failureMessage: string) {
  if (busy.value || disposed) return;
  busy.value = true;
  message.value = "";
  try {
    await action();
  } catch (failure) {
    if (disposed) return;
    const status = isAxiosError(failure) ? failure.response?.status : undefined;
    if (status === 409) {
      clearKeys();
      needsReload.value = true;
      message.value =
        "別の操作でAI設定が更新されました。最新の設定を取得してから入力し直してください。";
    } else if (status === 401 || status === 403) {
      clearKeys();
      needsReload.value = true;
      message.value = "AI設定を操作するには管理者権限が必要です。";
    } else {
      if (!settings.value) needsReload.value = true;
      const detail = failureDetails(failure);
      message.value = detail ? `${failureMessage} 詳細：${detail}` : failureMessage;
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function load() {
  await run(async () => {
    const reloading = settings.value !== null || needsReload.value;
    const { data } = await apiClient.get<Settings>(adminAiSettingsUrl);
    if (disposed) return;
    receive(data);
    if (reloading) message.value = "最新のAI設定を取得しました。必要な変更を入力してください。";
  }, "AI設定を取得できませんでした。再試行してください。");
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value === value.trim() &&
      value.length <= 2048 &&
      /^https?:$/.test(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\s\\]/u.test(value)
    );
  } catch {
    return false;
  }
}

function selectProvider() {
  draft.baseUrl = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
  }[draft.provider];
  draft.model = "";
  apiKey.value = "";
  keyAction.value = settings.value?.hasApiKey ? "replace" : "keep";
}

function input(checking = false) {
  if (!canConfigure.value || !settings.value) return;
  const active = draft.enabled || checking;
  if (
    (draft.baseUrl !== "" && !validUrl(draft.baseUrl)) ||
    (active && (!draft.baseUrl || !draft.model.trim()))
  ) {
    message.value =
      "LLMのHTTP(S)接続先URLとモデル名を入力してください。URLに認証情報・クエリ・フラグメントは指定できません。";
    return;
  }
  if (
    (draft.speechBaseUrl !== "" && !validUrl(draft.speechBaseUrl)) ||
    (draft.speechEnabled && (!draft.speechBaseUrl || !draft.speechModel.trim()))
  ) {
    message.value = "音声認識のHTTP(S)接続先URLとモデル名を入力してください。";
    return;
  }
  if (
    !/^[A-Za-z0-9_.:/-]{0,200}$/.test(draft.model.trim()) ||
    !/^[A-Za-z0-9_.:/-]{0,200}$/.test(draft.speechModel.trim())
  ) {
    message.value = "モデル名は英数字と - _ . : / を使って200文字以内で指定してください。";
    return;
  }
  if (
    !Number.isInteger(draft.timeoutSeconds) ||
    draft.timeoutSeconds < 5 ||
    draft.timeoutSeconds > 120 ||
    !Number.isInteger(draft.maxOutputTokens) ||
    draft.maxOutputTokens < 128 ||
    draft.maxOutputTokens > 8192 ||
    !Number.isInteger(draft.maxRequestsPerMinute) ||
    draft.maxRequestsPerMinute < 1 ||
    draft.maxRequestsPerMinute > 60
  ) {
    message.value =
      "制限値を確認してください。タイムアウトは5〜120秒、出力は128〜8192トークン、毎分の要求数は1〜60回です。";
    return;
  }
  if (keyAction.value === "replace" && !apiKey.value.trim()) {
    message.value = "LLMの新しいAPIキーを入力してください。";
    return;
  }
  if (speechKeyAction.value === "replace" && !speechApiKey.value.trim()) {
    message.value = "音声認識の新しいAPIキーを入力してください。";
    return;
  }
  if (
    keyAction.value === "keep" &&
    settings.value.hasApiKey &&
    (draft.baseUrl !== settings.value.baseUrl || draft.provider !== settings.value.provider)
  ) {
    message.value =
      "LLMの接続先または方式を変更した場合は、APIキーの置換または削除を選択してください。";
    return;
  }
  if (
    speechKeyAction.value === "keep" &&
    settings.value.hasSpeechApiKey &&
    draft.speechBaseUrl !== settings.value.speechBaseUrl
  ) {
    message.value = "音声認識の接続先を変更した場合は、APIキーの置換または削除を選択してください。";
    return;
  }
  return {
    revision: settings.value.revision,
    ...draft,
    model: draft.model.trim(),
    speechModel: draft.speechModel.trim(),
    ...(keyAction.value === "replace" ? { apiKey: apiKey.value } : {}),
    ...(keyAction.value === "clear" ? { clearApiKey: true } : {}),
    ...(speechKeyAction.value === "replace" ? { speechApiKey: speechApiKey.value } : {}),
    ...(speechKeyAction.value === "clear" ? { clearSpeechApiKey: true } : {}),
  };
}

async function save() {
  const body = input();
  if (!body) return;
  await run(async () => {
    const { data } = await apiClient.put<Settings>(adminAiSettingsUrl, body);
    if (disposed) return;
    receive(data);
    message.value = data.enabled
      ? "AI設定を保存しました。地図画面で利用できます。"
      : "AI設定を保存しました。AI機能は無効です。";
  }, "AI設定を保存できませんでした。接続先・モデル名・キー・制限値を確認してください。");
}

async function check() {
  const body = input(true);
  if (!body) return;
  await run(async () => {
    const { data } = await apiClient.post<{ ok: boolean }>(`${adminAiSettingsUrl}/check`, body);
    if (disposed) return;
    if (!data.ok) throw new Error("connection failed");
    message.value = "LLMの接続と応答形式を確認しました。設定を適用するには保存してください。";
  }, "LLMの接続を確認できませんでした。接続先・モデル名・キーとサーバーの接続許可を確認してください。");
}

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  clearKeys();
});
</script>

<template>
  <section class="page-shell" aria-labelledby="ai-settings-title">
    <div class="page-heading">
      <h1 id="ai-settings-title">AI設定</h1>
      <button type="button" :disabled="busy" @click="load">最新の設定を取得</button>
    </div>
    <p>
      管理者が設定したLLMをログイン済みユーザーが利用します。検索対象は各ユーザーが所有するデータです。
    </p>
    <p v-if="settings && !settings.keyStorageConfigured" role="status" class="configuration-note">
      設定を保存するには、サーバーに暗号鍵（<code>AI_ENCRYPTION_KEY</code>）を設定してください。
    </p>
    <form novalidate @submit.prevent="save">
      <fieldset class="settings-fields" :disabled="!canConfigure">
        <legend class="visually-hidden">AI機能と接続設定</legend>
        <div class="admin-card settings-card">
          <h2>AI機能</h2>
          <label class="check-row" for="ai-enabled">
            <input id="ai-enabled" v-model="draft.enabled" type="checkbox" />AI機能を有効にする
          </label>
          <p class="hint">無効にすると、AIへの新しい送信と追加操作を停止します。</p>
          <label class="check-row" for="ai-write-enabled">
            <input id="ai-write-enabled" v-model="draft.writeEnabled" type="checkbox" />
            AIによるレイヤー作成・条件保存を許可する
          </label>
          <p class="hint">
            初期状態は不許可です。許可した場合も、チャットで名前と内容を確認してから確定します。
            AI機能が無効の場合は作成・保存も実行できません。
          </p>
        </div>

        <div class="admin-card settings-card">
          <h2>LLM接続</h2>
          <label for="ai-provider">接続方式</label>
          <select id="ai-provider" v-model="draft.provider" @change="selectProvider">
            <option value="openai">OpenAI / OpenAI互換API</option>
            <option value="anthropic">Claude（Anthropic API）</option>
            <option value="gemini">Gemini API</option>
          </select>
          <label for="ai-base-url">接続先URL</label>
          <input
            id="ai-base-url"
            v-model="draft.baseUrl"
            type="url"
            maxlength="2048"
            spellcheck="false"
            aria-describedby="ai-url-help"
          />
          <p id="ai-url-help" class="hint">
            APIのベースURLを指定します。ローカル・LAN内の接続先やHTTPを使う場合は、サーバーの許可先（<code>AI_ALLOWED_ORIGINS</code>）へ登録してください。
          </p>
          <label for="ai-model">モデル名</label>
          <input
            id="ai-model"
            v-model="draft.model"
            type="text"
            maxlength="200"
            spellcheck="false"
          />
          <label for="ai-key-action"
            >APIキー（{{ settings?.hasApiKey ? "設定済み" : "未設定" }}）</label
          >
          <select id="ai-key-action" v-model="keyAction">
            <option value="keep">現在のキー設定を維持</option>
            <option value="replace">新しいキーに置換</option>
            <option value="clear">保存済みキーを削除</option>
          </select>
          <label v-if="keyAction === 'replace'" for="ai-api-key">新しいLLM APIキー</label>
          <input
            v-if="keyAction === 'replace'"
            id="ai-api-key"
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
          />
          <p class="hint">
            保存済みのキーは表示しません。キー不要のサービスでは、キーを未設定にして利用できます。
          </p>
          <div class="actions">
            <button type="button" @click="check">LLM接続確認</button>
          </div>
          <p class="hint">
            接続確認では指定したLLMへ試験要求を送信します。サービスの利用料金が発生する場合があります。
          </p>
        </div>

        <div class="admin-card settings-card">
          <h2>音声入力</h2>
          <label class="check-row" for="ai-speech-enabled">
            <input
              id="ai-speech-enabled"
              v-model="draft.speechEnabled"
              type="checkbox"
            />音声入力を有効にする
          </label>
          <p class="hint">
            録音を文字起こしし、ユーザーが編集してからチャットへ送信します。音声認識はLLMと別に設定します。
          </p>
          <fieldset class="speech-fields">
            <legend>文字起こしサービス（OpenAI互換API）</legend>
            <label for="ai-speech-base-url">接続先URL</label>
            <input
              id="ai-speech-base-url"
              v-model="draft.speechBaseUrl"
              type="url"
              maxlength="2048"
              spellcheck="false"
            />
            <label for="ai-speech-model">モデル名</label>
            <input
              id="ai-speech-model"
              v-model="draft.speechModel"
              type="text"
              maxlength="200"
              spellcheck="false"
            />
            <label for="ai-speech-key-action"
              >APIキー（{{ settings?.hasSpeechApiKey ? "設定済み" : "未設定" }}）</label
            >
            <select id="ai-speech-key-action" v-model="speechKeyAction">
              <option value="keep">現在のキー設定を維持</option>
              <option value="replace">新しいキーに置換</option>
              <option value="clear">保存済みキーを削除</option>
            </select>
            <label v-if="speechKeyAction === 'replace'" for="ai-speech-api-key"
              >新しい音声認識APIキー</label
            >
            <input
              v-if="speechKeyAction === 'replace'"
              id="ai-speech-api-key"
              v-model="speechApiKey"
              type="password"
              autocomplete="new-password"
            />
          </fieldset>
          <p class="hint">
            音声入力にはHTTPSまたはlocalhostと、端末のマイク利用許可が必要です。文字起こしの動作はチャット画面の録音で確認できます。
          </p>
        </div>

        <div class="admin-card settings-card">
          <h2>通信と出力の制限</h2>
          <div class="limits">
            <label for="ai-timeout"
              >タイムアウト（秒）
              <input
                id="ai-timeout"
                v-model.number="draft.timeoutSeconds"
                type="number"
                min="5"
                max="120"
                step="1"
              />
            </label>
            <label for="ai-max-output-tokens"
              >最大出力トークン数
              <input
                id="ai-max-output-tokens"
                v-model.number="draft.maxOutputTokens"
                type="number"
                min="128"
                max="8192"
                step="1"
              />
            </label>
            <label for="ai-max-requests"
              >ユーザーごとの要求上限（毎分）
              <input
                id="ai-max-requests"
                v-model.number="draft.maxRequestsPerMinute"
                type="number"
                min="1"
                max="60"
                step="1"
              />
            </label>
          </div>
        </div>
        <div class="actions save-actions">
          <button type="submit" class="button-primary">AI設定を保存</button>
        </div>
      </fieldset>
    </form>
    <p v-if="busy" role="status">処理しています…</p>
    <MessageModal :is-open="message !== ''" :message="message" @close="message = ''" />
  </section>
</template>

<style scoped>
.settings-fields,
.speech-fields {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.settings-card {
  margin: 16px 0;
  padding: 20px;
  overflow-wrap: anywhere;
}
h2 {
  margin: 0 0 12px;
  font-size: 1.15rem;
}
label {
  display: block;
  margin-top: 14px;
  font-weight: 600;
}
input:not([type="checkbox"]),
select {
  box-sizing: border-box;
  width: 100%;
  max-width: 44rem;
  margin-top: 5px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 0;
}
.check-row input {
  margin: 0;
}
.hint {
  margin: 7px 0;
  color: var(--admin-text-muted);
  font-size: 0.92rem;
}
.configuration-note {
  padding: 12px;
  border-left: 4px solid #b08126;
  background: var(--admin-panel, #fff);
}
.speech-fields {
  margin-top: 16px;
}
.speech-fields legend {
  font-weight: 600;
}
.limits {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 17rem));
  gap: 16px;
}
.limits label {
  margin-top: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.save-actions {
  margin-bottom: 24px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 600px) {
  .limits {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-card {
    padding: 16px;
  }
}
</style>
