import { computed, onScopeDispose, shallowRef, toRaw, watch, type Ref } from "vue";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useShapeStore } from "@/stores/shapes";
import { matchesMapSearch } from "@/stores/map-record-cache";
import type { ShapeData } from "@/interface";
import type { TableChange } from "@/stores/map-table-changes";
import { MapObjectTableIndex } from "./map-object-table-index";

export function useMapObjectTableRows(active: Ref<boolean>) {
  const markers = useMapObjectStore(),
    shapes = useShapeStore();
  const index = new MapObjectTableIndex();
  const revision = shallowRef(0),
    pendingRevision = shallowRef(0);
  const pending = new Map<string, Extract<TableChange, { type: "record" }>>();
  let reset = true;
  const markerMap = () => toRaw(markers.mapObjectList);
  const shapeMap = () => toRaw(shapes.shapeList);
  function changed(change: TableChange) {
    if (!active.value) return;
    if (change.type === "reset") reset = true;
    else if (!reset) {
      pending.set(`${change.kind}:${change.id}`, change);
      // Imports/bulk edits build once, rather than repeatedly shifting the ID array.
      if (pending.size > 256) {
        reset = true;
        pending.clear();
      }
    }
    ++pendingRevision.value;
  }
  const stopMarkers = markers.tableChanges.subscribe(changed);
  const stopShapes = shapes.tableChanges.subscribe(changed);
  function flush() {
    if (!active.value) return;
    if (reset) {
      const ids =
        markers.filteredShapeIds === null ? null : new Set(toRaw(markers.filteredShapeIds));
      const visibleShapes = function* () {
        for (const record of shapeMap().values()) if (!ids || ids.has(record.id)) yield record;
      };
      index.reset(markerMap().values(), visibleShapes());
    } else {
      for (const { kind, id } of pending.values()) {
        const record = kind === "marker" ? markerMap().get(id) : shapeMap().get(id);
        // A single write uses the same predicate as the store's incremental search.
        const query = markers.search;
        const included =
          kind === "marker" ||
          !query ||
          !record ||
          matchesMapSearch(
            [
              (record as ShapeData).name,
              String((record as ShapeData).geojson.properties.memo ?? ""),
            ],
            [query.query1, query.query2],
          );
        if (record && included) index.upsert(kind, record);
        else index.remove(kind, id);
      }
    }
    reset = false;
    pending.clear();
    ++revision.value;
  }
  watch(pendingRevision, flush);
  watch(
    active,
    (enabled) => {
      reset = true;
      pending.clear();
      if (enabled) flush();
      else {
        index.clear();
        ++revision.value;
      }
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    stopMarkers();
    stopShapes();
    index.clear();
    pending.clear();
  });
  const count = computed(() => {
    void revision.value;
    return index.keys.length;
  });
  function rows(start: number, end: number) {
    void revision.value;
    return active.value
      ? index.slice(
          start,
          end,
          (id) => markerMap().get(id),
          (id) => shapeMap().get(id),
        )
      : [];
  }
  return { count, rows };
}
