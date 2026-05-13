<script setup lang="ts">
import { ref, inject } from "vue";
import type { Ref } from "vue";
import { getTokenUrl } from "@/router/urls";
import { useRouter } from "vue-router";
import apiClient from "@/axiosClient";

// List.vueへのリダイレクト
const router = useRouter();
const listRedirect = (): void => {
  router.push("/users/list");
};

// 処理結果のメッセージ表示モーダル
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

const loginPost = async (): Promise<void> => {
  const username = loginInfo.value.username;
  const password = loginInfo.value.password;

  if (username == "" || password == "") {
    return;
  }

  const data = {
    username: username,
    password: password,
  };

  try {
    const response = await apiClient.post(getTokenUrl, data);
    listRedirect();
  } catch (error) {
    loginInfo.value.password = "";
    messageModalOpenClose("パスワードかユーザー名が間違っています。");
  }
};

interface typeLogin {
  username: string;
  password: string;
}

const loginInfoInit: typeLogin = {
  username: "",
  password: "",
};

const loginInfo = ref(loginInfoInit);
</script>

<template>
  <section>
    <div class="login">
      <h1>Login</h1>
      <!-- v-on:submit.prevent="メソッド"でリロード回避 -->
      <form method="post" v-on:submit.prevent="loginPost">
        <input
          type="text"
          pattern="^[A-Za-z0-9]{3,}$"
          title="3文字以上の大文字小文字英字数字"
          name="u"
          placeholder="ユーザー名"
          required
          v-model="loginInfo.username"
        />
        <input
          type="password"
          pattern=".{8,}"
          title="8文字以上で入力してください。"
          name="p"
          placeholder="パスワード"
          required
          v-model="loginInfo.password"
        />
        <button type="submit" class="btn btn-primary btn-block btn-large">ログイン</button>
      </form>
    </div>

    <!-- 各種メッセージモーダル -->
    <div id="overlay-message" v-show="isMessageModal">
      <div id="content-message">
        <h2>メッセージ</h2>
        <div class="input-text-zone">
          <p>
            <strong>{{ messageText }}</strong>
          </p>
        </div>
        <div class="btn-zone">
          <button v-on:click="messageModalOpenClose('No Message')" class="btn-modal-yes">
            Close
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import url(https://fonts.googleapis.com/css?family=Open+Sans);

.btn {
  display: inline-block;
  padding: 4px 10px 4px;
  margin-bottom: 0;
  font-size: 13px;
  line-height: 18px;
  color: #333333;
  text-align: center;
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.75);
  vertical-align: middle;
  background-color: #f5f5f5;
  background-image: -moz-linear-gradient(top, #ffffff, #e6e6e6);
  background-image: -ms-linear-gradient(top, #ffffff, #e6e6e6);
  background-image: -webkit-gradient(linear, 0 0, 0 100%, from(#ffffff), to(#e6e6e6));
  background-image: -webkit-linear-gradient(top, #ffffff, #e6e6e6);
  background-image: -o-linear-gradient(top, #ffffff, #e6e6e6);
  background-image: linear-gradient(top, #ffffff, #e6e6e6);
  background-repeat: repeat-x;
  filter: progid:dximagetransform.microsoft.gradient(startColorstr=#ffffff, endColorstr=#e6e6e6, GradientType=0);
  border-color: #e6e6e6 #e6e6e6 #e6e6e6;
  border-color: rgba(0, 0, 0, 0.1) rgba(0, 0, 0, 0.1) rgba(0, 0, 0, 0.25);
  border: 1px solid #e6e6e6;
  -webkit-border-radius: 4px;
  -moz-border-radius: 4px;
  border-radius: 4px;
  -webkit-box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.05);
  -moz-box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.05);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.05);
  cursor: pointer;
}

.btn:hover,
.btn:active,
.btn.active,
.btn.disabled,
.btn[disabled] {
  background-color: #e6e6e6;
}

.btn-large {
  padding: 9px 14px;
  font-size: 15px;
  line-height: normal;
  -webkit-border-radius: 5px;
  -moz-border-radius: 5px;
  border-radius: 5px;
}

.btn:hover {
  color: #333333;
  text-decoration: none;
  background-color: #e6e6e6;
  background-position: 0 -15px;
  -webkit-transition: background-position 0.1s linear;
  -moz-transition: background-position 0.1s linear;
  -ms-transition: background-position 0.1s linear;
  -o-transition: background-position 0.1s linear;
  transition: background-position 0.1s linear;
}

.btn-primary,
.btn-primary:hover {
  text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.25);
  color: #ffffff;
}

.btn-primary.active {
  color: rgba(255, 255, 255, 0.75);
}

.btn-primary {
  background-color: #4a77d4;
  background-image: -moz-linear-gradient(top, #6eb6de, #4a77d4);
  background-image: -ms-linear-gradient(top, #6eb6de, #4a77d4);
  background-image: -webkit-gradient(linear, 0 0, 0 100%, from(#6eb6de), to(#4a77d4));
  background-image: -webkit-linear-gradient(top, #6eb6de, #4a77d4);
  background-image: -o-linear-gradient(top, #6eb6de, #4a77d4);
  background-image: linear-gradient(top, #6eb6de, #4a77d4);
  background-repeat: repeat-x;
  filter: progid:dximagetransform.microsoft.gradient(startColorstr=#6eb6de, endColorstr=#4a77d4, GradientType=0);
  border: 1px solid #3762bc;
  text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.4);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.5);
}

.btn-primary:hover,
.btn-primary:active,
.btn-primary.active,
.btn-primary.disabled,
.btn-primary[disabled] {
  filter: none;
  background-color: #4a77d4;
}

.btn-block {
  width: 100%;
  display: block;
}

* {
  -webkit-box-sizing: border-box;
  -moz-box-sizing: border-box;
  -ms-box-sizing: border-box;
  -o-box-sizing: border-box;
  box-sizing: border-box;
}

html {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

body {
  width: 100%;
  height: 100%;
  font-family: "Open Sans", sans-serif;
  background: #092756;
  background:
    -moz-radial-gradient(
      0% 100%,
      ellipse cover,
      rgba(104, 128, 138, 0.4) 10%,
      rgba(138, 114, 76, 0) 40%
    ),
    -moz-linear-gradient(top, rgba(57, 173, 219, 0.25) 0%, rgba(42, 60, 87, 0.4) 100%),
    -moz-linear-gradient(-45deg, #670d10 0%, #092756 100%);
  background:
    -webkit-radial-gradient(
      0% 100%,
      ellipse cover,
      rgba(104, 128, 138, 0.4) 10%,
      rgba(138, 114, 76, 0) 40%
    ),
    -webkit-linear-gradient(top, rgba(57, 173, 219, 0.25) 0%, rgba(42, 60, 87, 0.4) 100%),
    -webkit-linear-gradient(-45deg, #670d10 0%, #092756 100%);
  background:
    -o-radial-gradient(
      0% 100%,
      ellipse cover,
      rgba(104, 128, 138, 0.4) 10%,
      rgba(138, 114, 76, 0) 40%
    ),
    -o-linear-gradient(top, rgba(57, 173, 219, 0.25) 0%, rgba(42, 60, 87, 0.4) 100%),
    -o-linear-gradient(-45deg, #670d10 0%, #092756 100%);
  background:
    -ms-radial-gradient(
      0% 100%,
      ellipse cover,
      rgba(104, 128, 138, 0.4) 10%,
      rgba(138, 114, 76, 0) 40%
    ),
    -ms-linear-gradient(top, rgba(57, 173, 219, 0.25) 0%, rgba(42, 60, 87, 0.4) 100%),
    -ms-linear-gradient(-45deg, #670d10 0%, #092756 100%);
  background:
    -webkit-radial-gradient(
      0% 100%,
      ellipse cover,
      rgba(104, 128, 138, 0.4) 10%,
      rgba(138, 114, 76, 0) 40%
    ),
    linear-gradient(to bottom, rgba(57, 173, 219, 0.25) 0%, rgba(42, 60, 87, 0.4) 100%),
    linear-gradient(135deg, #670d10 0%, #092756 100%);
  filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#3E1D6D', endColorstr='#092756', GradientType=1);
}

.login {
  position: absolute;
  top: 50%;
  left: 50%;
  margin: -150px 0 0 -150px;
  width: 300px;
  height: 300px;
}

.login h1 {
  color: steelblue;
  text-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
  letter-spacing: 1px;
  text-align: center;
}

input {
  width: 100%;
  margin-bottom: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: none;
  outline: none;
  padding: 10px;
  font-size: 13px;
  color: #fff;
  text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  box-shadow:
    inset 0 -5px 45px rgba(100, 100, 100, 0.2),
    0 1px 1px rgba(255, 255, 255, 0.2);
  -webkit-transition: box-shadow 0.5s ease;
  -moz-transition: box-shadow 0.5s ease;
  -o-transition: box-shadow 0.5s ease;
  -ms-transition: box-shadow 0.5s ease;
  transition: box-shadow 0.5s ease;
}

input:focus {
  box-shadow:
    inset 0 -5px 45px rgba(100, 100, 100, 0.4),
    0 1px 1px rgba(255, 255, 255, 0.2);
}

.login p {
  text-align: center;
}

/* メッセージモーダル */
#overlay-message {
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
}

#content-message {
  z-index: 2;
  width: 20%;
  padding: 1em;
  background: whitesmoke;
  border-radius: 10px;
}

.btn-modal-yes {
  width: 70px;
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
</style>
