<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import QRCode from "qrcode";
import {
  getUserInfoUrl,
  userPrivacySettingUrl,
  userPasswordUpdateUrl,
  userTotpSettingUrl,
  userTotpVerifyUrl,
  userTotpDisableUrl,
} from "@/router/urls";
import apiClient from "@/axiosClient";
import { useApplicationInitStore } from "@/stores/appInits";
import { useAuthStore } from "@/stores/auth";

const MIN_PASSWORD_LENGTH = 8;

const appInitStore = useApplicationInitStore();
const authStore = useAuthStore();
const router = useRouter();
const isAllowUserUpdatePassword = computed(
  (): boolean => appInitStore.appInitData.allowUserUpdatePassword,
);

const isUserPrivate = ref(false); // ユーザープライバシー設定ハンドリング
const isTotpAuth = ref(false); // ユーザー2段階認証設定ハンドリング
const isInitialized = ref(false);
onMounted(async () => {
  try {
    const response = await apiClient.get(getUserInfoUrl);
    isUserPrivate.value = response.data["is_private"];
    isTotpAuth.value = response.data["is_totp_enabled"] === true;
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

const isOpenTotpSetupModal = ref(false);
const changeTotpQRModal = async (): Promise<void> => {
  if (isTotpAuth.value) {
    openTotpDisableModal();
    return;
  } else {
    // 仮の有効化リクエスト
    isOpenTotpSetupModal.value = true;
    try {
      const response = await apiClient.post(userTotpSettingUrl);
      const otpAuthUrl = response.data["otpauth_url"];
      const secretBase32 = response.data["secret_base32"];
      qrCodeText.value = otpAuthUrl;
      await generateQRCode();
    } catch (error) {
      console.error(error);
    }
  }
};

const closeTotpQRModal = (): void => {
  isOpenTotpSetupModal.value = false;
};

const isOpenTotpDisableModal = ref(false);
const totpDisableToken = ref("");
const isTotpDisableSubmitting = ref(false);
const isTotpDisableTokenValid = computed(() => /^\d{6}$/.test(totpDisableToken.value));

const openTotpDisableModal = (): void => {
  totpDisableToken.value = "";
  isOpenTotpDisableModal.value = true;
};

const closeTotpDisableModal = (): void => {
  if (isTotpDisableSubmitting.value) return;
  isOpenTotpDisableModal.value = false;
  totpDisableToken.value = "";
};

const disableTotp = async (): Promise<void> => {
  if (!isTotpDisableTokenValid.value || isTotpDisableSubmitting.value) {
    return;
  }

  authStore.beginTokenRotation();
  isTotpDisableSubmitting.value = true;
  try {
    await apiClient.post(userTotpDisableUrl, { token: totpDisableToken.value });
    isTotpAuth.value = false;
    isOpenTotpDisableModal.value = false;
    totpDisableToken.value = "";
    messageModalOpenClose("2段階認証を無効化しました。");
  } catch (error) {
    messageModalOpenClose("コードが正しくないため、2段階認証を無効化できませんでした。");
  } finally {
    isTotpDisableSubmitting.value = false;
    authStore.endTokenRotation();
  }
};

const isOpenPasswordUpdateModal = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const checkPassword = ref("");
const isPasswordUpdateSubmitting = ref(false);
const isPasswordUpdatedModal = ref(false);
const openClosePasswordUpdateModal = (): void => {
  isOpenPasswordUpdateModal.value = !isOpenPasswordUpdateModal.value;
  if (!isOpenPasswordUpdateModal.value) {
    currentPassword.value = "";
    newPassword.value = "";
    checkPassword.value = "";
  }
};

defineExpose({
  openCloseUserSettingModal,
  isUserPrivate,
  isTotpAuth,
  isInitialized,
});

// QRコードモーダルの描画
const qrCodeText = ref("");
const totpQrCodeCanvas = ref<HTMLCanvasElement | null>(null);

// QRCode作成関数
async function generateQRCode(): Promise<void> {
  const text = qrCodeText.value;
  const canvas = totpQrCodeCanvas.value;
  if (text === "" || canvas === null) {
    return;
  }
  await QRCode.toCanvas(canvas, text, {
    width: 128,
    margin: 0,
    errorCorrectionLevel: "H",
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
}

// メッセージ表示モーダル機能
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

// トークン
const token = ref("");
const isTotpVerifySubmitting = ref(false);
const verifyTotp = async (): Promise<void> => {
  if (token.value === "" || isTotpVerifySubmitting.value) {
    if (isTotpVerifySubmitting.value) return;
    messageModalOpenClose(
      "QRコードをGoogle Authenticatorなどで読み取り、アプリケーションに表示されている6桁の数字を入力してください。",
    );
    return;
  }
  const payload = { token: token.value };
  authStore.beginTokenRotation();
  isTotpVerifySubmitting.value = true;
  try {
    await apiClient.post(userTotpVerifyUrl, payload);
    messageModalOpenClose("二段階認証が有効になりました。");
    isTotpAuth.value = true;
    closeTotpQRModal();
  } catch (error) {
    messageModalOpenClose("トークンが正しくありません。");
  } finally {
    isTotpVerifySubmitting.value = false;
    authStore.endTokenRotation();
  }
};

const updatePassword = async (): Promise<void> => {
  if (currentPassword.value === "") {
    messageModalOpenClose("現在のパスワードを入力してください。");
    return;
  }
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
  if (isPasswordUpdateSubmitting.value) return;

  authStore.beginReauthentication();
  isPasswordUpdateSubmitting.value = true;
  try {
    await apiClient.post(userPasswordUpdateUrl, {
      current_password: currentPassword.value,
      new_password: newPassword.value,
    });
    openClosePasswordUpdateModal();
    isPasswordUpdatedModal.value = true;
  } catch (error) {
    authStore.cancelReauthentication();
    messageModalOpenClose("パスワードの更新に失敗しました。");
  } finally {
    isPasswordUpdateSubmitting.value = false;
  }
};

const redirectToLoginAfterPasswordUpdate = (): void => {
  authStore.logout();
  void router.replace("/account/login");
};
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
          <tr>
            <td v-if="isTotpAuth" class="mode"><strong>2段階認証：ON</strong></td>
            <td v-if="!isTotpAuth" class="mode"><strong>2段階認証：OFF</strong></td>
            <td>
              <div class="switch-btn-container" title="アカウントの2段階認証設定を切り替えます。">
                <div class="private-public-toggle">
                  <div class="switch" v-on:click="changeTotpQRModal()">
                    <input
                      v-if="isTotpAuth"
                      type="checkbox"
                      id="switch"
                      v-model="isTotpAuth"
                      chacked
                    />
                    <input v-else="isTotpAuth" type="checkbox" id="switch" v-model="isTotpAuth" />
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
      <div class="btn-zone">
        <button v-on:click="openCloseUserSettingModal()">閉じる</button>
      </div>
    </div>
  </div>

  <!-- パスワード更新モーダル -->
  <div id="overlay-update-password" v-if="isOpenPasswordUpdateModal">
    <form id="content-update-password" v-on:submit.prevent="updatePassword">
      <h2 id="password-update-title" class="modal-h2">パスワード変更</h2>
      <label class="visually-hidden" for="current-password">現在のパスワード</label>
      <input
        id="current-password"
        name="current-password"
        class="password-input"
        type="password"
        placeholder="Current Password"
        autocomplete="current-password"
        v-model="currentPassword"
      />
      <label class="visually-hidden" for="new-password">新しいパスワード</label>
      <input
        id="new-password"
        name="new-password"
        class="password-input"
        type="password"
        pattern=".{8,}"
        placeholder="New Password"
        autocomplete="new-password"
        v-model="newPassword"
      />
      <label class="visually-hidden" for="check-password">新しいパスワードの確認</label>
      <input
        id="check-password"
        name="check-password"
        class="password-input"
        type="password"
        pattern=".{8,}"
        placeholder="Check Password"
        autocomplete="new-password"
        v-model="checkPassword"
      />
      <div class="btn-zone">
        <button type="button" v-on:click="openClosePasswordUpdateModal()">閉じる</button>
        <button type="submit" :disabled="isPasswordUpdateSubmitting">
          {{ isPasswordUpdateSubmitting ? "更新中..." : "更新" }}
        </button>
      </div>
    </form>
  </div>

  <div v-if="isPasswordUpdatedModal" class="reauthentication-overlay">
    <div
      class="reauthentication-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-updated-title"
    >
      <h2 id="password-updated-title" class="modal-h2">パスワード変更完了</h2>
      <p>パスワードを変更しました。セキュリティ保護のため、もう一度ログインしてください。</p>
      <button type="button" v-on:click="redirectToLoginAfterPasswordUpdate">ログイン画面へ</button>
    </div>
  </div>

  <!-- 2段階認証無効化モーダル -->
  <div id="overlay-disable-totp" v-show="isOpenTotpDisableModal">
    <div
      id="content-disable-totp"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disable-totp-title"
    >
      <h2 id="disable-totp-title" class="modal-h2">2段階認証の無効化</h2>
      <p>認証アプリに表示されている現在の6桁コードを入力してください。</p>
      <form v-on:submit.prevent="disableTotp">
        <input
          class="totp-disable-input"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength="6"
          placeholder="XXXXXX"
          aria-label="6桁の確認コード"
          required
          v-model.trim="totpDisableToken"
        />
        <div class="btn-zone">
          <button type="button" v-on:click="closeTotpDisableModal()">キャンセル</button>
          <button
            type="submit"
            class="danger-btn"
            :disabled="!isTotpDisableTokenValid || isTotpDisableSubmitting"
          >
            {{ isTotpDisableSubmitting ? "確認中..." : "無効化" }}
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- QR生成モーダル -->
  <div id="overlay-gen-qrcode" v-show="isOpenTotpSetupModal">
    <div id="content-gen-qrcode">
      <h2 class="modal-h2">2段階認証</h2>
      <p>このQRコードをGoogle Authenticator等で読み取ってください。</p>
      <div class="setting-contents">
        <div class="qrcode">
          <canvas ref="totpQrCodeCanvas" width="128" height="128"></canvas>
        </div>
      </div>
      <div class="post-code">
        <label class="post-code-label">確認コード（6桁）：</label>
        <input
          class="post-code-input"
          v-model="token"
          maxlength="6"
          required
          placeholder="XXXXXX"
        />
        <button
          class="post-code-btn"
          v-on:click="verifyTotp()"
          :disabled="isTotpVerifySubmitting"
        >
          {{ isTotpVerifySubmitting ? "確認中..." : "認証して有効化" }}
        </button>
      </div>
      <div class="btn-close">
        <button v-on:click="closeTotpQRModal()">閉じる</button>
      </div>
    </div>
  </div>

  <!-- 各種メッセージモーダル -->
  <div id="overlay-message" v-show="isMessageModal">
    <div id="content-message">
      <h2 class="modal-h2">メッセージ</h2>
      <div class="input-text-zone">
        <p>
          <strong>{{ messageText }}</strong>
        </p>
      </div>
      <div class="message-btn-close">
        <button v-on:click="messageModalOpenClose('No Message')">閉じる</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ユーザー設定モーダル */
#overlay-update-user {
  z-index: 1;
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
  z-index: 2;
  width: 50%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.setting-btn {
  min-width: 64px;
  padding: 0.4em 0.8em;
}

#overlay-update-password,
#overlay-disable-totp {
  z-index: 15;
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
#content-disable-totp {
  z-index: 16;
  width: 32%;
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

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.reauthentication-overlay {
  z-index: 21;
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 16px;
  background-color: rgba(0, 0, 0, 0.5);
  text-align: center;
}

.reauthentication-content {
  z-index: 22;
  width: min(100%, 520px);
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.totp-disable-input {
  width: 100%;
  margin: 12px 0 20px;
  padding: 0.6em 1.2em;
  border-radius: 5px;
  box-sizing: border-box;
  font-size: 24px;
  letter-spacing: 0.25em;
  text-align: center;
}

.danger-btn {
  background-color: #b42318;
  color: white;
}

.danger-btn:hover:not(:disabled) {
  background-color: #8f1c13;
}

.danger-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

/* QRコード生成モーダル */
#overlay-gen-qrcode {
  z-index: 15;
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

#content-gen-qrcode {
  z-index: 16;
  width: 40%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
  display: grid;
  justify-content: center;
}

.qrcode {
  margin-bottom: 5%;
  display: grid;
  place-items: center;
}

.post-code {
  display: grid;
  width: 100%;
}

.post-code-label {
  margin-top: 12px;
}

.post-code-input {
  font-size: 24px;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.post-code-btn {
  margin-top: 12px;
  margin-bottom: 36px;
  background-color: #184aa5;
  font-size: 16px;
}

.post-code-btn:hover {
  background-color: #152852;
}

/* メッセージモーダル */
#overlay-message {
  z-index: 19;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

#content-message {
  z-index: 20;
  width: 20%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.message-btn-close {
  text-align: center;
}

@media (max-width: 768px) {
  #content-update-password,
  #content-disable-totp {
    width: 90%;
  }
}

@media (orientation: portrait) {
  #overlay-update-user,
  #overlay-update-password,
  #overlay-disable-totp,
  #overlay-gen-qrcode,
  #overlay-message {
    box-sizing: border-box;
    padding: 16px;
  }

  #content-update-user,
  #content-update-password,
  #content-disable-totp,
  #content-gen-qrcode,
  #content-message {
    box-sizing: border-box;
    max-width: 100%;
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
  }

  #content-update-user {
    width: min(calc(100vw - 32px), 760px);
  }

  #content-update-password,
  #content-disable-totp,
  #content-message {
    width: min(calc(100vw - 32px), 520px);
  }

  #content-gen-qrcode {
    width: min(calc(100vw - 32px), 600px);
  }
}
</style>
