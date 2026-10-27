import { defineStore } from "pinia";
import { useMapObjectStore } from "./mapobjects";
import { useShapeStore } from "./shapes";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    accountId: "",
    isAuthenticated: true, // デフォルトでは認証されているとする
    isReauthenticationPending: false,
    isTokenRotationPending: false,
  }),
  actions: {
    setAccount(id: string) {
      this.accountId = id;
      useMapObjectStore().setAccount(id);
      useShapeStore().setAccount(id);
    },
    beginReauthentication() {
      this.isReauthenticationPending = true;
    },
    cancelReauthentication() {
      this.isReauthenticationPending = false;
    },
    beginTokenRotation() {
      this.isTokenRotationPending = true;
    },
    endTokenRotation() {
      this.isTokenRotationPending = false;
    },
    login() {
      this.isAuthenticated = true;
      this.isReauthenticationPending = false;
      this.isTokenRotationPending = false;
    },
    logout() {
      this.accountId = "";
      useMapObjectStore().resetCache();
      useShapeStore().resetCache();
      this.isAuthenticated = false;
      this.isReauthenticationPending = false;
      this.isTokenRotationPending = false;
    },
  },
});
