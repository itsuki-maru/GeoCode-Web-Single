<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { externalSiteUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import { AxiosError } from "axios";

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
  loginRedirect: [];
  saved: [];
}>();

const siteUrl = ref("");
const isLoading = ref(false);

const fetchExternalSiteUrl = async (): Promise<void> => {
  isLoading.value = true;
  try {
    const response = await apiClient.get(externalSiteUrl);
    siteUrl.value = response.data["url"];
  } catch (error) {
    handleRequestError(error, "外部サイトURLの取得に失敗しました。");
  } finally {
    isLoading.value = false;
  }
};

const saveExternalSiteUrl = async (): Promise<void> => {
  if (siteUrl.value.trim() === "") {
    emit("message", "URLを入力してください。");
    return;
  }

  try {
    const response = await apiClient.put(externalSiteUrl, { url: siteUrl.value });
    siteUrl.value = response.data["url"];
    emit("saved");
    emit("message", "外部サイトURLを更新しました。");
    emit("close");
  } catch (error) {
    handleRequestError(error, "外部サイトURLの更新に失敗しました。");
  }
};

const handleRequestError = (error: unknown, fallbackMessage: string): void => {
  if (apiClient.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    if (status === 400) {
      const data = axiosError.response?.data;
      const message =
        typeof data === "string"
          ? data
          : typeof data === "object" && data !== null && "error" in data
            ? String(data.error)
            : fallbackMessage;
      let showMessage = "";
      if (message.includes("http or https scheme required")) {
        showMessage = "http:// または https:// で始まるURLを入力してください。";
      } else if (message.includes("invalid url")) {
        showMessage = "URLの形式が正しくありません。";
      } else if (message.includes("over length")) {
        showMessage = "URLの長さが正しくありません。";
      } else if (message.includes("no input")) {
        showMessage = "URLを入力してください。";
      }
      emit("message", showMessage);
      return;
    }
    if (status === 401) {
      emit("loginRedirect");
      return;
    }
  }
  emit("message", fallbackMessage);
};

watch(
  () => props.isOpen,
  (isOpen) => {
    if (isOpen) {
      fetchExternalSiteUrl();
    }
  },
);
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="external-site-setting-content">
      <h2 class="modal-h2">自分用の外部サイトURL設定</h2>
      <div class="setting-contents">
        <div class="input-zone">
          <input
            type="url"
            maxlength="2048"
            title="http:// または https:// で始まるURLを設定してください。"
            placeholder="https://project.geocode-web.com"
            class="input-textbox"
            required
            :disabled="isLoading"
            v-model="siteUrl"
          />
        </div>
        <p class="setting-note">右上の外部サイトボタンから別タブで開くURLを設定します。</p>
        <div class="btn-zone">
          <button @click="emit('close')">閉じる</button>
          <button :disabled="isLoading" @click="saveExternalSiteUrl()">保存</button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.external-site-setting-content {
  width: 45vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.setting-contents {
  text-align: center;
}

.input-textbox {
  font-size: 20px;
  width: 90%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.setting-note {
  margin: 12px auto 0;
  width: 90%;
  color: #555555;
  font-size: 13px;
  text-align: left;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}
</style>
