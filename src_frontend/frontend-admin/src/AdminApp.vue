<script setup lang="ts">
import { reactive, provide, ref } from "vue";
import type { LoginUser } from "./interface";
import { useRouter } from "vue-router";
import { useApplicationInitStore } from "./stores/appInits";

const appInitStore = useApplicationInitStore();
const appTitle = ref(appInitStore.appInitData.appTitle);

// Login User Status Provide.
const loginUser: LoginUser = {
  isAuthenticated: false,
};
provide("loginUser", reactive(loginUser));

// List.vueへリダイレクト
const router = useRouter();
const listRedirect = (): void => {
  router.push("/users/list");
};

listRedirect();
</script>

<template>
  <div class="container">
    <header class="parent-header">
      <h1 class="app-header" id="application-title">{{ appTitle }} -管理者画面-</h1>
    </header>
    <RouterView />
  </div>
</template>

<style>
html {
  scroll-behavior: smooth;
}

.container {
  height: 100%;
}

.v-enter-active,
.v-leave-active {
  transition: all 0.3s ease-in-out;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}

.parent-header {
  border-bottom: solid 1px gray;
  display: flex;
  justify-content: space-between;
  margin-bottom: 7px;
}

.app-header {
  color: #303030;
  text-shadow: 2px 1px 2px rgb(165, 165, 165);
  letter-spacing: 1px;
  font-size: 40px;
  margin-bottom: 0;
}

.app-header a {
  color: #4183c4;
}

.other-function-btn-zone {
  display: flex;
  z-index: 5;
  position: fixed;
  top: 1%;
  right: 1%;
}

a {
  text-decoration: none;
}

/* 目次のリンク（github.cssを上書き） */
.toc-content a {
  text-decoration: none;
  color: black;
}

/* ホバー */
.toc-content a:hover {
  background-color: #c1d1d6;
  display: inline-block;
  text-decoration: underline;
  /* transform を適用するために必要 */
}

.app-header a:hover {
  transform: scale(1.03);
  display: inline-block;
  text-decoration: underline;
  /* transform を適用するために必要 */
}

/**
* マークダウンプレビューのh1、h2タイトル用
*/
.head1 {
  font-size: 32px;
  margin-bottom: -1%;
  border-bottom: solid 3px #d7d7d7;
}

.head2 {
  font-size: 20px;
  color: black;
  margin-top: 2%;
  padding: 0.1em 0.3em;
  background: #f4f4f4;
  border-left: solid 5px #daac9e;
  border-bottom: solid 3px #d7d7d7;
}

.input-textbox {
  font-size: 24px;
  width: 100%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.btn-modal-save {
  width: 90px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  height: 40px;
  font-size: 16px;
  background: rgb(36, 164, 168);
  color: #fff;
  padding: 10px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 5px;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 5px 10px 5px;
}

.btn-modal-save:hover {
  opacity: 0.7;
}

.btn-modal-yes {
  width: 90px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  height: 40px;
  font-size: 16px;
  background: rgb(70, 54, 219);
  color: #fff;
  padding: 10px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 5px;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 5px 10px 5px;
}

.btn-modal-yes:hover {
  opacity: 0.7;
}

.btn-modal-no {
  width: 90px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  height: 40px;
  font-size: 16px;
  background: rgb(100, 126, 140);
  color: #fff;
  padding: 10px 7px;
  text-decoration: none;
  border: 1px;
  border-radius: 5px;
  transition-property: opacity;
  -webkit-transition-property: opacity;
  transition-duration: 0.5s;
  -webkit-transition-duration: 0.5s;
  margin: 5px 5px 10px 5px;
}

.btn-modal-no:hover {
  opacity: 0.7;
}

.setting-contents {
  text-align: center;
}

/* QR生成ボタンの間隔 */
.btn-zone {
  margin-top: 5%;
  display: flex;
  justify-content: space-between;
}

/* 最後のボタンの右側のマージンを0にする（オプショナル） */
.btn-zone button:last-child {
  margin-right: 0;
}

/**
* Update.vueのDiffモーダル用
*/
/* 削除されたテキスト */
.delete {
  display: inline-block;
  margin-top: 1px;
  text-decoration: none;
  background-color: #ffb6ba;
  border-radius: 0.2em;
}

/* 追加されたテキスト */
.added {
  display: inline-block;
  margin-top: -1px;
  text-decoration: none;
  background-color: #97f295;
  border-radius: 0.2em;
}
</style>
