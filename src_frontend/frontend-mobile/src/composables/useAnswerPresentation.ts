import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import {
  AnswerTablePresentation,
  describeAnswerDetail,
  describeAnswerFields,
  type AnswerField,
  type AnswerTableRow,
  type FormAnswer,
} from "@/utils/answer-presentation";

export function useAnswerPresentation(
  answers: Ref<FormAnswer[]>,
  fields: Ref<AnswerField[]>,
  selected: Ref<string[]>,
  detail: Ref<FormAnswer | null>,
  active: Ref<boolean>,
) {
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 700px)") : null;
  const narrow = ref(media?.matches ?? window.innerWidth <= 700);
  const resized = (event: MediaQueryListEvent) => {
    narrow.value = event.matches;
  };
  media?.addEventListener("change", resized);
  const allColumns = computed(() => (active.value ? describeAnswerFields(fields.value) : []));
  const columns = computed(() => {
    if (!active.value) return [];
    const keys = new Set(selected.value);
    const chosen = allColumns.value.filter((field) => keys.has(field.key));
    return narrow.value ? chosen.slice(0, 3) : chosen;
  });
  const presentation = new AnswerTablePresentation();
  const tableRows = shallowRef<AnswerTableRow[]>([]);
  watch(
    [answers, columns, active],
    () => {
      if (!active.value) {
        presentation.clear();
        tableRows.value = [];
        return;
      }
      presentation.setPage(answers.value);
      tableRows.value = presentation.rows(columns.value);
    },
    { immediate: true },
  );
  watch(
    active,
    (enabled) => {
      if (!enabled) {
        presentation.clear();
        tableRows.value = [];
      }
    },
    { flush: "sync" },
  );
  const detailView = shallowRef<ReturnType<typeof describeAnswerDetail> | null>(null);
  watch(
    [detail, active],
    () => {
      detailView.value = active.value && detail.value ? describeAnswerDetail(detail.value) : null;
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    media?.removeEventListener("change", resized);
    presentation.clear();
    tableRows.value = [];
    detailView.value = null;
  });
  return { allColumns, columns, tableRows, detailView };
}
