import { defineStore } from "pinia";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    isAuthenticated: true, // デフォルトでは認証されているとする
  }),
  actions: {
    logout() {
      this.isAuthenticated = false;
    },
  },
});
