import { defineStore } from "pinia";
import type { LayersData } from "@/interface";
import { getLayersUrl, deleteLayersUrl, updateLayersUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

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
    async initList(
      options: {
        signal?: AbortSignal;
        isCurrent?: () => boolean;
        accountId?: string;
      } = {},
    ): Promise<boolean> {
      try {
        const current = () => !options.signal?.aborted && options.isCurrent?.() !== false;
        if (!current()) return false;
        const config = {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.accountId !== undefined
            ? { headers: { "X-AI-Account-ID": options.accountId } }
            : {}),
        };
        const response = Object.keys(config).length
          ? await apiClient.get(getLayersUrl, config)
          : await apiClient.get(getLayersUrl);
        if (!current()) return false;
        const layersData = response.data;
        if (options.accountId !== undefined) {
          if (
            !options.accountId ||
            !layersData ||
            typeof layersData !== "object" ||
            !Object.keys(layersData).length ||
            Object.values(layersData).some(
              (layer) =>
                !layer ||
                typeof layer !== "object" ||
                (layer as { user_id?: unknown }).user_id !== options.accountId,
            )
          )
            return false;
        }
        const next = new Map<string, LayersData>();
        for (let key in layersData) {
          next.set(layersData[key]["id"], {
            id: layersData[key]["id"],
            user_id: layersData[key]["user_id"],
            name: layersData[key]["layer_name"],
            is_master: layersData[key]["is_master"],
            restrict_free_text: !!layersData[key]["restrict_free_text"],
            marker_icon_id: layersData[key]["marker_icon_id"],
            marker_icon_filename: layersData[key]["marker_icon_filename"],
          });
        }
        let sortedDsc = new Map([...next.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)));
        if (!current()) return false;
        this.layersList = sortedDsc;
        return true;
      } catch (error) {
        console.error(`Layers Store: Init List Error.`);
        return false;
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
    async updateLayer(id: string, name: string, markerIconId?: string | null): Promise<void> {
      const updateURL = `${updateLayersUrl}${id}`;
      const payload = {
        name: name,
        marker_icon_id: markerIconId ?? null,
        update_marker_icon: markerIconId !== undefined,
      };
      try {
        const response = await apiClient.put(updateURL, payload);
        this.clearLayers();
        await this.initList();
      } catch (error) {
        console.error(error);
      }
    },
    async deleteLayer(id: string): Promise<boolean> {
      const deleteURL = `${deleteLayersUrl}${id}`;
      try {
        await apiClient.delete(deleteURL);
        return true;
      } catch (error) {
        console.error(error);
        return false;
      }
    },
    clearLayers(): void {
      this.layersList.clear();
    },
  },
});
