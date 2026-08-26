<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import apiClient from "@/axiosClient";

type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "radio"
  | "checkbox"
  | "image";

interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  max_length: number | null;
  choices: string[];
  choicesText?: string;
}

interface FormConfig {
  marker_id?: string;
  shape_id?: string;
  enabled: boolean;
  form_title: string;
  form_description: string;
  form_schema: { fields: FormField[] };
  is_password_protected: boolean;
  public_path: string | null;
}

const props = defineProps<{
  isOpen: boolean;
  targetType: "marker" | "shape";
  targetId: string;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
}>();

const enabled = ref(false);
const formTitle = ref("");
const formDescription = ref("");
const fields = ref<FormField[]>([]);
const publicPath = ref<string | null>(null);
const isPasswordProtected = ref(false);
const passwordMode = ref<"keep" | "set" | "clear">("keep");
const password = ref("");
const loading = ref(false);
const saving = ref(false);
let fieldSequence = 0;

const publicUrl = computed(() =>
  publicPath.value ? `${window.location.origin}${publicPath.value}` : "",
);
const formBaseUrl = computed(() => `/${props.targetType}/${props.targetId}/form`);

const fieldTypeLabels: Record<FieldType, string> = {
  text: "1行テキスト",
  textarea: "複数行テキスト",
  number: "数値",
  date: "日付",
  select: "セレクト",
  radio: "ラジオボタン",
  checkbox: "チェックボックス",
  image: "画像",
};

const errorMessage = (error: unknown, fallback: string): string => {
  if (apiClient.isAxiosError(error)) {
    const data = error.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error.replace(/^validation error:\s*/, "");
  }
  return fallback;
};

const applyConfig = (config: FormConfig): void => {
  enabled.value = config.enabled;
  formTitle.value = config.form_title;
  formDescription.value = config.form_description;
  fields.value = config.form_schema.fields.map((field) => ({
    ...field,
    choices: field.choices || [],
    choicesText: (field.choices || []).join("\n"),
  }));
  publicPath.value = config.public_path;
  isPasswordProtected.value = config.is_password_protected;
  passwordMode.value = "keep";
  password.value = "";
};

const loadConfig = async (): Promise<void> => {
  if (!props.targetId) return;
  loading.value = true;
  try {
    const response = await apiClient.get<FormConfig>(formBaseUrl.value);
    applyConfig(response.data);
  } catch (error) {
    emit("message", errorMessage(error, "フォーム設定を読み込めませんでした。"));
    emit("close");
  } finally {
    loading.value = false;
  }
};

watch(
  () => props.isOpen,
  (open) => {
    if (open) void loadConfig();
  },
);

const addField = (): void => {
  fieldSequence += 1;
  fields.value.push({
    id: `field_${Date.now().toString(36)}_${fieldSequence}`,
    label: "新しい項目",
    type: "text",
    required: false,
    max_length: 200,
    choices: [],
    choicesText: "",
  });
};

const removeField = (index: number): void => {
  fields.value.splice(index, 1);
};

const moveField = (index: number, direction: -1 | 1): void => {
  const next = index + direction;
  if (next < 0 || next >= fields.value.length) return;
  const [field] = fields.value.splice(index, 1);
  if (!field) return;
  fields.value.splice(next, 0, field);
};

const normalizeFields = (): FormField[] =>
  fields.value.map((field) => ({
    id: field.id,
    label: field.label.trim(),
    type: field.type,
    required: field.required,
    max_length:
      field.type === "text" || field.type === "textarea" ? Number(field.max_length) || null : null,
    choices:
      field.type === "select" || field.type === "radio"
        ? (field.choicesText || "")
            .split("\n")
            .map((choice) => choice.trim())
            .filter(Boolean)
        : [],
  }));

const validateBeforeSave = (): string | null => {
  if (!formTitle.value.trim()) return "フォーム名を入力してください。";
  if (enabled.value && fields.value.length === 0) return "公開するフォームには入力項目が必要です。";
  if (fields.value.some((field) => !field.label.trim()))
    return "すべての項目名を入力してください。";
  if (
    fields.value.some(
      (field) =>
        (field.type === "select" || field.type === "radio") &&
        !(field.choicesText || "").split("\n").some((choice) => choice.trim()),
    )
  ) {
    return "セレクトとラジオボタンには選択肢が必要です。";
  }
  if (passwordMode.value === "set" && (password.value.length < 4 || password.value.length > 64)) {
    return "パスワードは4〜64文字で入力してください。";
  }
  return null;
};

const save = async (): Promise<void> => {
  const validation = validateBeforeSave();
  if (validation) {
    emit("message", validation);
    return;
  }
  saving.value = true;
  try {
    const response = await apiClient.put<FormConfig>(formBaseUrl.value, {
      enabled: enabled.value,
      form_title: formTitle.value,
      form_description: formDescription.value,
      form_schema: { fields: normalizeFields() },
      password_mode: passwordMode.value,
      password: passwordMode.value === "set" ? password.value : null,
    });
    applyConfig(response.data);
    emit(
      "message",
      enabled.value ? "入力フォームを保存して公開しました。" : "入力フォーム設定を保存しました。",
    );
  } catch (error) {
    emit("message", errorMessage(error, "フォーム設定を保存できませんでした。"));
  } finally {
    saving.value = false;
  }
};

const copyUrl = async (): Promise<void> => {
  if (!publicUrl.value) return;
  try {
    await navigator.clipboard.writeText(publicUrl.value);
    emit("message", "公開フォームURLをコピーしました。");
  } catch {
    emit("message", "URLをコピーできませんでした。表示されたURLを手動でコピーしてください。");
  }
};

const rotateUrl = async (): Promise<void> => {
  if (!window.confirm("以前のフォームURLは利用できなくなります。再発行しますか？")) return;
  try {
    const response = await apiClient.post<FormConfig>(`${formBaseUrl.value}/rotate-url`);
    applyConfig(response.data);
    emit("message", "公開フォームURLを再発行しました。");
  } catch (error) {
    emit("message", errorMessage(error, "URLを再発行できませんでした。"));
  }
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="20" :closeOnOverlayClick="false" @close="emit('close')">
    <div class="form-settings">
      <header>
        <div>
          <h2>マーカー入力フォーム</h2>
          <p>フォームの各種設定をします。</p>
        </div>
        <button type="button" class="close-button" @click="emit('close')">閉じる</button>
      </header>

      <p v-if="loading" class="loading">設定を読み込んでいます…</p>
      <template v-else>
        <label class="enabled-row">
          <input v-model="enabled" type="checkbox" />
          公開フォームからの追記を許可する
        </label>

        <div class="basic-settings">
          <label>
            フォーム名
            <input v-model="formTitle" type="text" maxlength="100" />
          </label>
          <label>
            説明
            <textarea v-model="formDescription" maxlength="1000"></textarea>
          </label>
        </div>

        <section>
          <div class="section-heading">
            <h3>入力項目</h3>
            <button type="button" @click="addField">項目を追加</button>
          </div>
          <p v-if="fields.length === 0" class="empty">入力項目はまだありません。</p>
          <article v-for="(field, index) in fields" :key="field.id" class="field-card">
            <div class="field-card-heading">
              <strong>項目 {{ index + 1 }}</strong>
              <div>
                <button type="button" :disabled="index === 0" @click="moveField(index, -1)">
                  ↑
                </button>
                <button
                  type="button"
                  :disabled="index === fields.length - 1"
                  @click="moveField(index, 1)"
                >
                  ↓
                </button>
                <button type="button" class="danger" @click="removeField(index)">削除</button>
              </div>
            </div>
            <div class="field-grid">
              <label>
                項目名
                <input v-model="field.label" type="text" maxlength="80" />
              </label>
              <label>
                種類
                <select v-model="field.type">
                  <option v-for="(label, value) in fieldTypeLabels" :key="value" :value="value">
                    {{ label }}
                  </option>
                </select>
              </label>
              <label v-if="field.type === 'text' || field.type === 'textarea'">
                最大文字数
                <input v-model.number="field.max_length" type="number" min="1" max="5000" />
              </label>
              <label class="required-row">
                <input v-model="field.required" type="checkbox" /> 必須
              </label>
            </div>
            <label v-if="field.type === 'select' || field.type === 'radio'">
              選択肢（1行につき1件）
              <textarea v-model="field.choicesText" maxlength="3000"></textarea>
            </label>
          </article>
        </section>

        <section>
          <h3>パスワード</h3>
          <p class="status">現在: {{ isPasswordProtected ? "設定済み" : "未設定" }}</p>
          <div class="password-actions">
            <label><input v-model="passwordMode" type="radio" value="keep" /> 変更しない</label>
            <label><input v-model="passwordMode" type="radio" value="set" /> 新しく設定</label>
            <label><input v-model="passwordMode" type="radio" value="clear" /> 解除</label>
          </div>
          <input
            v-if="passwordMode === 'set'"
            v-model="password"
            type="password"
            minlength="4"
            maxlength="64"
            placeholder="4〜64文字"
          />
        </section>

        <section v-if="publicUrl" class="url-section">
          <h3>公開URL</h3>
          <input :value="publicUrl" type="text" readonly />
          <div class="url-actions">
            <button type="button" @click="copyUrl">URLをコピー</button>
            <a :href="publicUrl" target="_blank" rel="noopener noreferrer">フォームを確認</a>
            <button type="button" class="secondary" @click="rotateUrl">URLを再発行</button>
          </div>
        </section>

        <footer>
          <button type="button" class="save-button" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : "フォーム設定を保存" }}
          </button>
        </footer>
      </template>
    </div>
  </BaseModal>
</template>

<style scoped>
.form-settings {
  width: min(860px, 86vw);
  max-height: 86vh;
  overflow-y: auto;
  padding: 6px;
}
header,
.section-heading,
.field-card-heading,
.url-actions,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2,
h3,
p {
  margin-top: 0;
}
header p,
.status,
.empty {
  color: #5c6778;
}
button,
a {
  border: 1px solid #b7c1d0;
  border-radius: 8px;
  padding: 9px 13px;
  background: #fff;
  color: #172033;
  text-decoration: none;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.close-button {
  align-self: flex-start;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  background-color: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font: inherit;
  font-weight: 500;
  transition: border-color 0.25s;
}
.close-button:hover {
  border-color: #396cd8;
}
.close-button:active {
  border-color: #396cd8;
  background-color: #e8e8e8;
}
.enabled-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  background: #c1d2f0;
  font-weight: 700;
}
input[type="checkbox"],
input[type="radio"] {
  width: auto;
}
.basic-settings,
section {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}
label {
  display: grid;
  gap: 6px;
}
input,
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid #aeb9c8;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
textarea {
  min-height: 78px;
  resize: vertical;
}
.field-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid #ccd5e1;
  border-radius: 12px;
  background: #fff;
}
.field-grid {
  display: grid;
  grid-template-columns: 2fr 1.2fr 1fr auto;
  gap: 12px;
  align-items: end;
}
.required-row {
  display: flex;
  align-items: center;
  min-height: 42px;
}
.danger {
  color: #a51d1d;
}
.password-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.password-actions label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.url-section {
  padding: 14px;
  border-radius: 12px;
  background: #cee9d1;
}
.url-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.secondary {
  background: #eef1f5;
}
footer {
  justify-content: flex-end;
  margin-top: 22px;
}
.save-button {
  padding: 12px 20px;
  border-color: #176b4d;
  background: #19875f;
  color: #fff;
  font-weight: 700;
}
.loading {
  padding: 40px;
  text-align: center;
}
@media (max-width: 680px) {
  .form-settings {
    width: 82vw;
  }
  .field-grid {
    grid-template-columns: 1fr;
  }
  header {
    align-items: flex-start;
  }
}

@media (orientation: portrait) {
  .form-settings {
    box-sizing: border-box;
    width: min(calc(100vw - 64px), 860px);
    max-height: calc(100dvh - 64px);
  }

  .field-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  header,
  footer {
    flex-wrap: wrap;
  }
}

@media (orientation: portrait) and (max-width: 900px) {
  .field-grid {
    grid-template-columns: 1fr;
  }

  header {
    align-items: flex-start;
  }
}
</style>
