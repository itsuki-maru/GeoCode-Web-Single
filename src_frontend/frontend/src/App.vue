<script setup lang="ts">
import { useRouter } from "vue-router";
import { provide, onMounted, onUnmounted, ref } from "vue";
import { assetsUrl } from "@/setting";
import { disableTokenUrl } from "@/router/urls";
import { useApplicationInitStore } from "./stores/appInits";
import apiClient from "@/axiosClient";

const appInitStore = useApplicationInitStore();
const appTitle = ref(appInitStore.appInitData.appTitle);

// MapView.vueへのリダイレクト
const router = useRouter();
const mapviewRedirect = (): void => {
  router.push("/mapview");
};

mapviewRedirect();

// メモアイコンの表示非表示管理
const isShowHelpIcon = ref(true);
const isShowMemoIcon = ref(true);
const isExitIcon = ref(true);
// 他の子コンポーネントで表示・非表示を切り替えられるようにprovide
provide("isShowHelpIcon", isShowHelpIcon);
provide("isShowMemoIcon", isShowMemoIcon);
provide("isExitIcon", isExitIcon);

// メモモーダルの描画
const showMemoContent = ref(false);
const onOpenCloseMemoModal = (): void => {
  if (showMemoContent.value === true) {
    showMemoContent.value = false;
  } else {
    showMemoContent.value = true;
    // カーソルのフォーカスがエディタ描画完了後になるようにsetTimeoutで遅延させる
    setTimeout(() => {
      document.getElementById("memo-textarea")!.focus();
    }, 300);
  }
};

async function loginRedirect(): Promise<void> {
  try {
    await apiClient.get(disableTokenUrl);
  } catch (error) {
    console.error(error);
  }
  router.push("/account/login");
}

// メモモーダル表示時に灰色の部分のクリック時にもメモモーダルを閉じる処理
// HTMLが描画後に組み込む（onmoutedを利用）
onMounted(() => {
  // オーバレイとメモの内容を取得
  const memoModal = document.getElementById("overlay-memo");
  const memoModalContent = document.getElementById("content-memo");

  // 灰色部分クリック時にクローズ処理がなされるようにイベント設定
  if (memoModal) {
    memoModal.addEventListener("click", function (event) {
      if (showMemoContent.value === true) {
        showMemoContent.value = false;
      } else {
        return;
      }
    });
  }

  // 灰色の部分以外（content-memo）をクリックした時にはイベント伝搬を止め、クローズさせない
  if (memoModalContent) {
    memoModalContent.addEventListener("click", function (event) {
      event.stopPropagation();
    });
  }
});

// メモ機能呼び出しのショートカットキーを追加
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.altKey && event.key === "m") {
    event.preventDefault(); // デフォルトのブラウザのショートカットをキャンセル
    onOpenCloseMemoModal();
  }
};

// コンポーネントマウント時にイベントリスナーを追加
onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
});

// コンポーネントがアンマウントされた際にイベントリスナーを削除
onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
});

const showSplashScreen = ref(true);
provide("showSplashScreen", showSplashScreen);
// スプラッシュスクリーンを3秒後に非表示にする
onMounted(() => {
  setTimeout(() => {
    showSplashScreen.value = false;
  }, 1800);
});
</script>

<template>
  <div v-if="showSplashScreen" id="splash-screen">
    <img :src="`${assetsUrl}icon-512x512.png`" alt="App Logo" class="logo" />
    <h1 id="splash-title">GeoCode-Web</h1>
  </div>
  <div class="app-header">
    <h1>{{ appTitle }}</h1>
  </div>
  <div class="other-function-btn-zone">
    <a
      v-if="isShowHelpIcon"
      href="https://geocode-web-single.pages.dev/user-guide"
      target="_blank"
      ref="nooperner noreferer"
      class="btn-memo-open-close"
      title="Help"
    >
      <img :src="`${assetsUrl}help_24.png`" class="btn-img" alt="help_24.png" />
    </a>
    <button
      v-if="isShowMemoIcon"
      class="btn-memo-open-close"
      title="Memo"
      v-on:click="onOpenCloseMemoModal"
    >
      <img :src="`${assetsUrl}memo_24.png`" class="btn-img" alt="memo_24.png" />
    </button>
    <button
      v-if="isExitIcon"
      class="btn-memo-open-close"
      title="ログアウト&#10;アカウントを変更します。"
      v-on:click="loginRedirect"
    >
      <img :src="`${assetsUrl}exit_24.png`" class="btn-img" alt="exit_24.png" />
    </button>
  </div>
  <div class="main-content-zone">
    <RouterView />

    <!-- メモモーダル -->
    <transition>
      <div id="overlay-memo" v-show="showMemoContent">
        <div id="content-memo">
          <h1 class="memo-title">MEMO</h1>
          <textarea name="memo-textarea" id="memo-textarea"></textarea>
          <button v-on:click="onOpenCloseMemoModal()">閉じる</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.app-header h1 {
  background-color: black;
  color: whitesmoke;
  text-align: center;
  font-size: 40px;
  margin: -8px -8px 10px -8px;
  padding: 5px;
}

a {
  color: whitesmoke;
  text-decoration: none;
}

.main-content-zone {
  width: 100%;
}

.v-enter-active,
.v-leave-active {
  transition: all 0.3s ease-in-out;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}

.other-function-btn-zone {
  display: flex;
  gap: 18px;
  z-index: 5;
  position: fixed;
  top: 1%;
  right: 1%;
}

/* メモモーダル */
#overlay-memo {
  z-index: 4;
  position: fixed;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* メモモーダルのコンテンツ */
#content-memo {
  z-index: 5;
  height: 100%;
  width: 80%;
  padding: 1em;
  margin-left: 70%;
  background: whitesmoke;
  overflow-y: auto;
  text-align: right;
}

.memo-title {
  color: rgb(56, 56, 56);
  text-align: center;
  padding: 5px;
  font-size: 40px;
  margin-bottom: -1%;
}

#memo-textarea {
  width: 100%;
  height: 80%;
  font-size: 22px;
  margin-bottom: 10px;
}

#memo-textarea:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.btn-memo-open-close {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 35px;
  height: 35px;
  background: whitesmoke;
  color: #fff;
  padding: 5px 5px;
  text-decoration: none;
  border: 1px solid rgb(207, 207, 207);
  border-radius: 50%;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 0 10px 0;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  cursor: pointer;
}

.btn-memo-open-close:hover {
  opacity: 0.7;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  transition: border-color 0.25s;
  background-color: #5f5f5f;
  color: #ffffff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
}
button {
  cursor: pointer;
}
button:hover {
  border-color: #396cd8;
}
button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}

#splash-screen {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #727272, #ffffff);
  color: white;
  text-align: center;
  z-index: 1000;
  z-index: 10;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

#splash-title {
  color: #505050;
  font-size: 2.5rem;
  font-family: "Roboto", sans-serif;
  font-weight: 700;
  text-shadow: 2px 1px 2px rgb(165, 165, 165);
  letter-spacing: 1px;
  text-align: center;
  letter-spacing: 2px;
  margin: 0;
  padding: 20px 10px;
  animation: fade-in 1.5s ease-in-out;
}

.logo {
  width: 100px;
  height: auto;
  animation: fade-in 1.5s ease-in-out;
  z-index: 1000;
  border: none;
  box-shadow: none;
}

.message {
  margin-top: 20px;
  font-size: 18px;
  animation: fade-in 2s ease-in-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
