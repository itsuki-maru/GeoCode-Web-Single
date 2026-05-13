import { defineStore } from "pinia";
import type { ImageData } from "@/interface";
import { imageListGetUrl } from "@/router/urls";
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
    async initList(): Promise<void> {
      try {
        const response = await apiClient.get(imageListGetUrl);
        this.imageList.clear();
        const imagesData = response.data;
        for (let key in imagesData) {
          this.imageList.set(imagesData[key]["id"], {
            id: imagesData[key]["id"],
            filename: imagesData[key]["filename"],
            uuid_filename: imagesData[key]["uuid_filename"],
          });
        }
        let sortedDsc = new Map(
          [...this.imageList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
        );
        this.imageList = sortedDsc;
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
    queryImage(query: string): void {
      if (query === "") {
        this.initList();
        return;
      }
      let result: { id: string; filename: string; uuid_filename: string }[] = [];
      this.imageList.forEach((value, key) => {
        if (value.filename.includes(query)) {
          result.push(value);
        }
      });

      // Sort by id in descending order
      result.sort((a, b) => b.id.localeCompare(a.id));

      let resultMap: Map<string, { id: string; filename: string; uuid_filename: string }> =
        new Map();
      for (let item of result) {
        resultMap.set(item.id, item);
      }
      this.imageList = resultMap;
    },
  },
});
