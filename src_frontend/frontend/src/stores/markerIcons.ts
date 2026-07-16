import { defineStore } from "pinia";
import type { MarkerIconData } from "@/interface";
import apiClient from "@/axiosClient";
import {
  markerIconDeleteUrl,
  markerIconListUrl,
  markerIconSearchUrl,
  markerIconUploadUrl,
} from "@/router/urls";

interface State {
  icons: MarkerIconData[];
}

export const useMarkerIconStore = defineStore("markerIcons", {
  state: (): State => ({ icons: [] }),
  actions: {
    async load(query = ""): Promise<void> {
      const response = query
        ? await apiClient.get(markerIconSearchUrl, { params: { query } })
        : await apiClient.get(markerIconListUrl);
      this.icons = response.data;
    },
    async upload(file: File): Promise<MarkerIconData> {
      const form = new FormData();
      form.append("upload_file", file);
      const response = await apiClient.post(markerIconUploadUrl, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await this.load();
      return response.data;
    },
    async remove(id: string): Promise<void> {
      await apiClient.delete(`${markerIconDeleteUrl}${id}`);
      await this.load();
    },
  },
});
