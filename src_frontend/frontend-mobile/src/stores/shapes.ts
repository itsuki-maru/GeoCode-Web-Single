import { defineStore } from "pinia";
import type { ShapeData, ShapeGeoJson } from "@/interface";
import { shapeUrl, shapesUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

interface State {
  loadRevision: number;
  shapeList: Map<string, ShapeData>;
}

export const useShapeStore = defineStore("shapes", {
  state: (): State => ({ shapeList: new Map<string, ShapeData>(), loadRevision: 0 }),
  getters: {
    getById:
      (state) =>
      (id: string): ShapeData | undefined =>
        state.shapeList.get(id),
  },
  actions: {
    clearShapeList(): void {
      ++this.loadRevision;
      this.shapeList.clear();
    },
    async queryShapes(
      layerId?: string,
      isMaster: boolean = true,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const revision = ++this.loadRevision;
      try {
        const params = new URLSearchParams({ is_master: String(isMaster) });
        if (layerId) params.set("layer_id", layerId);
        const requestUrl = `${shapesUrl}?${params.toString()}`;
        const response = signal
          ? await apiClient.get<ShapeData[]>(requestUrl, { signal })
          : await apiClient.get<ShapeData[]>(requestUrl);
        if (signal?.aborted || revision !== this.loadRevision) return false;
        this.shapeList = new Map(
          response.data.map((shape): [string, ShapeData] => [shape.id, shape]).reverse(),
        );
        return true;
      } catch (error) {
        if (signal?.aborted || revision !== this.loadRevision) return false;
        console.error("Shapes Store: Query Error.", error);
        return false;
      }
    },
    async updateShape(
      id: string,
      name: string,
      layerId: string,
      geojson?: ShapeGeoJson,
      bodyEdit?: { free_text: string; body_token: string },
    ): Promise<ShapeData | null> {
      try {
        await apiClient.put(`${shapeUrl}${id}`, {
          name,
          layer_id: layerId,
          geojson,
          ...bodyEdit,
        });
        const current = this.shapeList.get(id);
        if (current) {
          const updated: ShapeData = {
            ...current,
            name: name.trim() || null,
            layer_id: layerId,
            geojson: geojson ?? current.geojson,
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
