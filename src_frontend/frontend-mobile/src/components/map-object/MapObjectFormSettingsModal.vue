<script setup lang="ts">
import "./form-modal-buttons.css";
import { computed, ref, watch } from "vue";
import MessageModal from "@/components/common/MessageModal.vue";
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
  managed_layer_id?: string | null;
  managed_layer_count?: number;
  managed_target_count?: number;
  applied_target_count?: number;
  source_form?: { id: string; version: number } | null;
  id?: string;
  version?: number;
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
  commonMode?: boolean;
  commonId?: string;
}>();

const emit = defineEmits<{
  close: [];
  saved: [];
  message: [text: string];
}>();

const managedLayerId = ref<string | null>(null),
  managedNoticeOpen = ref(false),
  confirmSaveOpen = ref(false);
const managedLayerCount = ref(0),
  managedTargetCount = ref(0),
  appliedTargetCount = ref(0);
const managedMessage =
  "このレイヤの地図オブジェクトには共通フォームが設定されています。個別のフォームにするには設定を解除するか、所属するレイヤを変更してください。";
const saveConfirmation = computed(
  () =>
    `共通フォームの変更を、管理中の${managedLayerCount.value}レイヤ・${managedTargetCount.value}対象へ反映します。${passwordMode.value !== "keep" ? `パスワードの変更は手動コピー適用先を含む${appliedTargetCount.value}対象へ反映します。` : ""}回答履歴・本文・画像は変更しません。保存しますか？`,
);
const sourceForm = ref<{ id: string; version: number } | null>(null);
const commonForms = ref<FormConfig[]>([]);
const selectedCommonId = ref("");
const confirmApplyOpen = ref(false);
const applyMessage = computed(() =>
  currentState() !== initialState.value
    ? "未保存の編集内容を破棄し、共通フォームの内容で置き換えますか？"
    : "フォーム名・説明・入力項目を共通フォームの内容で置き換えますか？",
);
const commonVersion = ref<number | null>(null);
const initialState = ref("");
const currentState = () => JSON.stringify([formTitle.value, formDescription.value, fields.value]);
const enabled = ref(false);
const formTitle = ref("");
const formDescription = ref("");
const fields = ref<FormField[]>([]);
const fieldHelpOpen = ref(false);
const publicPath = ref<string | null>(null);
const isPasswordProtected = ref(false);
const passwordMode = ref<"keep" | "set" | "clear">("keep");
const password = ref("");
const loading = ref(false);
const saving = ref(false);
const applying = ref(false);
const localMessage = ref("");
const notify = (message: string) => {
  localMessage.value = message;
  emit("message", message);
};

const publicUrl = computed(() =>
  publicPath.value ? `${window.location.origin}${publicPath.value}` : "",
);
const formBaseUrl = computed(() =>
  props.commonMode
    ? `/common-forms${props.commonId ? `/${props.commonId}` : ""}`
    : `/${props.targetType}/${props.targetId}/form`,
);

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
    if (error.response?.status === 409)
      return "別の画面で設定が更新されました。開き直して再編集してください。";
    const data = error.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error.replace(/^validation error:\s*/, "");
  }
  return fallback;
};

const applyConfig = (config: FormConfig): void => {
  managedLayerId.value = config.managed_layer_id || null;
  managedLayerCount.value = config.managed_layer_count || 0;
  managedTargetCount.value = config.managed_target_count || 0;
  appliedTargetCount.value = config.applied_target_count || 0;
  sourceForm.value = config.source_form || null;
  commonVersion.value = config.version || null;
  enabled.value = props.commonMode ? true : config.enabled;
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
  initialState.value = currentState();
};

const loadConfig = async (): Promise<void> => {
  localMessage.value = "";
  managedNoticeOpen.value = false;
  confirmSaveOpen.value = false;
  managedLayerId.value = null;
  selectedCommonId.value = "";
  confirmApplyOpen.value = false;
  commonForms.value = [];
  if (props.commonMode && !props.commonId) {
    applyConfig({
      enabled: true,
      form_title: "",
      form_description: "",
      form_schema: { fields: [] },
      is_password_protected: false,
      public_path: null,
    });
    return;
  }
  if (!props.commonMode && !props.targetId) return;
  loading.value = true;
  try {
    const response = await apiClient.get<FormConfig>(formBaseUrl.value);
    applyConfig(response.data);
    managedNoticeOpen.value = !!managedLayerId.value;
    if (!props.commonMode && !managedLayerId.value) {
      try {
        commonForms.value = (await apiClient.get<FormConfig[]>("/common-forms")).data;
      } catch {
        notify("共通フォーム一覧を読み込めませんでした。画面を開き直してください。");
      }
    }
  } catch (error) {
    notify(errorMessage(error, "フォーム設定を読み込めませんでした。"));
    emit("close");
  } finally {
    loading.value = false;
  }
};

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      fieldHelpOpen.value = false;
      void loadConfig();
    }
  },
);

const newFieldId = () =>
  `f_${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("")}`;

const addField = (): void => {
  fields.value.push({
    id: newFieldId(),
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
  if ((props.commonMode || enabled.value) && fields.value.length === 0)
    return "入力項目を追加してください。";
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

const applyCommonForm = async (): Promise<void> => {
  if (!selectedCommonId.value || applying.value || saving.value) return;
  confirmApplyOpen.value = false;
  applying.value = true;
  try {
    const config = (await apiClient.get<FormConfig>(`/common-forms/${selectedCommonId.value}`))
      .data;
    formTitle.value = config.form_title;
    formDescription.value = config.form_description;
    fields.value = config.form_schema.fields.map((field) => ({
      ...field,
      choices: [...field.choices],
      choicesText: field.choices.join("\n"),
    }));
    sourceForm.value = { id: config.id!, version: config.version! };
    notify("共通フォームを読み込みました。保存すると対象に適用されます。");
  } catch (error) {
    notify(errorMessage(error, "共通フォームを読み込めませんでした。"));
  } finally {
    applying.value = false;
  }
};

const changeFieldType = (field: FormField): void => {
  field.id = newFieldId();
};

const persist = async (): Promise<void> => {
  confirmSaveOpen.value = false;
  if (saving.value || applying.value) return;
  const validation = validateBeforeSave();
  if (validation) {
    notify(validation);
    return;
  }
  saving.value = true;
  try {
    const response = await apiClient.request<FormConfig>({
      url: formBaseUrl.value,
      method: props.commonMode && !props.commonId ? "post" : "put",
      data: {
        source_form: sourceForm.value,
        version: commonVersion.value,
        expected_managed_count: managedTargetCount.value,
        expected_applied_count: appliedTargetCount.value,
        enabled: enabled.value,
        form_title: formTitle.value,
        form_description: formDescription.value,
        form_schema: { fields: normalizeFields() },
        password_mode: passwordMode.value,
        password: passwordMode.value === "set" ? password.value : null,
      },
    });
    applyConfig(response.data);
    emit("saved");
    notify(
      props.commonMode
        ? "共通フォームを保存しました。"
        : enabled.value
          ? "入力フォームを保存して公開しました。"
          : "入力フォーム設定を保存しました。",
    );
  } catch (error) {
    notify(
      errorMessage(
        error,
        "保存できませんでした。別の画面で更新された場合は、開き直して再編集してください。",
      ),
    );
  } finally {
    saving.value = false;
  }
};

const save = async (): Promise<void> => {
  if (saving.value || applying.value) return;
  const validation = validateBeforeSave();
  if (validation) {
    notify(validation);
    return;
  }
  if (props.commonMode && props.commonId) {
    saving.value = true;
    try {
      const current = (await apiClient.get<FormConfig>(formBaseUrl.value)).data;
      if (current.version !== commonVersion.value) {
        notify("別の画面で設定が更新されました。開き直して再編集してください。");
        return;
      }
      managedLayerCount.value = current.managed_layer_count || 0;
      managedTargetCount.value = current.managed_target_count || 0;
      appliedTargetCount.value = current.applied_target_count || 0;
      if (
        managedLayerCount.value > 0 ||
        (passwordMode.value !== "keep" && appliedTargetCount.value > 0)
      ) {
        confirmSaveOpen.value = true;
        return;
      }
    } catch (error) {
      notify(errorMessage(error, "反映先を確認できませんでした。"));
      return;
    } finally {
      saving.value = false;
    }
  }
  await persist();
};

const copyUrl = async (): Promise<void> => {
  if (!publicUrl.value) return;
  try {
    await navigator.clipboard.writeText(publicUrl.value);
    notify("公開フォームURLをコピーしました。");
  } catch {
    notify("URLをコピーできませんでした。表示されたURLを手動でコピーしてください。");
  }
};

const rotateUrl = async (): Promise<void> => {
  if (!window.confirm("以前のフォームURLは利用できなくなります。再発行しますか？")) return;
  try {
    const response = await apiClient.post<FormConfig>(`${formBaseUrl.value}/rotate-url`);
    applyConfig(response.data);
    notify("公開フォームURLを再発行しました。");
  } catch (error) {
    notify(errorMessage(error, "URLを再発行できませんでした。"));
  }
};
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="20" :closeOnOverlayClick="false" @close="emit('close')">
    <div class="form-settings">
      <header>
        <div>
          <h2>
            {{
              commonMode ? (commonId ? "共通フォームの編集" : "共通フォームの作成") : "入力フォーム"
            }}
          </h2>
          <p>フォームの各種設定をします。</p>
        </div>
        <button
          type="button"
          class="close-button btn-close"
          :disabled="saving || applying"
          @click="emit('close')"
        >
          閉じる
        </button>
      </header>

      <p v-if="localMessage" role="status">{{ localMessage }}</p>
      <p v-if="loading" class="loading">設定を読み込んでいます…</p>
      <fieldset v-else class="form-content" :disabled="saving || applying">
        <section v-if="!commonMode && !managedLayerId">
          <div class="common-form-apply-row">
            <label
              >共通フォーム
              <select v-model="selectedCommonId">
                <option value="">選択してください</option>
                <option v-for="form in commonForms" :key="form.id" :value="form.id">
                  {{ form.form_title }}（第{{ form.version }}版）
                </option>
              </select>
            </label>
            <button
              class="btn-close"
              type="button"
              :disabled="!selectedCommonId || saving"
              @click="confirmApplyOpen = true"
            >
              共通フォームを使用する
            </button>
          </div>
          <p>読み込むとフォーム名・説明・入力項目を置き換えます。公開設定は維持されます。</p>
          <p v-if="sourceForm">
            共通フォームの第{{ sourceForm.version }}版からコピーした設定です。
          </p>
        </section>
        <p v-if="managedLayerId" class="managed-notice">{{ managedMessage }}</p>
        <label v-if="!commonMode" class="enabled-row">
          <input v-model="enabled" type="checkbox" />
          公開フォームからの追記を許可する
        </label>

        <fieldset class="readonly-definition" :disabled="!!managedLayerId">
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
              <h3>
                入力項目
                <button
                  type="button"
                  class="field-help-button"
                  aria-label="入力項目の編集について"
                  :aria-expanded="fieldHelpOpen"
                  @click="fieldHelpOpen = !fieldHelpOpen"
                >
                  ?
                </button>
              </h3>
              <button class="btn-close" type="button" @click="addField">項目を追加</button>
            </div>
            <p v-if="fieldHelpOpen" class="field-help">
              項目名の誤字修正や並べ替えは、そのまま編集できます。質問の内容を変える場合は、その項目を削除して追加し直してください。入力の種類を変更した場合も、過去の回答とは別の項目として扱われます。
            </p>
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
                  <select v-model="field.type" @change="changeFieldType(field)">
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

          <section v-if="!managedLayerId">
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
        </fieldset>
        <section v-if="!commonMode && publicUrl" class="url-section">
          <h3>公開URL</h3>
          <input :value="publicUrl" type="text" readonly />
          <div class="url-actions">
            <button class="btn-close" type="button" @click="copyUrl">URLをコピー</button>
            <a
              v-if="!managedLayerId"
              class="btn-close"
              :href="publicUrl"
              target="_blank"
              rel="noopener noreferrer"
              >フォームを確認</a
            >
            <button type="button" class="secondary btn-close" @click="rotateUrl">
              URLを再発行
            </button>
          </div>
        </section>

        <footer>
          <button type="button" class="save-button btn-close" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : commonMode ? "共通フォームを保存" : "フォーム設定を保存" }}
          </button>
        </footer>
      </fieldset>
    </div>
  </BaseModal>
  <MessageModal
    class="common-form-confirm"
    :isOpen="isOpen && confirmApplyOpen"
    :message="applyMessage"
    confirmLabel="共通フォームを使用する"
    @close="confirmApplyOpen = false"
    @confirm="applyCommonForm"
  />
  <MessageModal
    :isOpen="isOpen && managedNoticeOpen"
    :message="managedMessage"
    @close="managedNoticeOpen = false"
  />
  <MessageModal
    :isOpen="isOpen && confirmSaveOpen"
    :message="saveConfirmation"
    confirmLabel="保存して反映する"
    @close="confirmSaveOpen = false"
    @confirm="persist"
  />
</template>

<style scoped>
.readonly-definition {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.managed-notice {
  font-size: 14px;
  overflow-wrap: anywhere;
}

.common-form-apply-row {
  display: flex;
  align-items: flex-end;
  flex-wrap: nowrap;
  gap: 12px;
}
.common-form-apply-row > label {
  flex: 1 1 0;
  min-width: 0;
}
.common-form-apply-row > button {
  flex: 0 0 auto;
}
@media (max-width: 480px) {
  .common-form-apply-row {
    gap: 6px;
  }
  .form-settings .common-form-apply-row > .btn-close {
    padding: 9px 4px;
    font-size: 12px;
  }
}

.form-content {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.form-settings {
  width: 100%;
  max-height: 86vh;
  box-sizing: border-box;
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
  flex-shrink: 0;
  border: 1px solid transparent;
  padding: 0.4em 0.8em;
  background-color: #5f5f5f;
  color: #fff;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
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
.field-help-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 6px;
  padding: 0;
  border: 1px solid #5f5f5f;
  border-radius: 50%;
  background: #fff;
  color: #333;
  font-size: 13px;
  vertical-align: middle;
  cursor: pointer;
}
.field-help-button:focus-visible {
  outline: 2px solid #396cd8;
  outline-offset: 2px;
}
.field-help {
  padding: 12px;
  border-radius: 8px;
  background: #eef1f5;
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
  .field-grid {
    grid-template-columns: 1fr;
  }
  header {
    align-items: flex-start;
  }
}
</style>
