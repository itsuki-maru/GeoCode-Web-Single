import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./AppMobile.vue";
import router from "./router";
import { assetsUrl } from "@/settingMobile";
import { useApplicationInitStore } from "./stores/appInits";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${assetsUrl}service-worker.js`)
      .then((registration) => {
        console.log("Service Worker registered: ", registration);
      })
      .catch((error) => {
        console.log("Service Worker registration failed:", error);
      });
  });
}

// 初期情報データ取得（非同期）
useApplicationInitStore(pinia)
  .init()
  .finally(() => {
    const appInitStore = useApplicationInitStore();
    appInitStore.init();
    app.mount("#app");
  });
