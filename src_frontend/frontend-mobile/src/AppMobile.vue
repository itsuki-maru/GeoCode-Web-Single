<script setup lang="ts">
import { useRouter } from "vue-router";
import { provide, onMounted, onUnmounted, ref } from "vue";
import { assetsUrl } from "@/settingMobile";
import { useApplicationInitStore } from "./stores/appInits";

const appInitStore = useApplicationInitStore();
const appTitle = ref(appInitStore.appInitData.appTitle);

// MapView.vueへのリダイレクト
const router = useRouter();
const mapviewRedirect = (): void => {
  router.push("/mapview");
};

mapviewRedirect();

// メモアイコンの表示非表示管理
const isShowMemoIcon = ref(true);
// 他の子コンポーネントで表示・非表示を切り替えられるようにprovide
provide("isShowMemoIcon", isShowMemoIcon);

// アプリケーションヘッダー
const isShowAppHeader = ref(true);
provide("isShowAppHeader", isShowAppHeader);

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
  <h1 id="app-header" v-show="isShowAppHeader">{{ appTitle }}</h1>
  <div class="main-content-zone">
    <RouterView />
  </div>
</template>

<style scoped>
#app-header {
  color: #ffffff;
  font-size: 1.8rem;
  font-weight: 700;
  text-shadow: 2px 1px 2px rgb(165, 165, 165);
  letter-spacing: 1px;
  text-align: center;
  letter-spacing: 2px;
  margin: 0;
  padding: 12px 10px;
  background-color: rgb(27, 27, 27);
  box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.3);
}

a {
  color: whitesmoke;
  text-decoration: none;
}

.main-content-zone {
  margin: 0 -8px -8px -8px;
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
}

.btn-memo-open-close {
  width: 35px;
  height: 35px;
  background: whitesmoke;
  color: #fff;
  padding: 5px 5px;
  text-decoration: none;
  border: 1px solid rgb(207, 207, 207);
  border-radius: 20px;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 5px 10px 5px;
}

.btn-memo-open-close:hover {
  opacity: 0.7;
}

.btn-memo-close {
  width: 80px;
  font-size: 18px;
  position: fixed;
  bottom: 2%;
  right: 20px;
  background: gray;
  color: #fff;
  padding: 10px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 20px;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 5px 10px 5px;
}

#splash-screen {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: #59595e;
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
  color: #f5f5f5;
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
