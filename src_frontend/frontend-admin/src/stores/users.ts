import { defineStore } from "pinia";
import type { UserData, UpdateUserData } from "@/interface";
import { getUsersUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

interface State {
  usersList: Map<string, UserData>;
}

export const useUsersStore = defineStore("user", {
  state: (): State => {
    return {
      usersList: new Map<string, UserData>(),
    };
  },
  getters: {
    getById: (state) => {
      return (id: string): UserData => {
        const user = state.usersList.get(id) as UserData;
        return user;
      };
    },
  },
  actions: {
    async initList(): Promise<void> {
      try {
        const response = await apiClient.get(getUsersUrl);
        this.usersList.clear();
        const usersData = response.data;
        for (let key in usersData) {
          this.usersList.set(usersData[key]["id"], {
            id: usersData[key]["id"],
            username: usersData[key]["username"],
            password: usersData[key]["password"],
            create_at: usersData[key]["create_at"],
            is_superuser: usersData[key]["is_superuser"],
            is_locked: usersData[key]["is_locked"],
          });
        }
        let sortedDsc = new Map(
          [...this.usersList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
        );
        this.usersList = sortedDsc;
      } catch (error) {
        console.log("Init List Error.");
      }
    },
  },
});
