<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import apiClient from "@/axiosClient";
import { adminLiveLocationsUrl, adminLiveMapsUrl } from "@/router/urls";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";

type LiveAccount = {
  user_id: string;
  username: string;
  can_share_live_location: boolean;
  received_at: string | null;
};

type LiveMap = {
  id: string;
  name: string;
  expires_at: string;
  revoked_at: string | null;
  member_count: number;
  share_url: string;
  is_password_protected: boolean;
  members: Array<{ user_id: string; display_name: string; marker_color: string }>;
};

type ConfirmAction = "rotate" | "revoke" | null;

const palette = ["#1a73e8", "#cf222e", "#1a7f37", "#9a6700", "#8250df", "#bf3989"];
const MAX_LIVE_MAP_MEMBERS = 20;
const accounts = ref<LiveAccount[]>([]);
const currentMap = ref<LiveMap | null>(null);
const selected = ref(new Set<string>());
const displayNames = ref<Record<string, string>>({});
const markerColors = ref<Record<string, string>>({});
const mapName = ref("現在位置共有マップ");
const expiresAt = ref("");
const generatedUrl = ref("");
const passwordProtected = ref(false);
const sharePassword = ref("");
const message = ref("");
const isLoading = ref(true);
const isSaving = ref(false);
const confirmAction = ref<ConfirmAction>(null);

const hasCurrentMap = computed(() => currentMap.value !== null);
const selectedCount = computed(() => selected.value.size);
const confirmTitle = computed(() =>
  confirmAction.value === "revoke" ? "共有リンクを失効" : "共有URLを再発行",
);
const confirmMessage = computed(() =>
  confirmAction.value === "revoke"
    ? "現在の共有リンクを失効します。この操作は取り消せません。"
    : "現在の共有リンクを無効にして、新しいリンクを発行します。",
);

const setMessage = (text: string) => {
  message.value = text;
};

const closeMessage = () => {
  message.value = "";
};

function defaultExpiration(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localDateTime(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function accountStatus(account: LiveAccount): string {
  if (!account.received_at) return "未共有";
  const age = (Date.now() - new Date(account.received_at).getTime()) / 1000;
  return age <= 20 ? "共有中" : age <= 120 ? "更新遅延" : "オフライン";
}

function accountStatusClass(account: LiveAccount): string {
  const status = accountStatus(account);
  if (status === "共有中") return "is-live";
  if (status === "更新遅延") return "is-delayed";
  if (status === "オフライン") return "is-offline";
  return "is-idle";
}

async function load() {
  isLoading.value = true;
  try {
    const [locationResponse, mapResponse] = await Promise.all([
      apiClient.get(adminLiveLocationsUrl),
      apiClient.get(adminLiveMapsUrl),
    ]);
    accounts.value = locationResponse.data;
    currentMap.value = mapResponse.data[0] ?? null;
    displayNames.value = {};
    markerColors.value = {};
    accounts.value.forEach((account, index) => {
      displayNames.value[account.user_id] = account.username;
      markerColors.value[account.user_id] = palette[index % palette.length]!;
    });

    if (currentMap.value) {
      mapName.value = currentMap.value.name;
      expiresAt.value = localDateTime(currentMap.value.expires_at);
      selected.value = new Set(currentMap.value.members.map((member) => member.user_id));
      currentMap.value.members.forEach((member) => {
        displayNames.value[member.user_id] = member.display_name;
        markerColors.value[member.user_id] = member.marker_color;
      });
      generatedUrl.value = new URL(currentMap.value.share_url, window.location.origin).href;
      passwordProtected.value = currentMap.value.is_password_protected;
      sharePassword.value = "";
    } else {
      mapName.value = "現在位置共有マップ";
      expiresAt.value = defaultExpiration();
      selected.value = new Set(
        accounts.value.slice(0, MAX_LIVE_MAP_MEMBERS).map((account) => account.user_id),
      );
      generatedUrl.value = "";
      passwordProtected.value = false;
      sharePassword.value = "";
    }
  } catch {
    setMessage("現在位置共有データを取得できませんでした。");
  } finally {
    isLoading.value = false;
  }
}

function toggleMember(userId: string, checked: boolean) {
  const next = new Set(selected.value);
  if (checked && !next.has(userId) && next.size >= MAX_LIVE_MAP_MEMBERS) {
    setMessage(`共有対象は最大${MAX_LIVE_MAP_MEMBERS}件まで選択できます。`);
    return;
  }
  checked ? next.add(userId) : next.delete(userId);
  selected.value = next;
}

async function saveMap() {
  message.value = "";
  if (!currentMap.value) generatedUrl.value = "";
  const members = accounts.value
    .filter((account) => selected.value.has(account.user_id))
    .map((account, index) => ({
      user_id: account.user_id,
      display_name: displayNames.value[account.user_id],
      marker_color: markerColors.value[account.user_id] ?? palette[index % palette.length]!,
    }));

  if (!mapName.value.trim() || !expiresAt.value || members.length === 0) {
    setMessage("地図名、有効期限、1件以上の共有対象を指定してください。");
    return;
  }
  if (members.length > MAX_LIVE_MAP_MEMBERS) {
    setMessage(`共有対象は最大${MAX_LIVE_MAP_MEMBERS}件まで選択できます。`);
    return;
  }
  if (
    passwordProtected.value &&
    !currentMap.value?.is_password_protected &&
    sharePassword.value.trim().length < 4
  ) {
    setMessage("共有パスワードは4文字以上で入力してください。");
    return;
  }

  const passwordAction = !passwordProtected.value
    ? "remove"
    : sharePassword.value.trim()
      ? "set"
      : "keep";
  const payload = {
    name: mapName.value,
    expires_at: new Date(expiresAt.value).toISOString(),
    members,
    password_action: passwordAction,
    share_password: passwordAction === "set" ? sharePassword.value : null,
  };

  isSaving.value = true;
  try {
    if (currentMap.value) {
      await apiClient.put(`${adminLiveMapsUrl}/${currentMap.value.id}`, payload);
      setMessage("共有マップを更新しました。現在の共有URLは引き続き利用できます。");
    } else {
      const response = await apiClient.post(adminLiveMapsUrl, payload);
      generatedUrl.value = new URL(response.data.share_url, window.location.origin).href;
      setMessage("共有マップを作成しました。共有URLはこの画面でいつでも確認できます。");
    }
    sharePassword.value = "";
    await load();
  } catch (error: any) {
    setMessage(
      error?.response?.status === 409
        ? "共有マップはすでに発行されています。画面を再読み込みしてください。"
        : (error?.response?.data?.error ?? "共有マップを保存できませんでした。"),
    );
  } finally {
    isSaving.value = false;
  }
}

async function revokeMap() {
  if (!currentMap.value) return;
  try {
    await apiClient.delete(`${adminLiveMapsUrl}/${currentMap.value.id}`);
    generatedUrl.value = "";
    setMessage("共有リンクを失効しました。");
    await load();
  } catch {
    setMessage("共有リンクを失効できませんでした。");
  }
}

async function rotateUrl() {
  if (!currentMap.value) return;
  try {
    const response = await apiClient.post(`${adminLiveMapsUrl}/${currentMap.value.id}/rotate-url`);
    generatedUrl.value = new URL(response.data.share_url, window.location.origin).href;
    setMessage("新しい共有リンクを発行しました。");
  } catch {
    setMessage("共有リンクを再発行できませんでした。");
  }
}

async function executeConfirmedAction() {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (action === "revoke") await revokeMap();
  if (action === "rotate") await rotateUrl();
}

function openUrl() {
  if (generatedUrl.value) window.open(generatedUrl.value, "_blank", "noopener,noreferrer");
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(generatedUrl.value);
    setMessage("共有URLをコピーしました。");
  } catch {
    setMessage("コピーできませんでした。URL欄から手動でコピーしてください。");
  }
}

onMounted(load);
</script>

<template>
  <main class="page-shell live-admin" aria-labelledby="live-map-title">
    <div class="page-heading">
      <div>
        <h1 id="live-map-title">現在位置共有マップ</h1>
        <p class="page-description">共有するアカウントと公開リンクの有効期限を管理します。</p>
      </div>
      <span v-if="hasCurrentMap" class="map-state">共有マップ発行済み</span>
    </div>

    <section class="admin-card accounts-card" aria-labelledby="accounts-title">
      <div class="card-heading">
        <div>
          <h2 id="accounts-title">共有許可済みアカウント</h2>
          <p>公開対象と、地図上に表示する名称・色を設定します。</p>
        </div>
        <span>{{ selectedCount }} / 最大{{ MAX_LIVE_MAP_MEMBERS }}件を選択</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>対象</th>
              <th>アカウント</th>
              <th>公開表示名</th>
              <th>色</th>
              <th>状態</th>
              <th>最終受信</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in accounts" :key="account.user_id">
              <td>
                <input
                  type="checkbox"
                  :checked="selected.has(account.user_id)"
                  :disabled="
                    !selected.has(account.user_id) && selectedCount >= MAX_LIVE_MAP_MEMBERS
                  "
                  :aria-label="`${account.username}を共有対象にする`"
                  @change="
                    toggleMember(account.user_id, ($event.target as HTMLInputElement).checked)
                  "
                />
              </td>
              <td class="account-name">{{ account.username }}</td>
              <td>
                <label>
                  <span class="sr-only">{{ account.username }}の公開表示名</span>
                  <input v-model="displayNames[account.user_id]" maxlength="100" />
                </label>
              </td>
              <td>
                <label class="color-control">
                  <input
                    v-model="markerColors[account.user_id]"
                    type="color"
                    :aria-label="`${account.username}のマーカー色`"
                  />
                </label>
              </td>
              <td>
                <span class="status-badge" :class="accountStatusClass(account)">
                  {{ accountStatus(account) }}
                </span>
              </td>
              <td class="received-at">
                {{
                  account.received_at ? new Date(account.received_at).toLocaleString("ja-JP") : "-"
                }}
              </td>
            </tr>
            <tr v-if="!isLoading && accounts.length === 0">
              <td colspan="6" class="empty-state">
                位置共有を許可されたアカウントはありません。ユーザー管理から許可を設定してください。
              </td>
            </tr>
            <tr v-if="isLoading && accounts.length === 0">
              <td colspan="6" class="empty-state">アカウントを読み込んでいます…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card form" aria-labelledby="map-settings-title">
      <div class="card-heading settings-heading">
        <div>
          <h2 id="map-settings-title">
            {{ hasCurrentMap ? "現在の共有マップを編集" : "共有マップを作成" }}
          </h2>
          <p v-if="hasCurrentMap">このアプリケーションで発行できる共有マップは1件です。</p>
          <p v-else>設定を保存すると、外部へ案内できる共有URLが発行されます。</p>
        </div>
      </div>

      <div class="settings-body">
        <div class="settings-grid">
          <label class="field">
            <span class="field-label">地図名</span>
            <input v-model="mapName" maxlength="100" />
          </label>
          <label class="field">
            <span class="field-label">有効期限</span>
            <input v-model="expiresAt" type="datetime-local" />
          </label>
        </div>

        <div class="security-panel">
          <label class="password-toggle">
            <input v-model="passwordProtected" type="checkbox" />
            <span>
              <strong>パスワードで保護する</strong>
              <small>共有URLを開く際にパスワードの入力を求めます。</small>
            </span>
          </label>
          <label v-if="passwordProtected" class="field password-field">
            <span class="field-label">
              {{
                currentMap?.is_password_protected
                  ? "新しい共有パスワード（空欄で現在の設定を維持）"
                  : "共有パスワード"
              }}
            </span>
            <input
              v-model="sharePassword"
              type="password"
              minlength="4"
              maxlength="64"
              autocomplete="new-password"
            />
          </label>
        </div>

        <div v-if="generatedUrl" class="generated">
          <label class="field generated-field">
            <span class="field-label">現在の共有URL</span>
            <input :value="generatedUrl" aria-label="現在の共有URL" readonly />
          </label>
          <button type="button" class="button-secondary" @click="copyUrl">コピー</button>
          <button type="button" class="button-secondary" @click="openUrl">開く</button>
        </div>

        <div class="form-actions">
          <div class="destructive-actions">
            <button
              v-if="currentMap"
              type="button"
              class="button-secondary"
              @click="confirmAction = 'rotate'"
            >
              共有URLを再発行
            </button>
            <button
              v-if="currentMap"
              type="button"
              class="button-danger"
              @click="confirmAction = 'revoke'"
            >
              共有リンクを失効
            </button>
          </div>
          <button
            type="button"
            class="button-primary save-button"
            :disabled="isSaving"
            @click="saveMap"
          >
            {{ isSaving ? "保存中…" : hasCurrentMap ? "設定を更新" : "共有リンクを発行" }}
          </button>
        </div>
      </div>
    </section>

    <ConfirmModal
      :is-open="confirmAction !== null"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmAction === 'revoke' ? '失効する' : '再発行する'"
      :danger="confirmAction === 'revoke'"
      @cancel="confirmAction = null"
      @confirm="executeConfirmedAction"
    />
    <MessageModal :is-open="message !== ''" :message="message" @close="closeMessage" />
  </main>
</template>

<style scoped>
.map-state {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 999px;
  color: #176b4d;
  background: #e2f2ea;
  font-size: 0.8rem;
  font-weight: 700;
}
.accounts-card,
.form {
  overflow: hidden;
}
.accounts-card {
  margin-bottom: 22px;
}
.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--admin-border);
}
.card-heading h2 {
  margin-bottom: 2px;
  font-size: 1.08rem;
}
.card-heading p {
  margin-bottom: 0;
  color: var(--admin-text-muted);
  font-size: 0.86rem;
}
.card-heading > span {
  flex: 0 0 auto;
  color: var(--admin-text-muted);
  font-size: 0.82rem;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
}
th,
td {
  padding: 12px 14px;
  border-bottom: 1px solid #e5e9ef;
  text-align: left;
  vertical-align: middle;
}
th {
  color: #344054;
  background: var(--admin-surface-muted);
  font-size: 0.78rem;
  font-weight: 700;
}
tbody tr:hover {
  background: #f4f7fc;
}
tbody tr:last-child td {
  border-bottom: 0;
}
.account-name {
  font-weight: 650;
}
td input:not([type="checkbox"]):not([type="color"]) {
  min-width: 190px;
  min-height: 36px;
  padding: 6px 9px;
}
.color-control {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--admin-border);
  border-radius: 8px;
  background: #fff;
}
input[type="color"] {
  width: 34px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.status-badge {
  display: inline-flex;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
}
.is-live {
  color: #176b4d;
  background: #e2f2ea;
}
.is-delayed {
  color: #815600;
  background: #fff1c2;
}
.is-offline {
  color: #941c25;
  background: #fbe8ea;
}
.is-idle {
  color: #556173;
  background: #eef1f5;
}
.received-at {
  color: var(--admin-text-muted);
  font-size: 0.84rem;
}
.empty-state {
  padding: 42px 18px;
  color: var(--admin-text-muted);
  text-align: center;
  white-space: normal;
}
.settings-heading {
  align-items: flex-start;
}
.settings-body {
  display: grid;
  gap: 22px;
  padding: 22px 20px;
}
.settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 0.6fr);
  gap: 18px;
}
.security-panel {
  padding: 16px;
  border: 1px solid var(--admin-border);
  border-radius: 10px;
  background: var(--admin-surface-muted);
}
.password-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.password-toggle input {
  flex: 0 0 auto;
  margin-top: 3px;
}
.password-toggle span {
  display: grid;
}
.password-toggle strong {
  font-size: 0.92rem;
}
.password-toggle small {
  color: var(--admin-text-muted);
}
.password-field {
  max-width: 520px;
  margin-top: 14px;
}
.generated {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 10px;
  padding: 16px;
  border-radius: 10px;
  background: #eef3fc;
}
.generated-field {
  min-width: 0;
}
.generated input {
  text-overflow: ellipsis;
}
.form-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 4px;
}
.destructive-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.save-button {
  min-width: 150px;
}

@media (max-width: 700px) {
  .page-heading .map-state {
    align-self: flex-start;
  }
  .accounts-card,
  .form {
    margin-inline: -12px;
    border-radius: 0;
  }
  .card-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
  th,
  td {
    padding: 10px 12px;
  }
  .settings-body {
    padding: 18px 16px;
  }
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .generated {
    grid-template-columns: 1fr 1fr;
  }
  .generated-field {
    grid-column: 1 / -1;
  }
  .form-actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
  .destructive-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
  .form-actions button {
    width: 100%;
  }
}
</style>
