<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { renderMapPresetsTable } from "../../../../template-scripts/src/map/common/map-presets-table";
import type { SavedMapPreset } from "@/utils/answer-map-presets";
const props = defineProps<{ items: SavedMapPreset[]; disabled: boolean }>();
const emit = defineEmits<{ restore: [value: SavedMapPreset]; remove: [value: SavedMapPreset] }>();
const host = ref<HTMLElement | null>(null);
const render = () => {
  if (host.value)
    renderMapPresetsTable(host.value, {
      items: props.items,
      disabled: props.disabled,
      restore: (value) => emit("restore", value),
      remove: (value) => emit("remove", value),
    });
};
onMounted(render);
watch(() => [props.items, props.disabled], render, { deep: true });
</script>
<template><div ref="host" class="table-scroll map-presets-table"></div></template>
