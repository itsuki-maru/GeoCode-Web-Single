<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import apiClient from "@/axiosClient";
import { createColoringEditor } from "../../../../template-scripts/src/map/common/coloring-editor";
import type { AnswerColorSpecification, AnswerField } from "@/utils/answer-coloring";
const props = defineProps<{
  forms: { id: string; label: string }[];
  endpoint: string;
  query: Record<string, unknown>;
  targets: string[];
  requiredForm: string;
  disabled: boolean;
  active: boolean;
}>();
const emit = defineEmits<{
  apply: [value: AnswerColorSpecification | null];
  save: [value: AnswerColorSpecification];
}>();
const host = ref<HTMLElement | null>(null);
let editor: ReturnType<typeof createColoringEditor> | undefined;
onMounted(() => {
  editor = createColoringEditor(host.value!, {
    lazy: true,
    forms: () => props.forms,
    requiredForm: () => props.requiredForm,
    disabled: () => props.disabled,
    active: () => props.active,
    loadFields: async (id, signal) => {
      try {
        return (
          await apiClient.post<{ fields: AnswerField[] }>(
            props.endpoint,
            {
              query: props.query,
              targets: props.targets,
              common_form_id: id,
              conditions: [],
              options_only: true,
            },
            { signal, timeout: 60000 },
          )
        ).data.fields;
      } catch {
        throw Error("色分けの入力項目を取得できませんでした。フォームを選び直してください。");
      }
    },
    apply: (value) => emit("apply", value),
    save: (value) => emit("save", value),
  });
});
watch(
  () => [props.forms, props.requiredForm, props.disabled, props.active],
  () => editor?.refresh(),
  { deep: true },
);
onBeforeUnmount(() => editor?.dispose());
defineExpose({
  restoreDraft: (value: AnswerColorSpecification, fields: AnswerField[]) =>
    editor?.restore(value, fields),
});
</script>
<template><details ref="host" class="color-panel" open></details></template>
