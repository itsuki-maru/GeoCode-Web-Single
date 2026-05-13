<script setup lang="ts">
import { ref, computed } from "vue";
import type { Ref } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import type { LayersData, ShareLayerCheckList } from "@/interface";
import { generateOnetimeMapUrl, getCurrentOnetimeMapUrl } from "@/router/urls";
import apiClient from "@/axiosClient";

const props = defineProps<{
  isOpen: boolean;
  layerList: Map<string, LayersData>;
}>();

const emit = defineEmits<{
  close: [];
  generated: [url: string, uuid: string, updateUrl: boolean, expiration: string];
  message: [text: string];
}>();

type MapShareLayerCheckList = Map<string, ShareLayerCheckList>;
const rows: Ref<MapShareLayerCheckList> = ref(new Map<string, ShareLayerCheckList>());
const onetimeDurationMinits = ref(60);
const existingSharedUrl = ref("");
const existingSharedUuid = ref("");
const existingSharedExpiration = ref("");
const existingSharedProtected = ref(false);
const sharePassword = ref("");
const includeShapes = ref(false);

const isDropdownOpen = ref(false);

type OnetimeAction = { label: string; updateUrl: boolean };
const actions: OnetimeAction[] = [
  { label: "共有マップ作成（リンクを新規発行）", updateUrl: false },
  { label: "共有マップ作成（リンクを更新）", updateUrl: true },
];
const selectedAction = ref<OnetimeAction>(actions[0]!);

const selectAction = (action: OnetimeAction): void => {
  selectedAction.value = action;
  isDropdownOpen.value = false;
};

const currentUrl = window.location.href;
const url = new URL(currentUrl);
const protocol = url.protocol;
const hostname = url.hostname;
const port = url.port;

const initRows = (): void => {
  rows.value.clear();
  for (let [key, value] of props.layerList) {
    rows.value.set(key, {
      id: value.id,
      layerName: value.name,
      checked: false,
    });
  }
};

const formatExpiration = (value: string): string => {
  if (!value) {
    return "";
  }

  const normalizedValue = value.includes("T") ? `${value}Z` : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
};

const buildAbsoluteUrl = (path: string): string => {
  if (port === "") {
    return `${protocol}//${hostname}${port}${path}`;
  }
  return `${protocol}//${hostname}:${port}${path}`;
};

const fetchCurrentSharedUrl = async (): Promise<void> => {
  existingSharedUrl.value = "";
  existingSharedUuid.value = "";
  existingSharedExpiration.value = "";
  existingSharedProtected.value = false;
  try {
    const response = await apiClient.get(getCurrentOnetimeMapUrl);
    existingSharedUrl.value = buildAbsoluteUrl(response.data["url"]);
    existingSharedUuid.value = response.data["id"];
    existingSharedExpiration.value = formatExpiration(response.data["expiration"]);
    existingSharedProtected.value = response.data["is_password_protected"];
  } catch (_error) {
    // 未作成時は何もしない
  }
};

const getCheckedLayersIds = () => {
  return Array.from(rows.value.values())
    .filter((row) => row.checked)
    .map((row) => row.id);
};

const genOnetimeMapUrl = async (updateUrl: boolean = true): Promise<void> => {
  try {
    if (Number.isInteger(onetimeDurationMinits.value) === false) {
      emit("message", "数値を入力してください。");
      return;
    }
    if (onetimeDurationMinits.value < 10) {
      emit("message", "10分以上の設定が必要です。");
      return;
    }

    const checkedLayers = getCheckedLayersIds();

    if (checkedLayers.length === 0) {
      emit("message", "レイヤが選択されていません。");
      return;
    }

    const payload = {
      minutes: onetimeDurationMinits.value,
      layers: checkedLayers,
      update_url: updateUrl,
      share_password: sharePassword.value,
      include_shapes: includeShapes.value,
    };

    const response = await apiClient.post(generateOnetimeMapUrl, payload);

    emit(
      "generated",
      buildAbsoluteUrl(response.data["url"]),
      response.data["id"],
      updateUrl,
      response.data["expiration"],
    );
    await fetchCurrentSharedUrl();
  } catch (error) {
    console.error("Error");
  }
};

const openExistingSharedUrl = (): void => {
  if (!existingSharedUrl.value || !existingSharedUuid.value) {
    emit("message", "現在有効な共有リンクはありません。");
    return;
  }
  emit(
    "generated",
    existingSharedUrl.value,
    existingSharedUuid.value,
    true,
    existingSharedExpiration.value,
  );
};

defineExpose({ initRows, fetchCurrentSharedUrl });
</script>

<template>
  <BaseModal :isOpen="isOpen" :zIndex="3" :close-on-overlay-click="false" @close="emit('close')">
    <div class="onetime-setting-content">
      <h2 class="modal-h2">マップの共有リンク作成</h2>
      <div class="setting-layout">
        <div class="setting-side-panel">
          <div class="input-area-duration">
            <label for="minits" class="field-label">有効期限（分）</label>
            <input
              v-model="onetimeDurationMinits"
              type="number"
              step="10"
              class="input-minits"
              id="minits"
            />
          </div>
          <div class="input-area-duration password-area">
            <label for="share-password" class="field-label">共有パスワード</label>
            <input
              v-model="sharePassword"
              type="text"
              name="share-password"
              spellcheck="false"
              maxlength="64"
              class="input-minits"
              id="share-password"
              placeholder="未入力で保護なし"
            />
          </div>
          <div class="share-option-row">
            <label for="include-shapes" class="field-label">図形も共有する</label>
            <input v-model="includeShapes" type="checkbox" id="include-shapes" />
          </div>
          <div v-if="existingSharedUrl" class="existing-share-box">
            <div class="existing-share-title">現在有効な共有リンクがあります</div>
            <div class="existing-share-expiration">有効期限: {{ existingSharedExpiration }}</div>
            <div class="existing-share-expiration">
              パスワード保護: {{ existingSharedProtected ? "あり" : "なし" }}
            </div>
            <button class="existing-share-btn" @click="openExistingSharedUrl()">
              現在のリンクを確認
            </button>
          </div>
        </div>
        <div class="setting-layer-panel">
          <div class="layer-table-title">共有するレイヤ</div>
          <div class="table-sticky-layerlist">
            <table>
              <thead>
                <tr>
                  <th>LayerName</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="[id, layer] in rows" :key="id">
                  <td>{{ layer.layerName }}</td>
                  <td style="text-align: center">
                    <input
                      type="checkbox"
                      :name="layer.layerName"
                      v-model="layer.checked"
                      :id="`checkedLayer-${layer.id}`"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="btn-zone">
        <button @click="emit('close')">閉じる</button>
        <div class="dropdown-btn">
          <button @click="genOnetimeMapUrl(selectedAction.updateUrl)">
            {{ selectedAction.label }}
          </button>
          <button
            :class="['dropdown-toggle', { 'is-open': isDropdownOpen }]"
            @click="isDropdownOpen = !isDropdownOpen"
          ></button>
          <div v-if="isDropdownOpen" class="dropdown-menu">
            <button
              v-for="action in actions"
              :key="action.label"
              :class="{ 'is-selected': action.label === selectedAction.label }"
              @click="selectAction(action)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.onetime-setting-content {
  width: min(78vw, 980px);
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
  margin-bottom: 18px;
}

.setting-layout {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.setting-side-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.setting-layer-panel {
  min-width: 0;
}

.layer-table-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
}

.input-area-duration {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.field-label {
  font-size: 16px;
}

.input-minits {
  font-size: 16px;
  text-align: center;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid #c5cfdb;
  border-radius: 10px;
}

.password-area {
  margin-top: 0;
}

#share-password {
  text-align: center;
}

.share-option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #c5cfdb;
  border-radius: 10px;
  background: white;
}

.table-sticky-layerlist table {
  margin-top: 0;
  width: 100%;
}

.table-sticky-layerlist {
  display: block;
  overflow-y: auto;
  height: 46vh;
  border: 1px solid #d6dce5;
  border-radius: 10px;
  background: white;
}

.table-sticky-layerlist thead th {
  position: sticky;
  top: 0;
  width: 100%;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

.table-sticky-layerlist table tbody tr:hover {
  background-color: #69a5b8;
}

.existing-share-box {
  padding: 12px;
  background: #f4f8fc;
  border: 1px solid #c9d8ea;
  border-radius: 10px;
}

.existing-share-title {
  font-weight: 600;
  margin-bottom: 6px;
}

.existing-share-expiration {
  font-size: 13px;
  color: #49566a;
  margin-bottom: 10px;
}

.existing-share-btn {
  width: 100%;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

.dropdown-btn {
  position: relative;
  display: flex;
  border-radius: 4px;
  overflow: visible;
}

.dropdown-btn > button:first-child {
  border-radius: 4px 0 0 4px;
  border-right: none;
}

.dropdown-toggle {
  padding: 0 8px;
  border-radius: 0 4px 4px 0;
  border-left: 1px solid rgba(0, 0, 0, 0.15);
  cursor: pointer;
  display: flex;
  align-items: center;
}

.dropdown-toggle::after {
  content: "";
  display: block;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform 0.15s ease;
}

.dropdown-toggle.is-open::after {
  transform: rotate(180deg);
}

.dropdown-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 100%;
  background: white;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  white-space: nowrap;
  z-index: 10;
  box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
  overflow: hidden;
}

.dropdown-menu button {
  position: relative;
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 16px 8px 34px;
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  color: #24292f;
}

.dropdown-menu button:hover {
  background-color: #f6f8fa;
}

.dropdown-menu button.is-selected {
  font-weight: 600;
}

.dropdown-menu button.is-selected::before {
  content: "✓";
  position: absolute;
  left: 12px;
  font-weight: normal;
  color: rgb(44, 52, 78);
}

@media (max-width: 900px) {
  .onetime-setting-content {
    width: min(88vw, 720px);
  }

  .setting-layout {
    grid-template-columns: 1fr;
  }

  .table-sticky-layerlist {
    height: 34vh;
  }
}
</style>
