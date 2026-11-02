<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { mapAnatherLayerUrl } from "@/router/urls";
import { submitAuthenticatedForm } from "@/utils/authenticated-form";
import {
  openMapPrintPreview,
  requestMapPrintState,
} from "../../../../template-scripts/src/map/common/map-print-host";
const props = defineProps<{
  layerIds: string[] | null;
  answerPrint?: { action: string; snapshot: Record<string, unknown> };
}>();
const emit = defineEmits<{ close: [] }>();
const container = ref<HTMLElement | null>(null);
let host: ReturnType<typeof openMapPrintPreview> | undefined;
onMounted(() => {
  host = openMapPrintPreview({
    container: container.value!,
    url: props.answerPrint?.action || `${mapAnatherLayerUrl}?print=1`,
    close: () => emit("close"),
    getState: async (signal) => {
      if (props.answerPrint) return props.answerPrint.snapshot;
      const source = document.getElementById("map-iframe") as HTMLIFrameElement | null;
      if (!source) throw Error("現在の地図を取得できません。");
      return {
        ...(await requestMapPrintState(source, signal)),
        layerIds: props.layerIds === null ? null : [...props.layerIds],
      };
    },
    answer: props.answerPrint
      ? {
          initialize(frame, requestId, fail) {
            const form = container.value!.querySelector("form") || document.createElement("form");
            form.replaceChildren();
            form.action = props.answerPrint!.action;
            form.target = frame.name;
            form.method = "post";
            form.hidden = true;
            for (const [name, value] of [
              ["parent_origin", location.origin],
              ["request_id", requestId],
            ]) {
              const input = document.createElement("input");
              input.type = "hidden";
              input.name = name!;
              input.value = value!;
              form.append(input);
            }
            container.value!.append(form);
            const stop = submitAuthenticatedForm(form, frame, fail);
            return stop;
          },
        }
      : undefined,
  });
});
onBeforeUnmount(() => host?.dispose());
</script>
<template><div ref="container"></div></template>
