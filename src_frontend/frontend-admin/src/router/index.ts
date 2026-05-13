import { createRouter, createWebHistory } from "vue-router";
import { getUserUrl } from "@/router/urls";
import type { RouteRecordRaw } from "vue-router";
import apiClient from "@/axiosClient";

const routeSettings: RouteRecordRaw[] = [
  {
    path: "/users/list",
    name: "List",
    component: () => {
      return import("@/views/users/AdminUsersList.vue");
    },
    beforeEnter: async (to, from, next) => {
      // 認証確認
      try {
        const res = await apiClient.get(getUserUrl);
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
      return import("@/views/auth/LoginViewAdmin.vue");
    },
    beforeEnter: (to, from, next) => {
      next();
    },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routeSettings,
});

export default router;
