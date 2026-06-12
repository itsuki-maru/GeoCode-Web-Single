import { defineStore } from "pinia";
import type { ImageData } from "@/interface";
import { imageListGetUrl, imageSearchUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

interface State {
  imageList: Map<string, ImageData>;
}

export const useImageStore = defineStore("images", {
  state: (): State => {
    return {
      imageList: new Map<string, ImageData>(),
    };
  },
  getters: {
    getById: (state) => {
      return (id: string): ImageData => {
        const image = state.imageList.get(id) as ImageData;
        return image;
      };
    },
  },
  actions: {
    setImageList(imagesData: Record<string, ImageData>): void {
      this.imageList.clear();
      for (const image of Object.values(imagesData)) {
        this.imageList.set(image.id, {
          id: image.id,
          filename: image.filename,
          uuid_filename: image.uuid_filename,
        });
      }
      let sortedDsc = new Map(
        [...this.imageList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
      );
      this.imageList = sortedDsc;
    },
    async initList(): Promise<void> {
      try {
        const url = `${imageListGetUrl}/50`; // 50件のみ取得
        const response = await apiClient.get(url);
        this.setImageList(response.data);
      } catch (error) {
        console.error(`Images Store: Init List Error.`);
        throw error;
      }
    },
    addImage(image: ImageData): void {
      this.imageList.set(image.id, {
        id: image.id,
        filename: image.filename,
        uuid_filename: image.uuid_filename,
      });
    },
    deleteImage(image_id: string): void {
      console.log("Delete image.");
      this.imageList.delete(image_id);
    },
    async queryImage(query: string): Promise<void> {
      if (query === "") {
        await this.initList();
        return;
      }
      try {
        const response = await apiClient.get(imageSearchUrl, {
          params: {
            query,
            limit: 50,
          },
        });
        this.setImageList(response.data);
      } catch (error) {
        console.error(`Images Store: Query Image Error.`);
        throw error;
      }
    },
  },
});
