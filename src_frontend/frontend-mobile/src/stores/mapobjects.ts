import { defineStore } from "pinia";
import type { MapObjectData } from "@/interface";
import {
  getMapObjectsUrl,
  updateMapObjectUrl,
  deleteMapObjectUrl,
  mapQueryMarkerUrl,
} from "@/router/urls";
import apiClient from "@/axiosClient";

interface State {
  mapObjectList: Map<string, MapObjectData>;
}

export const useMapObjectStore = defineStore("mapobjects", {
  state: (): State => {
    return {
      mapObjectList: new Map<string, MapObjectData>(),
    };
  },
  getters: {
    getById: (state) => {
      return (id: string): MapObjectData => {
        const mapobj = state.mapObjectList.get(id) as MapObjectData;
        return mapobj;
      };
    },
  },
  actions: {
    async initList(): Promise<void> {
      try {
        const response = await apiClient.get(getMapObjectsUrl);
        this.mapObjectList.clear();
        const mapObjData = response.data;
        for (let key in mapObjData) {
          this.mapObjectList.set(mapObjData[key]["id"], {
            id: mapObjData[key]["id"],
            layer_id: mapObjData[key]["layer_id"],
            marker_name: mapObjData[key]["marker_name"],
            latitude: mapObjData[key]["latitude"],
            longitude: mapObjData[key]["longitude"],
            detail: mapObjData[key]["detail"],
          });
        }
        let sortedDsc = new Map(
          [...this.mapObjectList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
        );
        this.mapObjectList = sortedDsc;
      } catch (error) {
        console.log(`Mapobjects Store: Init List Error.`);
      }
    },
    async updateMapObject(
      id: string,
      name: string,
      detail: string,
      layer_id: string,
    ): Promise<void> {
      const updateURL = `${updateMapObjectUrl}${id}`;
      const payload = {
        name: name,
        detail: detail,
        layer_id: layer_id,
      };

      try {
        const response = await apiClient.put(updateURL, payload);
        this.queryMapObject(layer_id, false);
      } catch (error) {
        console.log(error);
      }
    },
    async queryMapObject(layer_id: string, is_master: boolean): Promise<boolean> {
      try {
        const requestUrl = `${getMapObjectsUrl}?layer=${layer_id}&is_master=${is_master}`;
        const response = await apiClient.get(requestUrl);
        this.mapObjectList.clear();
        const mapObjData = response.data;
        for (let key in mapObjData) {
          this.mapObjectList.set(mapObjData[key]["id"], {
            id: mapObjData[key]["id"],
            layer_id: mapObjData[key]["layer_id"],
            marker_name: mapObjData[key]["marker_name"],
            latitude: mapObjData[key]["latitude"],
            longitude: mapObjData[key]["longitude"],
            detail: mapObjData[key]["detail"],
          });
        }
        let sortedDsc = new Map(
          [...this.mapObjectList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
        );
        this.mapObjectList = sortedDsc;
        return true;
      } catch (error) {
        return false;
      }
    },

    async queryWordMapObject(
      query1: string = "",
      query2: string = "",
      activeLayer: string,
    ): Promise<void> {
      try {
        const requestUrl = `${mapQueryMarkerUrl}?query1=${query1}&query2=${query2}&layer=${activeLayer}`;
        const response = await apiClient.get(requestUrl);
        this.mapObjectList.clear();
        const mapObjData = response.data;
        for (let key in mapObjData) {
          this.mapObjectList.set(mapObjData[key]["id"], {
            id: mapObjData[key]["id"],
            layer_id: mapObjData[key]["layer_id"],
            marker_name: mapObjData[key]["marker_name"],
            latitude: mapObjData[key]["latitude"],
            longitude: mapObjData[key]["longitude"],
            detail: mapObjData[key]["detail"],
          });
        }
        let sortedDsc = new Map(
          [...this.mapObjectList.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).reverse(),
        );
        this.mapObjectList = sortedDsc;
      } catch (error) {
        console.log(error);
      }
    },

    addMapObject(mapobje: MapObjectData): void {
      this.mapObjectList.set(mapobje.id, {
        id: mapobje.id,
        marker_name: mapobje.marker_name,
        layer_id: mapobje.layer_id,
        latitude: mapobje.latitude,
        longitude: mapobje.longitude,
        detail: mapobje.detail,
      });
    },
    async deleteMapObject(id: string): Promise<void> {
      const deleteURL = `${deleteMapObjectUrl}${id}`;
      try {
        const response = await apiClient.delete(deleteURL);
      } catch (error) {
        console.log(error);
      }
      console.log("Delete MapObject.");
      this.mapObjectList.delete(id);
    },

    clearMapObject(): void {
      this.mapObjectList.clear();
    },
  },
});
