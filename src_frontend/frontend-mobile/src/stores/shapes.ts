import { defineStore } from "pinia";
import type { ShapeData, ShapeGeoJson } from "@/interface";
import { shapeUrl, shapesUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

interface State {
  shapeList: Map<string, ShapeData>;
}

export const useShapeStore = defineStore("shapes", {
  state: (): State => ({ shapeList: new Map<string, ShapeData>() }),
  getters: {
    getById:
      (state) =>
      (id: string): ShapeData | undefined =>
        state.shapeList.get(id),
  },
  actions: {
    async queryShapes(layerId?: string, isMaster: boolean = true): Promise<boolean> {
      try {
        const params = new URLSearchParams({ is_master: String(isMaster) });
        if (layerId) params.set("layer_id", layerId);
        const response = await apiClient.get<ShapeData[]>(`${shapesUrl}?${params.toString()}`);
        this.shapeList = new Map(
          response.data.map((shape): [string, ShapeData] => [shape.id, shape]).reverse(),
        );
        return true;
      } catch (error) {
        console.error("Shapes Store: Query Error.", error);
        return false;
      }
    },
    async updateShape(
      id: string,
      name: string,
      layerId: string,
      geojson: ShapeGeoJson,
    ): Promise<ShapeData | null> {
      try {
        await apiClient.put(`${shapeUrl}${id}`, {
          name,
          layer_id: layerId,
          geojson,
        });
        const current = this.shapeList.get(id);
        if (current) {
          const updated: ShapeData = {
            ...current,
            name: name.trim() || null,
            layer_id: layerId,
            geojson,
            updated_at: new Date().toISOString(),
          };
          this.shapeList.set(id, updated);
          return updated;
        }
        return null;
      } catch (error) {
        console.error("Shapes Store: Update Error.", error);
        return null;
      }
    },
  },
});
