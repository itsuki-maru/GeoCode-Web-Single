import { defineStore } from "pinia";
import { markRaw } from "vue";
import type { MapObjectData, MapObjectQueryResponse } from "@/interface";
import {
  getMapObjectsUrl,
  updateMapObjectUrl,
  deleteMapObjectUrl,
  mapQueryObjectsUrl,
} from "@/router/urls";
import apiClient from "@/axiosClient";
import { useShapeStore } from "./shapes";
import { MapRecordCache, matchesMapSearch } from "./map-record-cache";
import { MapTableChanges } from "./map-table-changes";

const ordered = (records: MapObjectData[]) =>
  new Map(records.sort((a, b) => b.id.localeCompare(a.id)).map((record) => [record.id, record]));
export const useMapObjectStore = defineStore("mapobjects", {
  state: () => ({
    loadRevision: 0,
    tableChanges: markRaw(new MapTableChanges()),
    mapObjectList: new Map<string, MapObjectData>(),
    filteredShapeIds: null as string[] | null,
    activeLayerId: "",
    activeIsMaster: true,
    search: null as { query1: string; query2: string; layerId: string } | null,
    recordCache: markRaw(new MapRecordCache<MapObjectData>()),
    mutationRevision: 0,
    mutationVersions: new Map<string, number>(),
    dirtyIds: new Set<string>(),
  }),
  getters: {
    getById:
      (state) =>
      (id: string): MapObjectData =>
        (state.recordCache.records.get(id) ?? state.mapObjectList.get(id)) as MapObjectData,
  },
  actions: {
    setAccount(id: string) {
      if (this.recordCache.setAccount(id)) {
        this.clearMapObject();
        this.mutationVersions.clear();
      }
    },
    clearMapObject() {
      ++this.loadRevision;
      this.mapObjectList.clear();
      this.clearSearch();
    },
    clearSearch() {
      this.search = null;
      this.filteredShapeIds = null;
      this.dirtyIds.clear();
      this.tableChanges.emit({ type: "reset" });
    },
    resetCache() {
      this.recordCache.reset();
      this.clearMapObject();
      this.mutationVersions.clear();
    },
    invalidateCache() {
      this.recordCache.invalidate();
      ++this.loadRevision;
    },
    getScopeRecords(layerId?: string, isMaster?: boolean): MapObjectData[] {
      return this.recordCache.getRecords(
        layerId ?? this.activeLayerId,
        isMaster ?? this.activeIsMaster,
      );
    },
    activateScope(
      layerId: string,
      isMaster: boolean,
      search?: { query1: string; query2: string; layerId: string } | null,
    ) {
      this.activeLayerId = layerId;
      this.activeIsMaster = isMaster;
      this.recordCache.setActive(layerId, isMaster);
      if (search !== undefined) this.search = search;
      this.refreshSearchResults(true);
    },
    refreshSearchResults(rebuild = false) {
      const shapes = useShapeStore();
      if (!this.search) {
        if (rebuild) this.mapObjectList = ordered(this.getScopeRecords());
        else
          for (const id of this.dirtyIds) {
            const record = this.recordCache.records.get(id);
            if (record && (this.activeIsMaster || record.layer_id === this.activeLayerId))
              this.mapObjectList.set(id, record);
            else this.mapObjectList.delete(id);
          }
        this.filteredShapeIds = null;
      } else if (rebuild) {
        const terms = [this.search.query1, this.search.query2];
        this.mapObjectList = ordered(
          this.getScopeRecords().filter((record) =>
            matchesMapSearch([record.marker_name, record.detail], terms),
          ),
        );
        this.filteredShapeIds = shapes
          .getScopeRecords(this.activeLayerId, this.activeIsMaster)
          .filter((record) =>
            matchesMapSearch([record.name, String(record.geojson?.properties?.memo ?? "")], terms),
          )
          .map((record) => record.id);
      } else {
        const terms = [this.search.query1, this.search.query2];
        for (const id of this.dirtyIds) {
          const record = this.recordCache.records.get(id);
          if (
            record &&
            (this.activeIsMaster || record.layer_id === this.activeLayerId) &&
            matchesMapSearch([record.marker_name, record.detail], terms)
          )
            this.mapObjectList.set(id, record);
          else this.mapObjectList.delete(id);
        }
        if (shapes.dirtyIds.size) {
          const ids = new Set(this.filteredShapeIds ?? []);
          for (const id of shapes.dirtyIds) {
            const record = shapes.recordCache.records.get(id);
            if (
              record &&
              (this.activeIsMaster || record.layer_id === this.activeLayerId) &&
              matchesMapSearch([record.name, String(record.geojson?.properties?.memo ?? "")], terms)
            )
              ids.add(id);
            else ids.delete(id);
          }
          this.filteredShapeIds = [...ids];
        }
      }
      if (rebuild) this.tableChanges.emit({ type: "reset" });
      else {
        for (const id of this.dirtyIds)
          this.tableChanges.emit({ type: "record", kind: "marker", id });
        for (const id of shapes.dirtyIds)
          this.tableChanges.emit({ type: "record", kind: "shape", id });
      }
      this.dirtyIds.clear();
      shapes.dirtyIds.clear();
    },
    upsertRecord(record: MapObjectData) {
      if (!this.recordCache.upsert(record)) return false;
      this.mutationVersions.set(record.id, ++this.mutationRevision);
      this.dirtyIds.add(record.id);
      this.refreshSearchResults();
      return true;
    },
    removeRecord(id: string) {
      this.recordCache.remove(id);
      this.mutationVersions.set(id, ++this.mutationRevision);
      this.dirtyIds.add(id);
      this.refreshSearchResults();
    },
    addMapObject(record: MapObjectData) {
      this.upsertRecord(record);
    },
    async initList(): Promise<void> {
      await this.queryMapObject("", true);
    },
    async queryMapObject(
      layerId: string,
      isMaster: boolean,
      signal?: AbortSignal,
      force = false,
    ): Promise<boolean> {
      const revision = ++this.loadRevision;
      this.activeLayerId = layerId;
      this.activeIsMaster = isMaster;
      this.recordCache.setActive(layerId, isMaster);
      const url = layerId
        ? `${getMapObjectsUrl}?layer=${encodeURIComponent(layerId)}&is_master=${isMaster}`
        : getMapObjectsUrl;
      const loaded = await this.recordCache.load(
        layerId,
        isMaster,
        async (transportSignal) => {
          const response = signal
            ? await apiClient.get<Record<string, MapObjectData>>(url, { signal: transportSignal })
            : await apiClient.get<Record<string, MapObjectData>>(url);
          return Object.values(response.data);
        },
        force,
      );
      if (!loaded || signal?.aborted || revision !== this.loadRevision) return false;
      this.clearSearch();
      this.refreshSearchResults(true);
      return true;
    },
    async queryWordMapObject(query1 = "", query2 = "", activeLayer: string): Promise<boolean> {
      const revision = ++this.loadRevision,
        mutationRevision = this.mutationRevision;
      const shapeStore = useShapeStore(),
        shapeMutationRevision = shapeStore.mutationRevision;
      const terms = [query1, query2];
      try {
        const params = new URLSearchParams({ query1, query2, layer: activeLayer });
        const response = await apiClient.get<MapObjectQueryResponse>(
          `${mapQueryObjectsUrl}?${params}`,
        );
        if (revision !== this.loadRevision) return false;
        this.search = { query1, query2, layerId: activeLayer };
        // Search returns a view, not a replacement for the canonical full-scope records.
        const records = new Map<string, MapObjectData>();
        for (const record of Object.values(response.data.markers)) {
          if ((this.mutationVersions.get(record.id) ?? 0) <= mutationRevision) {
            const accepted = this.recordCache.upsert(record);
            const canonical = this.recordCache.records.get(record.id);
            if (
              accepted ||
              (canonical &&
                (this.activeIsMaster || canonical.layer_id === this.activeLayerId) &&
                matchesMapSearch([canonical.marker_name, canonical.detail], terms))
            )
              records.set(record.id, canonical!);
          }
        }
        for (const [id, version] of this.mutationVersions)
          if (version > mutationRevision) {
            const record = this.recordCache.records.get(id);
            if (
              record &&
              (this.activeIsMaster || record.layer_id === this.activeLayerId) &&
              matchesMapSearch([record.marker_name, record.detail], terms)
            )
              records.set(id, record);
            else records.delete(id);
          }
        this.mapObjectList = ordered([...records.values()]);
        this.filteredShapeIds = [...response.data.shape_ids];
        for (const [id, version] of shapeStore.mutationVersions)
          if (version > shapeMutationRevision) shapeStore.dirtyIds.add(id);
        this.refreshSearchResults();
        this.tableChanges.emit({ type: "reset" });
        return true;
      } catch (error) {
        console.log(error);
        return false;
      }
    },
    async updateMapObject(
      id: string,
      name: string,
      detail: string,
      layer_id: string,
      bodyEdit?: { free_text: string; body_token: string },
    ): Promise<MapObjectData | null> {
      const generation = this.recordCache.generation;
      try {
        const response = await apiClient.put(`${updateMapObjectUrl}${id}`, {
          name,
          detail,
          layer_id,
          ...bodyEdit,
        });
        if (generation !== this.recordCache.generation) return null;
        const current = this.getById(id);
        const updated: MapObjectData | undefined =
          response.data?.object ??
          (current && {
            ...current,
            marker_name: name,
            detail,
            layer_id,
            update_at: new Date().toISOString(),
          });
        if (!updated) return null;
        this.upsertRecord(updated);
        return this.getById(id) ?? null;
      } catch (error) {
        console.log(error);
        return null;
      }
    },
    async deleteMapObject(id: string): Promise<boolean> {
      const generation = this.recordCache.generation;
      try {
        await apiClient.delete(`${deleteMapObjectUrl}${id}`);
        if (generation !== this.recordCache.generation) return false;
        this.removeRecord(id);
        return true;
      } catch (error) {
        console.log(error);
        return false;
      }
    },
  },
});
