import { defineStore } from "pinia";
import type { ApplicationInit } from "../interface";
import axios from "axios";
import { getAppIniturl } from "@/router/urls";

const DEFAULT_STATE: ApplicationInit = {
  appTitle: "",
  allowUserAccountCreate: false,
  allowUserUpdatePassword: false,
  allowOrigins: "",
};

interface State {
  appInitData: ApplicationInit;
}

export const useApplicationInitStore = defineStore("appInits", {
  state: (): State => {
    return {
      appInitData: DEFAULT_STATE,
    };
  },
  actions: {
    async init(): Promise<void> {
      try {
        const response = await axios.get(getAppIniturl);
        if (response) {
          this.appInitData.appTitle = response.data["app_title"];
          this.appInitData.allowUserAccountCreate = response.data["allow_user_account_create"];
          this.appInitData.allowUserUpdatePassword = response.data["allow_user_update_password"];
          this.appInitData.allowOrigins = response.data["allow_origins"];
        }
      } catch (error) {
        console.error("Init data get error.");
      }
    },
    // クリア
    clear() {
      this.appInitData = DEFAULT_STATE;
    },
  },
});
