import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { authCheckUrl } from "./urls";
import apiClient from "@/axiosClient";

const routeSettings: RouteRecordRaw[] = [
  {
    path: "/",
    name: "top",
    component: () => {
      return import("@/views/AppTopMobile.vue");
    },
  },
  {
    path: "/mapview",
    name: "map",
    component: () => {
      return import("@/views/MapViewMobile.vue");
    },
    beforeEnter: async (to, from, next) => {
      // 認証確認
      try {
        await apiClient.get(authCheckUrl);
        // 正常処理
        next();
      } catch (error) {
        // 失敗したらログイン画面に飛ばす
        next({ name: "login" });
      }
    },
  },
  {
    path: "/account/login",
    name: "login",
    component: () => {
      return import("@/views/auth/LoginViewMobile.vue");
    },
    beforeEnter: (to, from, next) => {
      next();
    },
  },
  {
    path: "/account/signup",
    name: "signup",
    component: () => {
      return import("@/views/auth/SignupViewMobile.vue");
    },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routeSettings,
});

export default router;
