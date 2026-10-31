// ブラウザー専用の検証環境で、実際の Vue テーブルと Pinia ストアをマウントする。
import { createApp, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import Table from "@bench-component";
import IndexOnly from "@bench-index";
import { useShapeStore } from "@/stores/shapes";
import { useMapObjectStore } from "@/stores/mapobjects";
import { useLayersStore } from "@/stores/layers";
import apiClient from "@/axiosClient";
import type { ShapeData } from "@/interface";
import * as L from "@bench-leaflet";
import "@bench-leaflet-css";
import { createShapeRenderManager } from "@bench-renderer";
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function painted() {
  await nextTick();
  await frame();
  await frame();
}

window.runTableBenchmark = async ({
  count,
  vertices,
  mode,
  mobile,
  initialOnly,
}: {
  count: number;
  vertices: number;
  mode: string;
  mobile: boolean;
  initialOnly: boolean;
}) => {
  const fixtureStart = performance.now();
  const records: ShapeData[] = Array.from({ length: count }, (_, i) => {
    const x = 139 + (i % 200) / 1000 - 0.1,
      y = 35 + Math.floor(i / 200) / 1000 - 0.1;
    return {
      id: String(i).padStart(6, "0"),
      user_id: "bench",
      layer_id: "a",
      name: `管路 ${i}`,
      shape_type: "polyline",
      created_at: "2026-01-01T00:00:00",
      updated_at: "2026-01-01T00:00:00",
      geojson: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: Array.from({ length: vertices }, (_, j) => [
            x + (j / (vertices - 1)) * 0.001,
            y + (j / (vertices - 1)) * 0.001,
          ]),
        },
      },
    };
  });
  const fixtureMs = performance.now() - fixtureStart;
  const pinia = createPinia();
  setActivePinia(pinia);
  const shapes = useShapeStore(),
    markers = useMapObjectStore();
  useLayersStore().layersList.set("a", {
    id: "a",
    name: "配管網",
    user_id: "bench",
    is_master: true,
    marker_icon_id: null,
    marker_icon_filename: null,
  });
  let requests = 0;
  apiClient.defaults.adapter = async (config) => {
    ++requests;
    return {
      data: config.url?.includes("shapes") ? records : {},
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  const dataStart = performance.now();
  await shapes.queryShapes("a", true);
  const dataMs = performance.now() - dataStart;
  const initial = performance.now();
  let manager: ReturnType<typeof createShapeRenderManager> | undefined;
  let map: L.Map | undefined;
  if (mode === "map-table") {
    map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
      [35 + (Math.ceil(count / 200) - 1) / 2000 - 0.1, 139],
      13,
    );
    manager = createShapeRenderManager({
      map,
      records,
      createLayer: (record: ShapeData) =>
        L.geoJSON(record.geojson as never, { style: { weight: 2 } }),
      addLayer: (layer: L.GeoJSON) => layer.addTo(map!),
      removeLayer: (layer: L.GeoJSON) => layer.remove(),
      isRecordVisible: () => true,
    });
    manager.scheduleRefresh();
  }
  const active = ref(true);
  const props = () => ({
    activeLayer: "a",
    ...(window.TABLE_STAGE === "after" ? { active: active.value } : {}),
    ...(mobile
      ? { mapObjectQueryFormData: { query1: "", query2: "" } }
      : {
          height: 76,
          ...(window.TABLE_STAGE === "before"
            ? {
                markerList: markers.mapObjectList,
                shapeList: shapes.shapeList,
                filteredShapeIds: markers.filteredShapeIds,
              }
            : {}),
        }),
  });
  if (mode !== "data")
    createApp({ setup: () => () => h(mode === "index" ? IndexOnly : Table, props()) })
      .use(pinia)
      .mount("#host");
  await painted();
  const tableFirstFrameMs = performance.now() - initial;
  await manager?.whenIdle();
  await painted();
  const allReadyMs = performance.now() - initial;
  if (manager && manager.getStats().renderedCount === 0)
    throw Error("Empty combined map benchmark");
  const rowCount = () => document.querySelectorAll("tbody tr:not(.virtual-spacer)").length;
  const initialRows = rowCount(),
    initialElements = document.querySelectorAll("*").length;
  const initialHeapBytes = await window.tableMemoryCheckpoint();
  let closedHeapBytes: number | undefined;
  const operations: Record<string, number> = {};
  async function operation(name: string, callback: () => void) {
    const start = performance.now();
    callback();
    await painted();
    operations[name] = performance.now() - start;
  }
  if (mode === "table" && !initialOnly) {
    await operation("scrollMs", () => {
      const area = document.querySelector<HTMLElement>(".table-area");
      if (area) {
        area.scrollTop = area.scrollHeight / 2;
        area.dispatchEvent(new Event("scroll"));
      }
    });
    await operation("updateMs", () => {
      shapes.upsertRecord({ ...records[0]!, name: "changed", updated_at: "2026-03-01T00:00:00" });
      markers.refreshSearchResults();
    });
    await operation("deleteMs", () => {
      shapes.removeRecord(records[1]!.id);
      markers.refreshSearchResults();
    });
    await operation("searchMs", () => {
      markers.search = { query1: `管路 ${count - 1}`, query2: "", layerId: "a" };
      markers.refreshSearchResults(true);
    });
    const searchRows = rowCount();
    if (searchRows !== 1) throw Error(`Search lost offscreen record: ${searchRows}`);
    await operation("resetSearchMs", () => {
      markers.clearSearch();
      markers.refreshSearchResults(true);
    });
    await operation("closeMs", () => {
      active.value = false;
      // 元の親コンポーネントは、マウントしたままのテーブルを v-show で非表示にしていた。
      if (window.TABLE_STAGE === "before") document.getElementById("host")!.style.display = "none";
    });
    closedHeapBytes = await window.tableMemoryCheckpoint();
    operations.closedRows = rowCount();
    await operation("reopenMs", () => {
      document.getElementById("host")!.style.display = "";
      active.value = true;
    });
  }
  return {
    fixtureMs,
    dataMs,
    tableFirstFrameMs,
    allReadyMs,
    initialRows,
    initialElements,
    initialHeapBytes,
    closedHeapBytes,
    operations,
    requests,
    map: manager?.getStats(),
    finalRows: rowCount(),
  };
};
