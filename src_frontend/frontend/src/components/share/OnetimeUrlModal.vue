<script setup lang="ts">
import BaseModal from "@/components/common/BaseModal.vue";
import { invalidateOntimeMapUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

const props = defineProps<{
  isOpen: boolean;
  url: string;
  uuid: string;
  isHttps: boolean;
  expiration?: string;
}>();

const emit = defineEmits<{
  close: [];
  invalidated: [];
  message: [text: string];
}>();

const formatExpiration = (value?: string): string => {
  if (!value) {
    return "";
  }

  const normalizedValue = value.includes("T") ? `${value}Z` : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
};

function selectTextOrClipboardCopy(elementId: string) {
  let element = document.getElementById(elementId);
  if (!element || !element.textContent) {
    return;
  }

  if (props.isHttps) {
    navigator.clipboard.writeText(element.textContent);
    emit("message", "クリップボードにコピーしました。");
  } else {
    if (window.getSelection) {
      let selection = window.getSelection();
      let range = document.createRange();
      try {
        range.selectNodeContents(element);
      } catch (e) {
        console.error(`Error selecting contents of element: ${e}`);
      }
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
}

const invalidateOneTimeMap = async (): Promise<void> => {
  try {
    const deleteUrl = invalidateOntimeMapUrl + `${props.uuid}`;
    await apiClient.delete(deleteUrl);
    emit("close");
    emit("message", "共有を停止しました。");
    emit("invalidated");
  } catch (error) {
    console.error("Error");
  }
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="3" :close-on-overlay-click="false" @close="emit('close')">
    <div class="onetime-url-content">
      <h2 class="modal-h2">メッセージ</h2>
      <div class="input-text-zone" v-if="isHttps">
        <p><strong>共有マップを作成しました。</strong></p>
        <p v-if="expiration" class="expiration-text">
          有効期限: {{ formatExpiration(expiration) }}
        </p>
        <pre :id="uuid" class="hidden-code-text"><code :id="uuid">{{ url }}</code></pre>
        <button id="link-copy-btn" @click="selectTextOrClipboardCopy(uuid)">リンクを取得</button>
      </div>
      <div class="input-text-zone" v-else>
        <p><strong>共有マップを作成しました。</strong></p>
        <p v-if="expiration" class="expiration-text">
          有効期限: {{ formatExpiration(expiration) }}
        </p>
        <pre><code :id="uuid" @click="selectTextOrClipboardCopy(uuid)">{{ url }}</code></pre>
      </div>
      <div class="btn-zone">
        <button @click="emit('close')">閉じる</button>
        <button @click="invalidateOneTimeMap()">共有停止</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.onetime-url-content {
  width: 35vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.input-text-zone {
  text-align: center;
}

.expiration-text {
  font-size: 13px;
  color: #4a5b73;
}

.hidden-code-text {
  display: none;
}

pre code {
  margin: 0;
  padding: 0;
  white-space: pre;
  border: none;
  background: transparent;
}

pre {
  background-color: #e6e6e6;
  color: black;
  border: 1px solid #5e5e5e;
  font-size: 13px;
  line-height: 19px;
  overflow: auto;
  padding: 6px 10px;
  border-radius: 3px;
}

pre code,
pre tt {
  white-space: pre-wrap;
  background-color: transparent;
  border: none;
}

#link-copy-btn {
  width: 250px;
  background: rgb(27, 168, 161);
  height: 45px;
  font-size: 20px;
  color: #fff;
  padding: 7px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 14px;
  margin: 5px;
}

#link-copy-btn:hover {
  opacity: 0.7;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}
</style>
