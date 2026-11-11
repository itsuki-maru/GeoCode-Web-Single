<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import { adminTileServerSettingsUrl } from "@/router/urls";

type SettingSource = "environment" | "managed";
type TileServerSettings = {
  revision: string | null;
  proxy: { source: SettingSource; baseUrl: string | null; hasApiKey: boolean };
  vectorOrigins: { source: SettingSource; origins: string[] };
  keyStorageConfigured: boolean;
};
type ManagedProxyInput = {
  revision: string | null;
  mode: "managed";
  baseUrl: string;
  apiKey?: string;
  tile: { z: number; x: number; y: number };
};

const settings = ref<TileServerSettings | null>(null);
const baseUrl = ref("");
const apiKey = ref("");
const z = ref<number | string>(14);
const x = ref<number | string>(14552);
const y = ref<number | string>(6451);
const originsText = ref("");
const busy = ref(false);
const needsReload = ref(false);
const message = ref("");
const blocked = computed(() => busy.value || !settings.value || needsReload.value);
const savedOrigins = computed(() => settings.value?.vectorOrigins.origins.join("\n") ?? "");
const canKeepKey = computed(
  () => settings.value?.proxy.hasApiKey && baseUrl.value.trim() === settings.value.proxy.baseUrl,
);
const missingTile = "確認座標のPNGタイルが見つかりません。配信範囲内の座標を指定してください。";

function sourceLabel(source: SettingSource) {
  return source === "managed" ? "管理画面" : "環境変数";
}

function receiveSettings(
  next: TileServerSettings,
  keepProxyDraft = false,
  keepOriginsDraft = false,
) {
  if (!keepProxyDraft) {
    baseUrl.value = next.proxy.baseUrl ?? "";
    apiKey.value = "";
  }
  if (!keepOriginsDraft) originsText.value = next.vectorOrigins.origins.join("\n");
  settings.value = next;
  needsReload.value = false;
}

async function run(action: () => Promise<void>, failureMessage: string, notFoundMessage?: string) {
  if (busy.value) return;
  message.value = "";
  busy.value = true;
  try {
    await action();
  } catch (failure) {
    if (!settings.value) needsReload.value = true;
    const status = isAxiosError(failure) ? failure.response?.status : undefined;
    if (status === 409) {
      needsReload.value = true;
      apiKey.value = "";
      message.value =
        "別の操作で設定が更新されました。最新の設定を取得してから再試行してください。";
    } else if (status === 401 || status === 403) {
      needsReload.value = true;
      apiKey.value = "";
      message.value = "タイルサーバ設定を操作するには管理者権限が必要です。";
    } else if (status === 404 && notFoundMessage) {
      message.value = notFoundMessage;
    } else {
      message.value = failureMessage;
    }
  } finally {
    busy.value = false;
  }
}

async function load() {
  await run(async () => {
    const previous = settings.value;
    const reloading = needsReload.value || previous !== null;
    const keepProxyDraft = previous !== null && baseUrl.value !== (previous.proxy.baseUrl ?? "");
    const keepOriginsDraft = previous !== null && originsText.value !== savedOrigins.value;
    const { data } = await apiClient.get<TileServerSettings>(adminTileServerSettingsUrl);
    receiveSettings(data, keepProxyDraft, keepOriginsDraft);
    if (reloading) message.value = "最新の設定を取得しました。入力内容を確認してください。";
  }, "タイルサーバ設定を取得できませんでした。");
}

function managedProxyInput(): ManagedProxyInput | undefined {
  if (blocked.value || !settings.value?.keyStorageConfigured) return;
  const url = baseUrl.value.trim();
  try {
    const parsed = new URL(url);
    if (!/^https?:\/\//i.test(url) || /[\s\\?#@]/u.test(url) || parsed.username || parsed.password)
      throw new Error();
  } catch {
    message.value =
      "認証情報、クエリ、フラグメントを含まないHTTP(S)のベースURLを入力してください。";
    return;
  }
  if ((!apiKey.value && !canKeepKey.value) || (apiKey.value && !apiKey.value.trim())) {
    message.value = "上流へ送信するAPIキーを入力してください。";
    return;
  }
  const [zoom, column, row] = [z.value, x.value, y.value];
  if (
    typeof zoom !== "number" ||
    !Number.isInteger(zoom) ||
    zoom < 0 ||
    zoom > 19 ||
    typeof column !== "number" ||
    !Number.isInteger(column) ||
    column < 0 ||
    column >= 2 ** zoom ||
    typeof row !== "number" ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= 2 ** zoom
  ) {
    message.value = "確認座標は整数で、ズームは0〜19、XとYは0以上で2のズーム乗未満にしてください。";
    return;
  }
  return {
    revision: settings.value.revision,
    mode: "managed",
    baseUrl: url,
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
    tile: { z: zoom, x: column, y: row },
  };
}

async function checkProxy() {
  const input = managedProxyInput();
  if (!input) return;
  await run(
    async () => {
      const { data } = await apiClient.post<{ ok: boolean }>(
        `${adminTileServerSettingsUrl}/proxy/check`,
        input,
      );
      if (!data.ok) throw new Error();
      message.value = "確認座標のPNGタイルを取得できました。";
    },
    "接続を確認できませんでした。URL、APIキー、確認座標を確認してください。",
    missingTile,
  );
}

async function applyProxy(mode: SettingSource) {
  if (blocked.value || !settings.value) return;
  const input =
    mode === "managed"
      ? managedProxyInput()
      : { revision: settings.value.revision, mode: "environment" };
  if (!input) return;
  await run(
    async () => {
      const keepOriginsDraft = originsText.value !== savedOrigins.value;
      const { data } = await apiClient.put<TileServerSettings>(
        `${adminTileServerSettingsUrl}/proxy`,
        input,
      );
      receiveSettings(data, false, keepOriginsDraft);
      message.value =
        mode === "managed"
          ? "中継設定を適用しました。地図を開き直してください。"
          : "中継を環境変数の設定に戻しました。地図を開き直してください。";
    },
    "中継設定を適用できませんでした。URL、APIキー、確認座標を確認してください。",
    mode === "managed" ? missingTile : undefined,
  );
}

function parseOrigins(value: string): string[] {
  const origins = new Set<string>();
  for (const entry of value.split(/[\n,]/u)) {
    const raw = entry.trim();
    if (!raw) continue;
    if (!/^https:\/\/[^/\s*'"\\?#@]+\/?$/iu.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!url.hostname) throw new Error();
    origins.add(url.origin);
  }
  return [...origins];
}

async function applyOrigins(useEnvironment: boolean) {
  if (blocked.value || !settings.value) return;
  let origins: string[] | null = null;
  if (!useEnvironment) {
    try {
      origins = parseOrigins(originsText.value);
    } catch {
      message.value =
        "HTTPSオリジンを入力してください。ワイルドカード、パス、クエリは指定できません。";
      return;
    }
  }
  const revision = settings.value.revision;
  await run(async () => {
    const { data } = await apiClient.put<TileServerSettings>(
      `${adminTileServerSettingsUrl}/vector-origins`,
      { revision, origins },
    );
    receiveSettings(data, true);
    message.value = useEnvironment
      ? "接続許可先を環境変数の設定に戻しました。地図を開き直してください。"
      : "接続許可先を適用しました。地図を開き直してください。";
  }, "接続許可先を適用できませんでした。入力を確認して再試行してください。");
}

onMounted(load);
</script>

<template>
  <section class="page-shell" aria-labelledby="tile-server-settings-title">
    <div class="page-heading">
      <h1 id="tile-server-settings-title">タイルサーバ設定</h1>
    </div>
    <button v-if="needsReload" type="button" :disabled="busy" @click="load">
      最新の設定を取得
    </button>

    <form class="admin-card settings-card" novalidate @submit.prevent="applyProxy('managed')">
      <h2>ラスタタイルの中継</h2>
      <dl v-if="settings" class="effective-settings">
        <dt>設定元</dt>
        <dd>{{ sourceLabel(settings.proxy.source) }}</dd>
        <dt>現在の上流URL</dt>
        <dd>{{ settings.proxy.baseUrl ?? "未設定" }}</dd>
        <dt>APIキー</dt>
        <dd>{{ settings.proxy.hasApiKey ? "設定済み" : "未設定" }}</dd>
      </dl>
      <p v-if="settings && !settings.keyStorageConfigured">
        管理画面から中継を設定するには、サーバーに暗号鍵（<code>TILE_SETTINGS_ENCRYPTION_KEY</code>）を設定してください。
      </p>
      <fieldset :disabled="blocked || !settings?.keyStorageConfigured">
        <legend>上流サーバ</legend>
        <label for="tile-proxy-url">ベースURL</label>
        <input
          id="tile-proxy-url"
          v-model="baseUrl"
          type="url"
          required
          aria-describedby="tile-proxy-url-help"
        />
        <p id="tile-proxy-url-help" class="hint">
          公開HTTPSのURLを使用できます。HTTPまたは非公開ネットワークに接続する場合は、サーバーの許可先（<code>TILE_PROXY_ALLOWED_ORIGINS</code>）にオリジンを追加してください。
        </p>
        <label for="tile-proxy-api-key">APIキー</label>
        <input
          id="tile-proxy-api-key"
          v-model="apiKey"
          type="password"
          autocomplete="new-password"
          aria-describedby="tile-proxy-api-key-help"
        />
        <p id="tile-proxy-api-key-help" class="hint">
          {{
            canKeepKey
              ? "空欄で現在のキーを使用します。"
              : "上流サーバに送信するキーを入力してください。"
          }}
        </p>
        <fieldset class="coordinates" aria-describedby="tile-proxy-coordinates-help">
          <legend>確認用のタイル座標</legend>
          <div class="coordinate-inputs">
            <label
              >ズーム（Z）<input
                id="tile-proxy-z"
                v-model.number="z"
                type="number"
                min="0"
                max="19"
                step="1"
                required
            /></label>
            <label
              >X<input id="tile-proxy-x" v-model.number="x" type="number" min="0" step="1" required
            /></label>
            <label
              >Y<input id="tile-proxy-y" v-model.number="y" type="number" min="0" step="1" required
            /></label>
          </div>
          <p id="tile-proxy-coordinates-help" class="hint">
            上流サーバがPNGタイルを配信している座標を指定してください。
          </p>
        </fieldset>
        <div class="actions">
          <button type="button" @click="checkProxy">接続確認</button>
          <button type="submit" class="button-primary">中継設定を適用</button>
        </div>
      </fieldset>
      <button
        v-if="settings?.proxy.source === 'managed'"
        class="restore-button"
        type="button"
        :disabled="blocked"
        @click="applyProxy('environment')"
      >
        中継を環境変数に戻す
      </button>
    </form>

    <form class="admin-card settings-card" @submit.prevent="applyOrigins(false)">
      <h2>ベクタ配信元の接続許可</h2>
      <p v-if="settings">設定元 {{ sourceLabel(settings.vectorOrigins.source) }}</p>
      <fieldset :disabled="blocked">
        <legend>許可するHTTPSオリジン</legend>
        <label for="vector-tile-origins" class="hint">
          スタイル、タイル、文字、アイコンの配信元を改行またはカンマ区切りで入力してください。空欄で追加の許可先を解除します。
        </label>
        <textarea id="vector-tile-origins" v-model="originsText" rows="4" spellcheck="false" />
        <details v-if="settings && savedOrigins !== originsText">
          <summary>現在の許可先</summary>
          <ul v-if="settings.vectorOrigins.origins.length">
            <li v-for="origin in settings.vectorOrigins.origins" :key="origin">{{ origin }}</li>
          </ul>
          <p v-else>追加の許可先なし</p>
        </details>
        <div class="actions">
          <button type="submit" class="button-primary">接続許可先を適用</button>
          <button
            v-if="settings?.vectorOrigins.source === 'managed'"
            type="button"
            @click="applyOrigins(true)"
          >
            接続許可先を環境変数に戻す
          </button>
        </div>
      </fieldset>
    </form>
    <MessageModal :is-open="message !== ''" :message="message" @close="message = ''" />
  </section>
</template>

<style scoped>
.settings-card {
  margin: 16px 0;
  padding: 16px;
  overflow-wrap: anywhere;
}
h2 {
  margin-top: 0;
  font-size: 1.15rem;
}
.effective-settings {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 12px;
}
.effective-settings dt {
  font-weight: 600;
}
.effective-settings dd {
  margin: 0;
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 8px;
  font-weight: 600;
}
label {
  display: block;
  margin-top: 8px;
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  margin-top: 4px;
}
textarea {
  resize: vertical;
}
.hint {
  margin: 6px 0;
  color: var(--admin-text-muted);
}
.coordinates {
  margin-top: 14px;
}
.coordinate-inputs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 8rem));
  gap: 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.restore-button {
  margin-top: 12px;
}
</style>
