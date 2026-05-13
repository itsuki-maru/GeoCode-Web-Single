import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import App from "./AdminApp.vue";
import router from "./router";
import "./assets/github.css";
import { useApplicationInitStore } from "./stores/appInits";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

// 初期情報データ取得（非同期）
useApplicationInitStore(pinia)
  .init()
  .finally(() => {
    const appInitStore = useApplicationInitStore();
    appInitStore.init();
    app.mount("#app");
  });
