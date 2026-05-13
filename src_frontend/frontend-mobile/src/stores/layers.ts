import { defineStore } from "pinia";
import type { LayersData } from "@/interface";
import { getLayersUrl, deleteLayersUrl, updateLayersUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import { useMapObjectStore } from "@/stores/mapobjects";

interface State {
  layersList: Map<string, LayersData>;
}

export const useLayersStore = defineStore("layers", {
  state: (): State => {
    return {
      layersList: new Map<string, LayersData>(),
    };
  },
  getters: {
    getById: (state) => {
      return (id: string): LayersData => {
        const layer = state.layersList.get(id) as LayersData;
        return layer;
      };
    },
  },
  actions: {
    async initList(): Promise<void> {
      try {
        const response = await apiClient.get(getLayersUrl);
        this.layersList.clear();
        const layersData = response.data;
        for (let key in layersData) {
          this.layersList.set(layersData[key]["id"], {
            id: layersData[key]["id"],
            user_id: layersData[key]["user_id"],
            name: layersData[key]["layer_name"],
            is_master: layersData[key]["is_master"],
          });
        }
        let sortedDsc = new Map(
          [...this.layersList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)),
        );
        this.layersList = sortedDsc;
      } catch (error) {
        console.error(`Layers Store: Init List Error.`);
      }
    },
    addNewLayer(layerName: string): void {
      console.log(layerName);
      // try {
      //     const postUrl = `${addLayerUrl}?name=${layerName}`
      //     const response = await axios.post(
      //         postUrl
      //     );
      //     this.layersList.set(layer.id, {
      //         id: response.data["id"],
      //         name: layerName,
      //     });
      // } catch (error) {
      //     console.log(error);
      // }
    },
    async updateLayer(id: string, name: string): Promise<void> {
      const updateURL = `${updateLayersUrl}${id}`;
      const payload = {
        name: name,
      };
      try {
        const response = await apiClient.put(updateURL, payload);
        this.clearLayers();
        this.initList();
      } catch (error) {
        console.error(error);
      }
    },
    async deleteLayer(id: string): Promise<void> {
      const markersStore = useMapObjectStore();
      const deleteURL = `${deleteLayersUrl}${id}`;
      try {
        const response = await apiClient.delete(deleteURL);
        this.initList();
      } catch (error) {
        console.error(error);
      }
      this.layersList.delete(id);
      markersStore.initList();
    },
    clearLayers(): void {
      this.layersList.clear();
    },
  },
});
