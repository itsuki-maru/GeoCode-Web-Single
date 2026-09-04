<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import apiClient from "@/axiosClient";
import { getTokenUrl } from "@/router/urls";
import MessageModal from "@/components/common/MessageModal.vue";

const router = useRouter();
const isMessageModal = ref(false);
const messageText = ref("");
const isSubmitting = ref(false);

const loginInfo = ref({
  username: "",
  password: "",
});

const closeMessage = () => {
  isMessageModal.value = false;
  messageText.value = "";
};

const showMessage = (message: string) => {
  messageText.value = message;
  isMessageModal.value = true;
};

const loginPost = async (): Promise<void> => {
  const username = loginInfo.value.username;
  const password = loginInfo.value.password;
  if (username === "" || password === "" || isSubmitting.value) return;

  isSubmitting.value = true;
  try {
    await apiClient.post(getTokenUrl, { username, password });
    await router.push("/users/list");
  } catch {
    loginInfo.value.password = "";
    showMessage("パスワードかユーザー名が間違っています。");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <section class="login-page" aria-labelledby="login-title">
    <div class="login-card admin-card">
      <div class="login-heading">
        <span class="login-badge">ADMINISTRATION</span>
        <h1 id="login-title">管理者ログイン</h1>
        <p>管理者アカウントの認証情報を入力してください。</p>
      </div>

      <form method="post" class="login-form" @submit.prevent="loginPost">
        <label class="field" for="admin-username">
          <span class="field-label">ユーザー名</span>
          <input
            id="admin-username"
            v-model="loginInfo.username"
            type="text"
            name="u"
            pattern="^[A-Za-z0-9@_.\x2D]{3,}$"
            title="3文字以上の半角英数字、@、_、-、.で入力してください。"
            autocomplete="username"
            required
          />
        </label>

        <label class="field" for="admin-password">
          <span class="field-label">パスワード</span>
          <input
            id="admin-password"
            v-model="loginInfo.password"
            type="password"
            name="p"
            pattern=".{8,}"
            title="8文字以上で入力してください。"
            autocomplete="current-password"
            required
          />
        </label>

        <button type="submit" class="button-primary login-button" :disabled="isSubmitting">
          {{ isSubmitting ? "ログイン中…" : "ログイン" }}
        </button>
      </form>
    </div>

    <MessageModal :is-open="isMessageModal" :message="messageText" @close="closeMessage" />
  </section>
</template>

<style scoped>
.login-page {
  width: 100%;
  min-height: calc(100vh - 70px);
  display: grid;
  place-items: center;
  padding: 40px 16px;
  background:
    radial-gradient(circle at 15% 85%, rgba(53, 89, 169, 0.14), transparent 34%),
    linear-gradient(135deg, #eef1f5 0%, #ffffff 52%, #e7ebf2 100%);
}

.login-card {
  width: min(100%, 420px);
  padding: clamp(24px, 5vw, 38px);
}

.login-heading {
  margin-bottom: 26px;
  text-align: center;
}

.login-heading h1 {
  margin: 8px 0;
  font-size: clamp(1.6rem, 6vw, 2rem);
}

.login-heading p {
  margin-bottom: 0;
  color: var(--admin-text-muted);
  font-size: 0.92rem;
}

.login-badge {
  color: var(--admin-primary);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.login-form {
  display: grid;
  gap: 18px;
}

.login-button {
  width: 100%;
  min-height: 46px;
  margin-top: 4px;
}

@media (max-width: 700px) {
  .login-page {
    min-height: calc(100vh - 62px);
    padding: 24px 12px;
  }
}
</style>
