import { defineStore } from "pinia";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    isAuthenticated: true, // デフォルトでは認証されているとする
    isReauthenticationPending: false,
    isTokenRotationPending: false,
  }),
  actions: {
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
      this.isAuthenticated = false;
      this.isReauthenticationPending = false;
      this.isTokenRotationPending = false;
    },
  },
});
