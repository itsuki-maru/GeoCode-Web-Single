<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import apiClient from "@/axiosClient";
import {
  answerFieldKey,
  answerConditionHasNoValue,
  answerConditionOperations,
  serializeAnswerConditions,
  type AnswerField,
  type AnswerConditionRow,
  type AnswerColorSpecification,
} from "@/utils/answer-coloring";
import { deserializePresetConditions, validatePresetDraft } from "@/utils/answer-map-presets";

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
interface DraftRule {
  id: string;
  label: string;
  color: string;
  rows: AnswerConditionRow[];
}
const selectedForm = ref(""),
  fields = ref<AnswerField[]>([]),
  rules = ref<DraftRule[]>([]);
const panel = ref<HTMLDetailsElement | null>(null);
const loading = ref(false),
  error = ref("");
const availableForms = computed(() =>
  props.forms.filter((form) => !props.requiredForm || form.id === props.requiredForm),
);
const palette = [
  "#d73027",
  "#2166ac",
  "#1a9850",
  "#984ea3",
  "#e08214",
  "#008b8b",
  "#a65628",
  "#e7298a",
  "#666666",
  "#7570b3",
];
let sequence = 0,
  nextId = 0;
let controller: AbortController | undefined;
const fieldFor = (row: AnswerConditionRow) =>
  fields.value.find((field) => answerFieldKey(field) === row.key);
const resetRow = (row: AnswerConditionRow) => {
  const kind = fieldFor(row)?.field_type;
  row.op =
    kind === "number" || kind === "date"
      ? "gte"
      : kind === "select" || kind === "radio"
        ? "in"
        : kind === "checkbox"
          ? "eq"
          : "contains";
  row.value = kind === "checkbox" ? "true" : "";
  row.upper = "";
  row.selected = [];
};
const addCondition = (rule: DraftRule) => {
  if (!fields.value.length || rule.rows.length >= 10) return;
  const row: AnswerConditionRow = {
    id: ++nextId,
    key: answerFieldKey(fields.value[0]!),
    op: "",
    value: "",
    upper: "",
    selected: [],
  };
  resetRow(row);
  rule.rows.push(row);
};
const addRule = () => {
  if (!fields.value.length || rules.value.length >= 10) return;
  const rule: DraftRule = {
    id: `color-${++nextId}`,
    label: `分類${rules.value.length + 1}`,
    color: palette[rules.value.length]!,
    rows: [],
  };
  addCondition(rule);
  rules.value.push(rule);
};
const moveRule = (index: number, direction: number) => {
  const destination = index + direction;
  if (destination < 0 || destination >= rules.value.length) return;
  const [rule] = rules.value.splice(index, 1);
  rules.value.splice(destination, 0, rule!);
};
const loadFields = async () => {
  controller?.abort();
  const seq = ++sequence;
  error.value = "";
  fields.value = [];
  rules.value = [];
  if (!selectedForm.value) {
    loading.value = false;
    return;
  }
  controller = new AbortController();
  loading.value = true;
  try {
    const data = (
      await apiClient.post<{ fields: AnswerField[] }>(
        props.endpoint,
        {
          query: props.query,
          targets: props.targets,
          common_form_id: selectedForm.value,
          conditions: [],
          options_only: true,
        },
        { signal: controller.signal, timeout: 60000 },
      )
    ).data;
    if (seq !== sequence) return;
    if (!Array.isArray(data.fields)) throw Error("Invalid fields");
    fields.value = data.fields;
  } catch {
    if (seq === sequence)
      error.value = "色分けの入力項目を取得できませんでした。フォームを選び直してください。";
  } finally {
    if (seq === sequence) loading.value = false;
  }
};
const buildSpecification = (): AnswerColorSpecification => {
  if (!selectedForm.value || !rules.value.length)
    throw Error("共通フォームと分類を設定してください。");
  const value: AnswerColorSpecification = {
    common_form_id: selectedForm.value,
    rules: rules.value.map((rule) => {
      if (!rule.label.trim()) throw Error("分類名を入力してください。");
      if (!rule.rows.length) throw Error("各分類に条件を追加してください。");
      return {
        id: rule.id,
        label: rule.label.trim(),
        color: rule.color,
        conditions: serializeAnswerConditions(rule.rows, fields.value),
      };
    }),
  };
  validatePresetDraft({ kind: "coloring", definition: value });
  return value;
};
const apply = () => {
  error.value = "";
  try {
    emit("apply", buildSpecification());
  } catch (cause) {
    error.value = (cause as Error).message;
  }
};
const save = () => {
  error.value = "";
  try {
    emit("save", buildSpecification());
  } catch (cause) {
    error.value = (cause as Error).message;
  }
};
// 下書きを置き換える前に全行を解決し、プリセットが無効でも編集中の内容を保持する。
const restoreDraft = (specification: AnswerColorSpecification, candidates: AnswerField[]) => {
  validatePresetDraft({ kind: "coloring", definition: specification });
  if (props.requiredForm && props.requiredForm !== specification.common_form_id)
    throw Error("現在の一覧・絞り込みと共通フォームが異なるため呼び出せません。");
  const restored = specification.rules.map((rule) => ({
    id: `color-${++nextId}`,
    label: rule.label,
    color: rule.color,
    rows: deserializePresetConditions(rule.conditions, candidates, () => ++nextId),
  }));
  controller?.abort();
  sequence++;
  loading.value = false;
  selectedForm.value = specification.common_form_id;
  fields.value = candidates;
  rules.value = restored;
  error.value = "";
  if (panel.value) panel.value.open = true;
};
defineExpose({ restoreDraft });
watch(
  () => props.requiredForm,
  (form) => {
    if (form && form !== selectedForm.value) {
      controller?.abort();
      sequence++;
      loading.value = false;
      selectedForm.value = form;
      error.value = "";
      fields.value = [];
      rules.value = [];
      if (panel.value?.open && !props.disabled) void loadFields();
    }
  },
  { immediate: true },
);
watch(
  () => props.disabled,
  (disabled) => {
    if (
      !disabled &&
      panel.value?.open &&
      selectedForm.value &&
      !fields.value.length &&
      !loading.value &&
      !error.value
    )
      void loadFields();
  },
);
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
});
const openPanel = (event: Event) => {
  if (
    (event.target as HTMLDetailsElement).open &&
    selectedForm.value &&
    !fields.value.length &&
    !loading.value &&
    !error.value &&
    !props.disabled
  )
    void loadFields();
};
</script>

<template>
  <details ref="panel" class="color-panel" open @toggle="openPanel">
    <summary>地図で色分け</summary>
    <fieldset :disabled="disabled || loading">
      <label class="color-form"
        >共通フォーム
        <select v-model="selectedForm" aria-label="色分けの共通フォーム" @change="loadFields">
          <option value="">選択してください</option>
          <option v-for="form in availableForms" :key="form.id" :value="form.id">
            {{ form.label }}
          </option>
        </select>
      </label>
      <div class="color-actions">
        <button type="button" :disabled="!fields.length || rules.length >= 10" @click="addRule">
          分類を追加
        </button>
        <button type="button" :disabled="!active" @click="emit('apply', null)">色分け解除</button>
      </div>
      <section v-for="(rule, index) in rules" :key="rule.id" class="color-rule">
        <label>分類名<input v-model="rule.label" aria-label="分類名" maxlength="100" /></label>
        <label class="color-picker"
          >色<input v-model="rule.color" type="color" aria-label="分類の色"
        /></label>
        <div class="color-actions">
          <button
            type="button"
            :disabled="index === 0"
            aria-label="分類を上へ"
            @click="moveRule(index, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="index === rules.length - 1"
            aria-label="分類を下へ"
            @click="moveRule(index, 1)"
          >
            ↓
          </button>
          <button type="button" @click="rules.splice(index, 1)">分類を削除</button>
        </div>
        <div v-for="(row, rowIndex) in rule.rows" :key="row.id" class="color-condition">
          <select v-model="row.key" aria-label="色分けの入力項目" @change="resetRow(row)">
            <option
              v-for="field in fields"
              :key="answerFieldKey(field)"
              :value="answerFieldKey(field)"
            >
              {{ field.label }}
            </option>
          </select>
          <select v-model="row.op" aria-label="色分けの比較方法">
            <option
              v-for="operation in answerConditionOperations(fieldFor(row)?.field_type)"
              :key="operation.value"
              :value="operation.value"
            >
              {{ operation.label }}
            </option>
          </select>
          <template v-if="!answerConditionHasNoValue(row)">
            <select
              v-if="['select', 'radio'].includes(fieldFor(row)?.field_type || '')"
              v-model="row.selected"
              multiple
              aria-label="色分けの選択値"
            >
              <option v-for="choice in fieldFor(row)?.choices" :key="choice" :value="choice">
                {{ choice }}
              </option>
            </select>
            <select
              v-else-if="fieldFor(row)?.field_type === 'checkbox'"
              v-model="row.value"
              aria-label="色分けの回答値"
            >
              <option value="true">はい</option>
              <option value="false">いいえ</option>
            </select>
            <input
              v-else
              v-model="row.value"
              :type="fieldFor(row)?.field_type === 'date' ? 'date' : 'text'"
              :inputmode="fieldFor(row)?.field_type === 'number' ? 'decimal' : undefined"
              aria-label="色分けの条件値"
            />
            <template v-if="row.op === 'between'"
              ><span>〜</span
              ><input
                v-model="row.upper"
                :type="fieldFor(row)?.field_type === 'date' ? 'date' : 'text'"
                :inputmode="fieldFor(row)?.field_type === 'number' ? 'decimal' : undefined"
                aria-label="色分けの範囲終了値"
            /></template>
          </template>
          <div class="color-condition-actions">
            <button
              type="button"
              @click="rule.rows = rule.rows.filter((item) => item.id !== row.id)"
            >
              分類条件を削除
            </button>
            <button
              v-if="rowIndex === rule.rows.length - 1"
              type="button"
              :disabled="rule.rows.length >= 10"
              @click="addCondition(rule)"
            >
              分類条件を追加
            </button>
          </div>
        </div>
        <button v-if="!rule.rows.length" type="button" @click="addCondition(rule)">
          分類条件を追加
        </button>
      </section>
      <button class="color-submit" type="button" :disabled="!rules.length" @click="apply">
        色分け実行
      </button>
      <button class="color-save" type="button" :disabled="!rules.length" @click="save">
        検索条件を保存
      </button>
    </fieldset>
    <p class="color-help">
      分類は最大10件、各分類は最大10件のAND条件です。一覧・絞り込み・各分類の条件は合計20件までです。重複時は上の分類を優先し、未分類は元の色を維持します。
    </p>
    <p class="color-help">
      {{
        loading
          ? "入力項目を取得中…"
          : active
            ? "色分けを反映済みです。編集後は「色分け実行」で反映します。"
            : "色分けは未適用です。"
      }}
    </p>
    <p v-if="error" class="color-error" role="alert">{{ error }}</p>
  </details>
</template>

<style scoped>
.color-panel {
  background: whitesmoke;
  padding: 8px 12px;
  font-size: 14px;
}
summary {
  cursor: pointer;
  font-weight: bold;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 8px 0 0;
  min-width: 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
select,
input {
  font: inherit;
  min-height: 34px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
select[multiple] {
  min-height: 64px;
}
.color-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
.color-rule {
  border-top: 1px solid #ccc;
  padding-top: 8px;
  margin-top: 8px;
  display: grid;
  gap: 8px;
}
.color-picker {
  flex-direction: row;
  align-items: center;
}
.color-picker input {
  width: 60px;
  padding: 0;
}
.color-condition {
  display: grid;
  gap: 8px;
  border-top: 1px dashed #ccc;
  padding-top: 8px;
}
.color-condition-actions {
  display: flex;
  gap: 8px;
}
.color-condition-actions button {
  flex: 1;
  min-width: 0;
}
button {
  background: #5f5f5f;
  color: white;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px;
  min-height: 40px;
  cursor: pointer;
  font: inherit;
  overflow-wrap: anywhere;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.color-submit {
  background: #2165bb;
  width: 100%;
  margin-top: 12px;
}
.color-save {
  width: 100%;
  margin-top: 8px;
}
.color-help,
.color-error {
  font-size: 12px;
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.color-error {
  color: #7c3f00;
}
</style>
