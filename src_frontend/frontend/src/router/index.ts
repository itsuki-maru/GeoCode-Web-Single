import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import { useImageStore } from "@/stores/images";
import { authCheckUrl } from "./urls";
import apiClient from "@/axiosClient";

const routeSettings: RouteRecordRaw[] = [
  {
    path: "/",
    name: "top",
    component: () => {
      return import("@/views/AppTop.vue");
    },
  },
  {
    path: "/mapview",
    name: "map",
    component: () => {
      return import("@/views/MapView.vue");
    },
    beforeEnter: async (to, from, next) => {
      // 認証確認
      try {
        const res = await apiClient.get(authCheckUrl);
        const mapobjStore = useMapObjectStore();
        mapobjStore.initList();
        const layersStore = useLayersStore();
        layersStore.initList();
        const imageStore = useImageStore();
        imageStore.initList();
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
      return import("@/views/auth/LoginView.vue");
    },
    beforeEnter: (to, from, next) => {
      next();
    },
  },
  {
    path: "/account/signup",
    name: "signup",
    component: () => {
      return import("@/views/auth/SignupView.vue");
    },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routeSettings,
});

export default router;
