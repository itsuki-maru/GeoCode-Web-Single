<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { getUserInfoUrl, userPrivacySettingUrl, userPasswordUpdateUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import { useApplicationInitStore } from "@/stores/appInits";

const MIN_PASSWORD_LENGTH = 8;

const appInitStore = useApplicationInitStore();
const isAllowUserUpdatePassword = computed(
  (): boolean => appInitStore.appInitData.allowUserUpdatePassword,
);

// ユーザープライバシー設定ハンドリング
const isUserPrivate = ref(false);
const isInitialized = ref(false);
onMounted(async () => {
  try {
    const response = await apiClient.get(getUserInfoUrl);
    isUserPrivate.value = response.data["is_private"];
  } catch (error) {
    isUserPrivate.value = false;
  }
});
const isPrivacyChanged = async (): Promise<void> => {
  if (isUserPrivate.value) {
    isUserPrivate.value = false;
  } else {
    isUserPrivate.value = true;
  }
  try {
    const payload = {
      is_private: isUserPrivate.value,
    };
    await apiClient.put(userPrivacySettingUrl, payload);
  } catch (error) {
    console.error(error);
  }
};

const isOpenUserSettingModal = ref(false);
const openCloseUserSettingModal = (): void => {
  isInitialized.value = true;
  if (isOpenUserSettingModal.value) {
    isOpenUserSettingModal.value = false;
  } else {
    isOpenUserSettingModal.value = true;
  }
};

const isOpenPasswordUpdateModal = ref(false);
const newPassword = ref("");
const checkPassword = ref("");
const openClosePasswordUpdateModal = (): void => {
  isOpenPasswordUpdateModal.value = !isOpenPasswordUpdateModal.value;
  if (!isOpenPasswordUpdateModal.value) {
    newPassword.value = "";
    checkPassword.value = "";
  }
};

const isMessageModal = ref(false);
const messageText = ref("");
const messageModalOpenClose = (message: string): void => {
  if (!isMessageModal.value) {
    messageText.value = message;
    isMessageModal.value = true;
  } else {
    isMessageModal.value = false;
    messageText.value = "";
  }
};

const updatePassword = async (): Promise<void> => {
  if (newPassword.value === "") {
    messageModalOpenClose("パスワードが入力されていません。");
    return;
  }
  if (newPassword.value.length < MIN_PASSWORD_LENGTH) {
    messageModalOpenClose(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`);
    return;
  }
  if (newPassword.value !== checkPassword.value) {
    messageModalOpenClose("パスワードが一致しません。");
    return;
  }

  try {
    await apiClient.post(userPasswordUpdateUrl, {
      new_password: newPassword.value,
    });
    openClosePasswordUpdateModal();
    messageModalOpenClose("パスワードを更新しました。");
  } catch (error) {
    messageModalOpenClose("パスワードの更新に失敗しました。");
  }
};

defineExpose({
  openCloseUserSettingModal,
  isUserPrivate,
  isInitialized,
});
</script>

<template>
  <div id="overlay-update-user" v-show="isOpenUserSettingModal">
    <div id="content-update-user">
      <h2 class="modal-h2">プライバシー設定の変更</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Set</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td v-if="isUserPrivate" class="mode"><strong>プライバシーモード：ON</strong></td>
            <td v-if="!isUserPrivate" class="mode"><strong>プライバシーモード：OFF</strong></td>
            <td>
              <div
                class="switch-btn-container"
                title="アカウントのプライバシー設定を切り替えます。"
              >
                <div class="private-public-toggle">
                  <div class="switch" v-on:click="isPrivacyChanged()">
                    <input
                      v-if="isUserPrivate"
                      type="checkbox"
                      id="switch"
                      v-model="isUserPrivate"
                      chacked
                    />
                    <input
                      v-else="isUserPrivate"
                      type="checkbox"
                      id="switch"
                      v-model="isUserPrivate"
                    />
                    <div class="base"></div>
                    <div class="circle"></div>
                    <div class="slider"></div>
                  </div>
                </div>
              </div>
            </td>
          </tr>
          <tr v-if="isAllowUserUpdatePassword">
            <td class="mode"><strong>パスワード変更</strong></td>
            <td>
              <button class="setting-btn" v-on:click="openClosePasswordUpdateModal()">変更</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="btn-close">
        <button v-on:click="openCloseUserSettingModal()">閉じる</button>
      </div>
    </div>
  </div>

  <!-- パスワード更新モーダル -->
  <div id="overlay-update-password" v-show="isOpenPasswordUpdateModal">
    <div id="content-update-password">
      <h2 class="modal-h2">パスワード変更</h2>
      <input
        class="password-input"
        type="password"
        pattern=".{8,}"
        placeholder="New Password"
        autocomplete="new-password"
        v-model="newPassword"
      />
      <input
        class="password-input"
        type="password"
        pattern=".{8,}"
        placeholder="Check Password"
        autocomplete="new-password"
        v-model="checkPassword"
      />
      <div class="btn-zone">
        <button v-on:click="openClosePasswordUpdateModal()">閉じる</button>
        <button v-on:click="updatePassword()">更新</button>
      </div>
    </div>
  </div>

  <!-- 各種メッセージモーダル -->
  <div id="overlay-message" v-show="isMessageModal">
    <div id="content-message">
      <h2 class="modal-h2">メッセージ</h2>
      <p>
        <strong>{{ messageText }}</strong>
      </p>
      <div class="btn-close">
        <button v-on:click="messageModalOpenClose('No Message')">閉じる</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ユーザー設定モーダル */
#overlay-update-user {
  z-index: 3;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

#content-update-user {
  z-index: 4;
  width: 90%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.setting-btn {
  min-width: 56px;
  padding: 0.4em 0.8em;
}

#overlay-update-password,
#overlay-message {
  z-index: 5;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

#content-update-password,
#content-message {
  z-index: 6;
  width: 90%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.password-input {
  width: 100%;
  margin-bottom: 12px;
  padding: 0.6em 1.2em;
  border-radius: 5px;
  box-sizing: border-box;
  text-align: center;
}

.btn-zone {
  display: flex;
  width: 100%;
  justify-content: space-between;
}

.switch-label {
  position: relative;
}

input[type="checkbox"] {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}

.mode {
  font-size: 1em;
}

.base {
  width: 56px;
  border-radius: 16px;
  height: 32px;
  background-color: #ddd;
}

input:checked ~ .base {
  background-color: rgb(219, 234, 254);
  transition: 0.5s;
}

input:checked ~ .circle {
  transform: translateX(100%);
  background-color: blue;
}

.circle {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 24px;
  height: 24px;
  border-radius: 12px;
  background-color: white;
  transition: 0.5s;
}

.switch {
  position: relative;
}

table {
  width: 100%;
}

thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

td,
th {
  text-align: center;
}

th:nth-child(1) {
  width: 90%;
}

th:nth-child(2) {
  width: 10%;
}
</style>
