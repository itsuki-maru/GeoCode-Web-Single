<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onMounted, reactive, ref } from "vue";
import apiClient from "@/axiosClient";
import MessageModal from "@/components/common/MessageModal.vue";
import { adminOsrmSettingsUrl } from "@/router/urls";

type Mode = "drive" | "walk";
type KeyAction = { action: "set"; apiKey: string } | { action: "clear" };
type ModeSettings = { baseUrl: string | null; hasApiKey: boolean; keyUsable: boolean };
type ModeUpdate = { baseUrl: string | null; key?: KeyAction };
type OsrmSettings = Record<Mode, ModeSettings> & {
  revision: string | null;
  keyStorageConfigured: boolean;
};
type CoordinateDraft = { lat: number | string; lng: number | string };

const modes = [
  { id: "drive", label: "車用", travelMode: "DRIVE" },
  { id: "walk", label: "徒歩用", travelMode: "WALK" },
] as const;
type Profile = (typeof modes)[number];
const points = [
  { id: "origin", label: "出発地" },
  { id: "destination", label: "目的地" },
] as const;

function newDraft() {
  return {
    baseUrl: "",
    action: "keep" as "keep" | KeyAction["action"],
    apiKey: "",
    origin: { lat: "", lng: "" } as CoordinateDraft,
    destination: { lat: "", lng: "" } as CoordinateDraft,
  };
}

const settings = ref<OsrmSettings>();
const drafts = reactive({ drive: newDraft(), walk: newDraft() });
const busy = ref(false);
const needsReload = ref(false);
const message = ref("");
const blocked = computed(() => busy.value || needsReload.value || !settings.value);

function keyStatus(state: ModeSettings) {
  if (!state.hasApiKey) return "キーなし";
  if (!state.baseUrl) return "設定済み・接続先未登録";
  return state.keyUsable ? "設定済み" : "設定済み・利用不可";
}

function resetKeyDraft(mode: Mode) {
  drafts[mode].action = "keep";
  drafts[mode].apiKey = "";
}

function receiveSettings(next: OsrmSettings, updatedMode?: Mode) {
  const previous = settings.value;
  for (const { id } of modes) {
    if (id === updatedMode || !previous || drafts[id].baseUrl === (previous[id].baseUrl ?? "")) {
      drafts[id].baseUrl = next[id].baseUrl ?? "";
    }
  }
  settings.value = next;
  needsReload.value = false;
}

async function run(
  fallback: string,
  action: () => Promise<void>,
  { showValidationError = false } = {},
) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await action();
  } catch (error) {
    const response = isAxiosError<{ error?: unknown }>(error) ? error.response : undefined;
    const status = response?.status;
    if (!settings.value) needsReload.value = true;
    if (status === 409 || status === 401 || status === 403) {
      needsReload.value = true;
      resetKeyDraft("drive");
      resetKeyDraft("walk");
      message.value =
        status === 409
          ? "別の操作で設定が更新されました。最新の設定を取得してから再試行してください。"
          : "OSRM設定を操作するには管理者権限が必要です。";
    } else if (status === 429) {
      message.value = "接続確認の利用上限に達しました。時間をおいて再試行してください。";
    } else {
      const detail = response?.data?.error;
      message.value =
        showValidationError && status === 400 && typeof detail === "string" && detail.trim()
          ? detail
          : fallback;
    }
  } finally {
    busy.value = false;
  }
}

async function load() {
  await run("OSRM設定を取得できませんでした。", async () => {
    receiveSettings((await apiClient.get<OsrmSettings>(adminOsrmSettingsUrl)).data);
  });
}

function keyAction(mode: Mode): KeyAction | undefined {
  const { action, apiKey } = drafts[mode];
  if (action === "keep") return;
  if (action === "clear") return { action };
  if (apiKey.trim() !== apiKey || !/^[\x20-\x7e]{1,4096}$/.test(apiKey)) {
    message.value =
      "APIキーは先頭と末尾に空白のない半角英数字・記号で、1〜4096文字を入力してください。";
    return;
  }
  return { action, apiKey };
}

function candidate(mode: Mode): (ModeUpdate & { baseUrl: string }) | undefined {
  const draft = drafts[mode];
  const baseUrl = draft.baseUrl.trim();
  try {
    const parsed = new URL(baseUrl);
    if (
      !/^https?:\/\/[^/]/i.test(baseUrl) ||
      /[\s\\?#]/u.test(baseUrl) ||
      baseUrl.split("/")[2]?.includes("@") ||
      parsed.port === "0" ||
      new TextEncoder().encode(baseUrl).length > 4096
    ) {
      throw new Error();
    }
  } catch {
    message.value =
      "認証情報、クエリ、フラグメントを含まないHTTP(S)のベースURLを入力してください。";
    return;
  }
  const key = keyAction(mode);
  if (draft.action === "set" && !key) return;
  return { baseUrl, ...(key ? { key } : {}) };
}

function canCheck(mode: Mode) {
  const state = settings.value?.[mode];
  return (
    !!state &&
    drafts[mode].baseUrl.trim() !== "" &&
    (mode === "drive" || !!settings.value?.drive.baseUrl) &&
    (drafts[mode].action !== "keep" || !state.hasApiKey || !state.baseUrl || state.keyUsable)
  );
}

function canSave(mode: Mode) {
  return (
    canCheck(mode) &&
    (drafts[mode].action !== "set" || settings.value?.keyStorageConfigured === true)
  );
}

function canDisable(mode: Mode) {
  const state = settings.value?.[mode];
  return (
    !!(state?.baseUrl || state?.hasApiKey) && (mode === "walk" || !settings.value?.walk.baseUrl)
  );
}

async function update(mode: Profile, change: ModeUpdate, resultMessage: string) {
  if (blocked.value || !settings.value) return;
  const revision = settings.value.revision;
  await run(
    "OSRMの設定を更新できませんでした。時間をおいて再試行してください。",
    async () => {
      const { data } = await apiClient.put<OsrmSettings>(adminOsrmSettingsUrl, {
        revision,
        [mode.id]: change,
      });
      receiveSettings(data, mode.id);
      resetKeyDraft(mode.id);
      message.value = mode.label + "OSRM" + resultMessage;
    },
    { showValidationError: true },
  );
}

async function save(mode: Profile) {
  if (blocked.value || !canSave(mode.id)) return;
  const change = candidate(mode.id);
  if (!change) return;
  await update(mode, change, "の設定を保存しました。地図を開き直すと反映されます。");
}

async function disable(mode: Profile) {
  if (blocked.value || !canDisable(mode.id)) return;
  await update(mode, { baseUrl: null }, "を無効にしました。地図を開き直すと反映されます。");
}

function coordinate({ lat, lng }: CoordinateDraft) {
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    Math.abs(lng) > 180
  ) {
    return;
  }
  return { lat, lng };
}

async function check(mode: Profile) {
  if (blocked.value || !settings.value || !canCheck(mode.id)) return;
  const change = candidate(mode.id);
  if (!change) return;
  const draft = drafts[mode.id];
  const origin = coordinate(draft.origin);
  const destination = coordinate(draft.destination);
  if (!origin || !destination) {
    message.value = "出発地と目的地の緯度は−90〜90、経度は−180〜180で入力してください。";
    return;
  }
  const revision = settings.value.revision;
  await run(
    "OSRMの接続を確認できませんでした。接続先とネットワークを確認してください。",
    async () => {
      const { data } = await apiClient.post<{ routeFound: boolean }>(
        adminOsrmSettingsUrl + "/check",
        {
          revision,
          travelMode: mode.travelMode,
          ...change,
          origin,
          destination,
        },
      );
      message.value =
        mode.label +
        "OSRMに接続できました。" +
        (data.routeFound
          ? "指定した地点間の経路を取得しました。"
          : "経路が見つかりませんでした。配信範囲内の地点を指定してください。");
    },
    { showValidationError: true },
  );
}

onMounted(load);
</script>

<template>
  <section class="page-shell" aria-labelledby="osrm-settings-title">
    <div class="page-heading">
      <h1 id="osrm-settings-title">OSRM設定</h1>
    </div>
    <p>Google Maps以外の背景地図で使うOSRMの接続先を設定します。</p>
    <p class="hint">
      HTTPまたは非公開ネットワークに接続する場合は、サーバーの許可先（<code>OSRM_ALLOWED_ORIGINS</code>）にオリジンを追加してください。
    </p>
    <button v-if="needsReload" type="button" :disabled="busy" @click="load">
      最新の設定を取得
    </button>
    <p v-if="settings && !settings.keyStorageConfigured">
      APIキーを保存するには、サーバーに暗号鍵（<code>OSRM_ENCRYPTION_KEY</code>）を設定してください。
    </p>
    <template v-if="settings">
      <section
        v-for="mode in modes"
        :key="mode.id"
        class="admin-card settings-card"
        :aria-labelledby="'osrm-' + mode.id + '-title'"
      >
        <h2 :id="'osrm-' + mode.id + '-title'">{{ mode.label }}OSRM</h2>
        <dl class="effective-settings">
          <dt>現在の接続先</dt>
          <dd>{{ settings[mode.id].baseUrl ?? "未設定" }}</dd>
          <dt>APIキー</dt>
          <dd>{{ keyStatus(settings[mode.id]) }}</dd>
        </dl>
        <p v-if="mode.id === 'walk'" class="hint">
          車用OSRMを設定してから、車用とは別の接続先を指定してください。
        </p>
        <p v-if="settings[mode.id].hasApiKey && !settings[mode.id].baseUrl" class="hint">
          保存済みのキーを維持するには、これまで使っていたベースURLを入力してください。
        </p>
        <p v-else-if="settings[mode.id].hasApiKey && !settings[mode.id].keyUsable" class="hint">
          保存済みのキーを利用できません。キーを更新するか、キーなしで接続を確認してください。
        </p>
        <form :aria-label="mode.label + 'OSRMの接続設定'" novalidate @submit.prevent="save(mode)">
          <fieldset :disabled="blocked">
            <label :for="'osrm-' + mode.id + '-url'">ベースURL</label>
            <input
              :id="'osrm-' + mode.id + '-url'"
              v-model="drafts[mode.id].baseUrl"
              type="url"
              maxlength="4096"
              required
              autocomplete="off"
              spellcheck="false"
            />
            <label :for="'osrm-' + mode.id + '-key-action'">APIキーの操作</label>
            <select
              :id="'osrm-' + mode.id + '-key-action'"
              v-model="drafts[mode.id].action"
              @change="drafts[mode.id].apiKey = ''"
            >
              <option value="keep">
                {{ settings[mode.id].hasApiKey ? "保存済みのキーを維持" : "キーなしで使う" }}
              </option>
              <option value="set">新しいキーを入力</option>
              <option value="clear" :disabled="!settings[mode.id].hasApiKey">
                キーなしで使う（保存済みのキーを削除）
              </option>
            </select>
            <p v-if="settings[mode.id].hasApiKey && settings[mode.id].baseUrl" class="hint">
              接続先を変更するときは、新しいキーを入力するか、キーなしを選んでください。
            </p>
            <template v-if="drafts[mode.id].action === 'set'">
              <label :for="'osrm-' + mode.id + '-api-key'">新しいAPIキー</label>
              <input
                :id="'osrm-' + mode.id + '-api-key'"
                v-model="drafts[mode.id].apiKey"
                type="password"
                autocomplete="new-password"
                maxlength="4096"
              />
            </template>
            <div class="actions">
              <button type="submit" class="button-primary" :disabled="!canSave(mode.id)">
                設定を保存
              </button>
              <button
                v-if="settings[mode.id].baseUrl || settings[mode.id].hasApiKey"
                type="button"
                :disabled="!canDisable(mode.id)"
                @click="disable(mode)"
              >
                {{ settings[mode.id].baseUrl ? "無効にする" : "保存済みのAPIキーを削除" }}
              </button>
            </div>
            <p v-if="mode.id === 'drive' && settings.walk.baseUrl" class="hint">
              車用OSRMを無効にするには、先に徒歩用OSRMを無効にしてください。
            </p>
            <p v-else-if="settings[mode.id].baseUrl && settings[mode.id].hasApiKey" class="hint">
              接続先を無効にすると、保存済みのAPIキーも削除されます。
            </p>
          </fieldset>
        </form>
        <form :aria-label="mode.label + 'OSRMの接続確認'" novalidate @submit.prevent="check(mode)">
          <fieldset class="coordinates" :disabled="blocked || !canCheck(mode.id)">
            <legend>接続確認</legend>
            <p class="hint">
              配信範囲内の2地点を10進度で入力します。入力中のURLとAPIキーで接続を確認します。
            </p>
            <div v-for="point in points" :key="point.id" class="coordinate-inputs">
              <label>
                {{ point.label }}の緯度
                <input
                  :id="'osrm-' + mode.id + '-' + point.id + '-lat'"
                  v-model.number="drafts[mode.id][point.id].lat"
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  inputmode="decimal"
                />
              </label>
              <label>
                {{ point.label }}の経度
                <input
                  :id="'osrm-' + mode.id + '-' + point.id + '-lng'"
                  v-model.number="drafts[mode.id][point.id].lng"
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  inputmode="decimal"
                />
              </label>
            </div>
            <div class="actions">
              <button type="submit">接続確認</button>
            </div>
          </fieldset>
        </form>
      </section>
    </template>
    <MessageModal :is-open="message !== ''" :message="message" @close="message = ''" />
  </section>
</template>

<style scoped>
.settings-card {
  margin: 16px 0;
  padding: 16px;
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
.effective-settings dt,
legend {
  font-weight: 600;
}
.effective-settings dd {
  margin: 0;
  overflow-wrap: anywhere;
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
label {
  display: block;
  margin-top: 8px;
}
input,
select {
  box-sizing: border-box;
  width: 100%;
  margin-top: 4px;
}
.hint {
  margin: 6px 0;
  color: var(--admin-text-muted);
}
.coordinates {
  margin-top: 16px;
}
.coordinate-inputs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 12rem));
  gap: 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
