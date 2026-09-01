import { defineStore } from "pinia";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    isAuthenticated: true, // デフォルトでは認証されているとする
    isReauthenticationPending: false,
  }),
  actions: {
    beginReauthentication() {
      this.isReauthenticationPending = true;
    },
    cancelReauthentication() {
      this.isReauthenticationPending = false;
    },
    login() {
      this.isAuthenticated = true;
      this.isReauthenticationPending = false;
    },
    logout() {
      this.isAuthenticated = false;
      this.isReauthenticationPending = false;
    },
  },
});
