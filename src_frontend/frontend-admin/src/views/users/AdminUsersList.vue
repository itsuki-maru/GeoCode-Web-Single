<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { AxiosError } from "axios";
import apiClient from "@/axiosClient";
import type { UpdateUserData, UserData } from "@/interface";
import {
  createUserUrl,
  getUserUrl,
  liveLocationPermissionUrl,
  resetUserPasswordUrl,
  unlockUserAccountUrl,
} from "@/router/urls";
import { assetsUrl } from "@/setting";
import { useUsersStore } from "@/stores/users";
import BaseModal from "@/components/common/BaseModal.vue";
import ConfirmModal from "@/components/common/ConfirmModal.vue";
import MessageModal from "@/components/common/MessageModal.vue";

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[A-Za-z0-9@_.\x2D]{3,}$/;
const USERNAME_VALIDATION_MESSAGE =
  "ユーザー名は3文字以上で、半角英数字、@、_、-、.のみ使用できます。";

const router = useRouter();
const usersStore = useUsersStore();
const userList = computed((): Map<string, UserData> => usersStore.usersList);
const currentUser = ref("");

const isMessageModal = ref(false);
const messageText = ref("");
const showUpdateUserContent = ref(false);
const showUpdateUserCheckContent = ref(false);
const showCreateUserContent = ref(false);

const updateUserData = ref<UpdateUserData>({
  id: "",
  username: "",
  new_password: "",
  is_superuser: false,
});
const newPasswordRef = ref("");
const checkPasswordRef = ref("");
const signupInfo = ref({ username: "", password: "" });

const showMessage = (message: string): void => {
  messageText.value = message;
  isMessageModal.value = true;
};

const closeMessage = (): void => {
  isMessageModal.value = false;
  messageText.value = "";
};

const getDateForDateTime = (dateTimeString: string): string => dateTimeString.split("T")[0] ?? "";

const getCurrentUser = async (): Promise<void> => {
  try {
    const response = await apiClient.get(getUserUrl);
    currentUser.value = response.data["username"];
  } catch {
    await router.push("/account/login");
  }
};

const updateLiveLocationPermission = async (userId: string, enabled: boolean): Promise<void> => {
  try {
    await apiClient.put(`${liveLocationPermissionUrl}${userId}/live-location-permission`, {
      enabled,
    });
  } catch {
    showMessage("現在位置共有の許可を更新できませんでした。");
  } finally {
    await usersStore.initList();
  }
};

const unlockUserRequest = async (userId: string): Promise<void> => {
  try {
    await apiClient.post(`${unlockUserAccountUrl}${userId}`);
    await usersStore.initList();
    showMessage("アカウントロックを解除しました。");
  } catch {
    showMessage("アカウントロック解除に失敗しました。");
  }
};

const openUserModal = (selectedUserId: string): void => {
  if (selectedUserId === "") {
    showUpdateUserContent.value = false;
    newPasswordRef.value = "";
    checkPasswordRef.value = "";
    return;
  }

  const selectedUser = usersStore.getById(selectedUserId);
  updateUserData.value.id = selectedUser.id;
  updateUserData.value.username = selectedUser.username;
  showUpdateUserContent.value = true;
};

const validatePasswordUpdateInput = (): boolean => {
  if (newPasswordRef.value === "") {
    showMessage("パスワードが入力されていません。");
    return false;
  }
  if (newPasswordRef.value.length < MIN_PASSWORD_LENGTH) {
    showMessage(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`);
    return false;
  }
  if (newPasswordRef.value !== checkPasswordRef.value) {
    showMessage("パスワードが一致しません。");
    return false;
  }
  return true;
};

const openUpdateCheckModal = (): void => {
  if (!validatePasswordUpdateInput()) return;
  showUpdateUserCheckContent.value = true;
};

const updateUser = async (): Promise<void> => {
  if (!validatePasswordUpdateInput()) {
    showUpdateUserCheckContent.value = false;
    return;
  }

  try {
    await apiClient.post(`${resetUserPasswordUrl}${updateUserData.value.id}`, {
      new_password: newPasswordRef.value,
    });
    showUpdateUserCheckContent.value = false;
    showUpdateUserContent.value = false;
    newPasswordRef.value = "";
    checkPasswordRef.value = "";
    showMessage("更新しました。");
  } catch {
    showUpdateUserCheckContent.value = false;
    showMessage("更新に失敗しました。");
  }
};

const openCloseUserCreateModal = (): void => {
  showCreateUserContent.value = !showCreateUserContent.value;
  if (!showCreateUserContent.value) signupInfo.value = { username: "", password: "" };
};

const validateSignupInput = (): boolean => {
  if (signupInfo.value.username === "" || signupInfo.value.password === "") {
    showMessage("入力は全て必須です。");
    return false;
  }
  if (!USERNAME_PATTERN.test(signupInfo.value.username)) {
    showMessage(USERNAME_VALIDATION_MESSAGE);
    return false;
  }
  if (signupInfo.value.password.length < MIN_PASSWORD_LENGTH) {
    showMessage(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`);
    return false;
  }
  return true;
};

const signupPost = async (): Promise<void> => {
  if (!validateSignupInput()) return;

  try {
    await apiClient.post(createUserUrl, {
      username: signupInfo.value.username,
      password: signupInfo.value.password,
    });
    showMessage("ユーザーの作成に成功しました。");
    await usersStore.initList();
    signupInfo.value = { username: "", password: "" };
  } catch (error) {
    if (apiClient.isAxiosError(error)) {
      const axiosError = error as AxiosError<any>;
      const errorStatus = axiosError.response?.data?.["error"];
      if (axiosError.response?.status === 409 || errorStatus === "conflict") {
        showMessage("既に使用されているユーザー名です。");
        return;
      }
      if (axiosError.response?.status === 400 && typeof errorStatus === "string") {
        showMessage("ユーザー名またはパスワードの形式が正しくありません。");
        return;
      }
    }
    showMessage("ユーザーの作成に失敗しました。");
  }
};

if (userList.value.size === 0) void usersStore.initList();
void getCurrentUser();
</script>

<template>
  <section class="page-shell" aria-labelledby="users-title">
    <div class="page-heading">
      <div>
        <h1 id="users-title">ユーザー管理</h1>
        <p class="page-description">
          アカウントの作成、パスワード更新、ロック状態と位置共有権限を管理します。
        </p>
        <p class="current-user">ログイン中: {{ currentUser || "取得中…" }}</p>
      </div>
      <button
        type="button"
        class="button-primary btn-head-image"
        title="新規ユーザーを作成します。"
        @click="openCloseUserCreateModal"
      >
        <img :src="`${assetsUrl}person_add_24.png`" class="button-icon" alt="" />
        ユーザーを作成
      </button>
    </div>

    <div class="admin-card table-card">
      <div class="table-summary">
        <h2>登録ユーザー</h2>
        <span>{{ userList.size }}件</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>ユーザー名</th>
              <th>作成日</th>
              <th>権限</th>
              <th>状態</th>
              <th>位置共有</th>
              <th><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[id, user] in userList" :key="id">
              <td class="id-cell">{{ user.id }}</td>
              <td class="username-cell">{{ user.username }}</td>
              <td>{{ getDateForDateTime(user.create_at) }}</td>
              <td>
                <span class="status-badge" :class="user.is_superuser ? 'is-admin' : 'is-standard'">
                  {{ user.is_superuser ? "管理者" : "一般" }}
                </span>
              </td>
              <td>
                <span class="status-badge" :class="user.is_locked ? 'is-locked' : 'is-active'">
                  {{ user.is_locked ? "ロック中" : "有効" }}
                </span>
              </td>
              <td>
                <label class="permission-control">
                  <input
                    type="checkbox"
                    :checked="user.can_share_live_location"
                    :aria-label="`${user.username}の現在位置共有を許可`"
                    @change="
                      updateLiveLocationPermission(
                        user.id,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />
                  <span>{{ user.can_share_live_location ? "許可" : "不許可" }}</span>
                </label>
              </td>
              <td>
                <div class="row-actions">
                  <button
                    type="button"
                    class="button-secondary btn-table"
                    @click="openUserModal(user.id)"
                  >
                    パスワード更新
                  </button>
                  <button
                    v-if="user.is_locked"
                    type="button"
                    class="button-secondary btn-table"
                    @click="unlockUserRequest(user.id)"
                  >
                    ロック解除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="userList.size === 0">
              <td colspan="7" class="empty-state">登録ユーザーはありません。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <BaseModal
      :is-open="showUpdateUserContent"
      title-id="password-update-title"
      overlay-id="overlay-user-info"
      content-id="content-user-info"
      @close="openUserModal('')"
    >
      <h2 id="password-update-title" class="modal-title">パスワード更新</h2>
      <p class="modal-description">
        対象ユーザー: <strong>{{ updateUserData.username }}</strong>
      </p>
      <form class="modal-form" @submit.prevent="openUpdateCheckModal">
        <label class="field">
          <span class="field-label">新しいパスワード</span>
          <input
            v-model="newPasswordRef"
            type="password"
            pattern=".{8,}"
            minlength="8"
            autocomplete="new-password"
            required
          />
        </label>
        <label class="field">
          <span class="field-label">新しいパスワード（確認）</span>
          <input
            v-model="checkPasswordRef"
            type="password"
            pattern=".{8,}"
            minlength="8"
            autocomplete="new-password"
            required
          />
        </label>
        <div class="button-row">
          <button type="button" class="button-secondary" @click="openUserModal('')">閉じる</button>
          <button type="submit" class="button-primary">更新内容を確認</button>
        </div>
      </form>
    </BaseModal>

    <BaseModal
      :is-open="showCreateUserContent"
      title-id="create-user-title"
      overlay-id="overlay-create-user"
      content-id="content-create-user"
      @close="openCloseUserCreateModal"
    >
      <h2 id="create-user-title" class="modal-title">ユーザー作成</h2>
      <p class="modal-description">管理対象となる新しいアカウントを作成します。</p>
      <form class="modal-form" @submit.prevent="signupPost">
        <label class="field">
          <span class="field-label">ユーザー名</span>
          <input
            v-model="signupInfo.username"
            type="text"
            pattern="^[A-Za-z0-9@_.\x2D]{3,}$"
            :title="USERNAME_VALIDATION_MESSAGE"
            autocomplete="username"
            required
          />
          <span class="field-help">3文字以上の半角英数字、@、_、-、.が使用できます。</span>
        </label>
        <label class="field">
          <span class="field-label">パスワード</span>
          <input
            v-model="signupInfo.password"
            type="password"
            pattern=".{8,}"
            minlength="8"
            autocomplete="new-password"
            required
          />
          <span class="field-help">8文字以上で入力してください。</span>
        </label>
        <div class="button-row">
          <button type="button" class="button-secondary" @click="openCloseUserCreateModal">
            閉じる
          </button>
          <button type="submit" class="button-primary">アカウント作成</button>
        </div>
      </form>
    </BaseModal>

    <ConfirmModal
      :is-open="showUpdateUserCheckContent"
      title="最終確認"
      :message="`${updateUserData.username} のパスワードを更新しますか？`"
      confirm-label="更新"
      @cancel="showUpdateUserCheckContent = false"
      @confirm="updateUser"
    />

    <MessageModal :is-open="isMessageModal" :message="messageText" @close="closeMessage" />
  </section>
</template>

<style scoped>
.current-user {
  margin: 8px 0 0;
  color: var(--admin-text-muted);
  font-size: 0.82rem;
  font-weight: 600;
}

.button-icon {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
.table-card {
  overflow: hidden;
}
.table-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--admin-border);
}
.table-summary h2 {
  margin: 0;
  font-size: 1.08rem;
}
.table-summary span {
  color: var(--admin-text-muted);
  font-size: 0.88rem;
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
  padding: 13px 14px;
  border-bottom: 1px solid #e5e9ef;
  text-align: left;
  vertical-align: middle;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #344054;
  background: var(--admin-surface-muted);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}
tbody tr:hover {
  background: #f4f7fc;
}
tbody tr:last-child td {
  border-bottom: 0;
}
.id-cell {
  color: var(--admin-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.82rem;
}
.username-cell {
  color: #111827;
  font-weight: 650;
}
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
}
.is-admin {
  color: #28407d;
  background: #e8eefb;
}
.is-standard {
  color: #556173;
  background: #eef1f5;
}
.is-locked {
  color: #941c25;
  background: #fbe8ea;
}
.is-active {
  color: #176b4d;
  background: #e2f2ea;
}
.permission-control {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.permission-control span {
  color: var(--admin-text-muted);
  font-size: 0.82rem;
}
.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn-table {
  min-height: 34px;
  padding: 6px 10px;
  font-size: 0.78rem;
}
.empty-state {
  padding: 48px 16px;
  color: var(--admin-text-muted);
  text-align: center;
}
.modal-title {
  margin-bottom: 6px;
  font-size: 1.4rem;
  text-align: center;
}
.modal-description {
  margin-bottom: 22px;
  color: var(--admin-text-muted);
  text-align: center;
}
.modal-form {
  display: grid;
  gap: 18px;
}
.modal-form .button-row {
  margin-top: 6px;
}

@media (max-width: 700px) {
  .table-card {
    margin-inline: -12px;
    border-radius: 0;
  }
  th,
  td {
    padding: 11px 12px;
  }
  .row-actions {
    justify-content: flex-start;
  }
}
</style>
