import { defineStore } from "pinia";
import { markRaw } from "vue";
import type { ShapeData, ShapeGeoJson } from "@/interface";
import { shapeUrl, shapesUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import { MapRecordCache } from "./map-record-cache";
import { MapTableChanges } from "./map-table-changes";

export const useShapeStore = defineStore("shapes", {
  state: () => ({
    loadRevision: 0,
    tableChanges: markRaw(new MapTableChanges()),
    shapeList: new Map<string, ShapeData>(),
    activeLayerId: "",
    activeIsMaster: true,
    mutationRevision: 0,
    mutationVersions: new Map<string, number>(),
    dirtyIds: new Set<string>(),
    recordCache: markRaw(new MapRecordCache<ShapeData>()),
  }),
  getters: {
    getById:
      (state) =>
      (id: string): ShapeData | undefined =>
        state.recordCache.records.get(id) ?? state.shapeList.get(id),
  },
  actions: {
    setAccount(id: string) {
      if (this.recordCache.setAccount(id)) {
        this.clearShapeList();
        this.mutationVersions.clear();
        this.dirtyIds.clear();
      }
    },
    clearShapeList() {
      ++this.loadRevision;
      this.shapeList.clear();
      this.tableChanges.emit({ type: "reset" });
    },
    resetCache() {
      this.recordCache.reset();
      this.clearShapeList();
      this.mutationVersions.clear();
      this.dirtyIds.clear();
    },
    invalidateCache() {
      this.recordCache.invalidate();
      ++this.loadRevision;
    },
    getScopeRecords(layerId?: string, isMaster?: boolean): ShapeData[] {
      return this.recordCache.getRecords(
        layerId ?? this.activeLayerId,
        isMaster ?? this.activeIsMaster,
      );
    },
    activateScope(layerId: string, isMaster: boolean) {
      this.activeLayerId = layerId;
      this.activeIsMaster = isMaster;
      this.recordCache.setActive(layerId, isMaster);
      this.refreshVisibleRecords();
    },
    refreshVisibleRecords() {
      this.shapeList = new Map(
        this.getScopeRecords()
          .map((record) => [record.id, record] as const)
          .reverse(),
      );
      this.tableChanges.emit({ type: "reset" });
    },
    upsertRecord(record: ShapeData) {
      if (!this.recordCache.upsert(record)) return false;
      this.mutationVersions.set(record.id, ++this.mutationRevision);
      this.dirtyIds.add(record.id);
      if (this.activeIsMaster || record.layer_id === this.activeLayerId)
        this.shapeList.set(record.id, record);
      else this.shapeList.delete(record.id);
      this.tableChanges.emit({ type: "record", kind: "shape", id: record.id });
      return true;
    },
    removeRecord(id: string) {
      this.recordCache.remove(id);
      this.mutationVersions.set(id, ++this.mutationRevision);
      this.dirtyIds.add(id);
      this.shapeList.delete(id);
      this.tableChanges.emit({ type: "record", kind: "shape", id });
    },
    async queryShapes(
      layerId = "",
      isMaster = true,
      signal?: AbortSignal,
      force = false,
    ): Promise<boolean> {
      const revision = ++this.loadRevision;
      this.activeLayerId = layerId;
      this.activeIsMaster = isMaster;
      this.recordCache.setActive(layerId, isMaster);
      const params = new URLSearchParams({ is_master: String(isMaster) });
      if (layerId) params.set("layer_id", layerId);
      const loaded = await this.recordCache.load(
        layerId,
        isMaster,
        async (transportSignal) => {
          const url = `${shapesUrl}?${params}`;
          const response = signal
            ? await apiClient.get<ShapeData[]>(url, { signal: transportSignal })
            : await apiClient.get<ShapeData[]>(url);
          return response.data;
        },
        force,
      );
      if (!loaded || signal?.aborted || revision !== this.loadRevision) return false;
      this.refreshVisibleRecords();
      return true;
    },
    async updateShape(
      id: string,
      name: string,
      layerId: string,
      geojson?: ShapeGeoJson,
      bodyEdit?: { free_text: string; body_token: string },
    ): Promise<ShapeData | null> {
      const generation = this.recordCache.generation;
      try {
        const response = await apiClient.put(`${shapeUrl}${id}`, {
          name,
          layer_id: layerId,
          geojson,
          ...bodyEdit,
        });
        if (generation !== this.recordCache.generation) return null;
        const current = this.getById(id);
        const updated: ShapeData | undefined =
          response.data?.object ??
          (current && {
            ...current,
            name: name.trim() || null,
            layer_id: layerId,
            geojson: geojson ?? current.geojson,
            updated_at: new Date().toISOString(),
          });
        if (!updated) return null;
        this.upsertRecord(updated);
        return this.getById(id) ?? null;
      } catch (error) {
        console.error("Shapes Store: Update Error.", error);
        return null;
      }
    },
  },
});
