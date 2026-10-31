import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import Answers from "@bench-component";
import apiClient from "@/axiosClient";
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const painted = async () => {
  await nextTick();
  await frame();
  await frame();
};
window.runAnswerBenchmark = async ({
  fieldCount,
  length,
  probe,
}: {
  fieldCount: number;
  length: number;
  probe?: boolean;
}) => {
  const fields = Array.from({ length: fieldCount }, (_, i) => ({
    id: `field-${i}`,
    label: `点検項目 ${i}`,
    field_type: "textarea",
    choices: [],
  }));
  const options = { forms: [], layers: [], versions: [], fields };
  const text = "配管の点検記録。".repeat(Math.ceil(length / 8)).slice(0, length);
  const makeRows = (offset = 0) =>
    Array.from({ length: 50 }, (_, i) => {
      const local = fields.slice(
        fieldCount > 20 ? (i % Math.ceil(fieldCount / 20)) * 20 : 0,
        fieldCount > 20 ? ((i % Math.ceil(fieldCount / 20)) + 1) * 20 : fieldCount,
      );
      return {
        id: String(offset + i),
        target_type: i % 2 ? "shape" : "marker",
        target_id: `target-${i % 5}`,
        target_name: `対象 ${offset + i}`,
        layer_id: "a",
        layer_name: "配管網",
        create_at: "2026-10-01T00:00:00",
        edited_at: null,
        source_form: null,
        common_form_name: "点検フォーム",
        common_form_deleted: false,
        form_snapshot: {
          form_title: "点検フォーム",
          form_description: "投稿時のフォーム",
          form_schema: {
            fields: local.map((field) => ({
              id: field.id,
              label: field.label,
              type: field.field_type,
            })),
          },
        },
        submitted_values: Object.fromEntries(local.map((field) => [field.id, text])),
      };
    });
  const requests = { options: 0, search: 0 };
  apiClient.defaults.adapter = async (config) => {
    let data;
    if (config.url?.endsWith("options")) {
      ++requests.options;
      data = structuredClone(options);
    } else {
      ++requests.search;
      const query = JSON.parse(config.data || "{}");
      data = {
        rows: makeRows(query.cursor ? 50 : 0),
        total: 20000,
        target_count: 2000,
        editing_supported: true,
        as_of: "2026-10-02T00:00:00Z",
        next_cursor: { id: "49", at: "2026-10-01T00:00:00", target_type: "marker" },
      };
    }
    return { data, status: 200, statusText: "OK", config, headers: {} };
  };
  const opened = ref(false),
    answers = ref();
  createApp({
    setup: () => () =>
      window.ANSWER_STAGE === "before" || opened.value
        ? h(Answers, {
            ref: answers,
            isOpen: opened.value,
            onClose: () => {
              opened.value = false;
            },
          })
        : null,
  })
    .use(createPinia())
    .mount("#host");
  await painted();
  const loaded = async () => {
    const deadline = performance.now() + 30000;
    while (
      document.querySelectorAll(".answers-modal tbody tr").length !== 50 ||
      document.querySelectorAll(".column-options input").length !== fieldCount
    ) {
      if (performance.now() > deadline) throw Error("Answer page did not load");
      await frame();
    }
    await painted();
  };
  window.openBenchmarkAnswers = async () => {
    opened.value = true;
    await loaded();
  };
  const start = performance.now();
  opened.value = true;
  await loaded();
  const initialMs = performance.now() - start;
  const countCells = () => document.querySelectorAll(".answers-modal tbody .answer-value").length;
  const initialCells = countCells();
  const initialHeapBytes = await window.answerMemoryCheckpoint();
  const all = performance.now();
  answers.value.setBenchmarkColumns(fields.map((field) => `${field.id}|${field.field_type}`));
  await painted();
  const selectAllMs = performance.now() - all;
  const selectedCells = countCells();
  const selectedTextLength = [
    ...document.querySelectorAll(".answers-modal tbody .answer-value"),
  ].reduce((sum, cell) => sum + cell.textContent.trim().length, 0);
  const operation = async (callback: () => void) => {
    const at = performance.now();
    callback();
    await painted();
    return performance.now() - at;
  };
  let checkbox = document.querySelector<HTMLInputElement>(".column-options input");
  const columnToggleMs = await operation(() => checkbox!.click());
  await operation(() => checkbox!.click());
  // GC の計測中に、切り離した入力要素や、その元の DOM ツリーを保持しない。
  checkbox = null;
  const requestsBeforeLocal = { ...requests };
  const helpToggleMs = await operation(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="一覧とCSVについて"]')!.click(),
  );
  const detailMs = await operation(() =>
    [...document.querySelectorAll<HTMLButtonElement>("tbody button")]
      .find((button) => button.textContent.trim() === "詳細を見る")!
      .click(),
  );
  if (document.querySelector(".answer-detail dl dd")?.textContent.trim() !== text)
    throw Error("Full answer detail lost");
  const localNoRequests =
    requests.search === requestsBeforeLocal.search &&
    requests.options === requestsBeforeLocal.options;
  document.querySelector<HTMLButtonElement>(".answer-detail .close-button")!.click();
  await painted();
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".answers-modal button")].find(
      (button) => button.textContent.trim() === label,
    )!;
  const pageStart = performance.now();
  button("次へ").click();
  await loaded();
  const pageMs = performance.now() - pageStart;
  const closedRowRefs: WeakRef<object>[] = probe ? answers.value.benchmarkRowRefs() : [];
  const closeMs = await operation(() => {
    opened.value = false;
  });
  const closedRows = document.querySelectorAll(".answers-modal tbody tr").length;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
  await painted();
  const closedHeapBytes = await window.answerMemoryCheckpoint();
  if (probe) {
    window.closedAnswerRefs = closedRowRefs;
    return {
      fieldCount,
      length,
      initialMs,
      closedRows,
      closedHeapBytes,
      localNoRequests,
      requests,
    };
  }
  const reopenStart = performance.now();
  opened.value = true;
  await loaded();
  const reopenMs = performance.now() - reopenStart;
  const reopenedCells = countCells();
  const cycles = [];
  for (let i = 0; i < 3; ++i) {
    opened.value = false;
    await painted();
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
    await painted();
    cycles.push({
      rows: document.querySelectorAll(".answers-modal tbody tr").length,
      heapBytes: await window.answerMemoryCheckpoint(),
    });
    if (i < 2) {
      opened.value = true;
      await loaded();
    }
  }
  return {
    fieldCount,
    length,
    pageSize: 50,
    total: 20000,
    initialMs,
    initialCells,
    initialHeapBytes,
    selectAllMs,
    selectedCells,
    selectedTextLength,
    columnToggleMs,
    helpToggleMs,
    detailMs,
    localNoRequests,
    pageMs,
    closeMs,
    closedRows,
    closedHeapBytes,
    reopenMs,
    reopenedCells,
    cycles,
    requests,
  };
};
