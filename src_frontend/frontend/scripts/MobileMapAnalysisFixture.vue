<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import MapToolbar from "../../frontend-mobile/src/components/map/MapToolbar.vue";
import MapIframe from "../../frontend-mobile/src/components/map/MapIframe.vue";
import { useMapAnalysisSearch } from "../../frontend-mobile/src/composables/useMapAnalysisSearch";
import { useAiAssistant } from "../../frontend-mobile/src/composables/useAiAssistant";
import { useMapObjectStore } from "../../frontend-mobile/src/stores/mapobjects";
import { useShapeStore } from "../../frontend-mobile/src/stores/shapes";

const layer = ref("fixture-layer"),
  master = ref("master"),
  frame = ref<InstanceType<typeof MapIframe>>();
const markers = useMapObjectStore(),
  shapes = useShapeStore();
markers.activateScope(layer.value, false);
shapes.activateScope(layer.value, false);
const marker = {
  id: "one",
  layer_id: layer.value,
  marker_name: "設備A（60年）",
  latitude: 35,
  longitude: 139,
  detail: "",
  update_at: "2026-11-05T00:00:00Z",
};
const shape = {
  id: "two",
  layer_id: layer.value,
  user_id: "fixture",
  name: "設備B（30年）",
  shape_type: "polyline" as const,
  created_at: "",
  updated_at: "2026-11-05T00:00:00Z",
  geojson: {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [139.001, 35.001],
        [139.003, 35.001],
      ],
    },
  },
};
markers.upsertRecord(marker);
shapes.upsertRecord(shape);
const error = ref("");
const origin = window.location.origin;
const applyFilter = async () => {
  const active = !!markers.attributeSearch || !!markers.aiFilterTargets;
  return (
    (await frame.value?.filterMapObjectsAndWait(
      active ? [...markers.mapObjectList.keys()] : null,
      active ? markers.filteredShapeIds : null,
    )) ?? false
  );
};
const assistant = useAiAssistant(
  layer,
  master,
  {
    filter: applyFilter,
    color: async (value) => (await frame.value?.setColoring(value)) ?? false,
    resetColor: async () => (await frame.value?.discardColoring()) ?? false,
    focus: async () => false,
    view: async () => null,
    identity: () => layer.value,
    evaluatePreset: (definition) => analysis.evaluatePreset(definition),
    preparePresetPage: (presets, signal) => analysis.preparePresetPage(presets, signal),
    prepareManualReplacement: (kind, signal, localPreset) =>
      analysis.prepareManualReplacement(kind, signal, localPreset),
  },
  (preset) => analysis.recallSavedPreset(preset),
);
const analysis = useMapAnalysisSearch(
  layer,
  master,
  async () => {
    if (!(await applyFilter())) throw Error("絞り込みを反映できませんでした。");
  },
  (message) => {
    error.value = message;
  },
  assistant.applyManualColoring,
  () => assistant.applyManualColoring(null),
  assistant.applyDefinition,
  assistant.clearDefinition,
  assistant.replaceAppliedCondition,
  assistant.getRecalledColoring,
);
const { openAdvancedSearch } = analysis;
const coloringActive = computed(
  () => analysis.coloringActive.value || !!assistant.getRecalledColoring(),
);
const filterActive = computed(() => !!markers.attributeSearch || !!markers.aiFilterTargets);
const active = computed(() => filterActive.value || coloringActive.value);
const initialize = () =>
  frame.value?.initializeMapObjects({
    markers: { one: marker },
    shapes: [shape],
    scopeKey: layer.value,
  });
onMounted(() => void initialize());
</script>

<template>
  <MapIframe
    ref="frame"
    :srcUrl="'/scripts/mobile-map-analysis-preview.html?data_source=parent'"
    :allowedOrigins="origin"
    @mapDataRequested="initialize"
  />
  <MapToolbar
    :activeLayer="layer"
    :masterLayerId="master"
    :layerList="new Map([[layer, { id: layer, name: '設備点検レイヤー' }]])"
    :isMasterLayer="false"
    :isHttpsProtocol="true"
    :attributeSearchActive="active"
    @advancedSearch="openAdvancedSearch"
  />
  <output class="fixture-state" aria-label="地図への適用状況"
    >絞り込み：{{ filterActive ? "適用中" : "なし" }} ／ 色分け：{{
      coloringActive ? "適用中" : "なし"
    }}</output
  >
  <p v-if="error" role="alert">{{ error }}</p>
</template>

<style scoped>
.fixture-state {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 8px;
  background: white;
  color: #222;
  font-size: 14px;
}
</style>
