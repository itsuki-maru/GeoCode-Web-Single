<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from "vue";
import type { Ref } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import type { LayersData, ShareLayerCheckList } from "@/interface";
import { generateOnetimeMapUrl, getCurrentOnetimeMapUrl } from "@/router/urls";
import apiClient from "@/axiosClient";
import {
  isShareMapSnapshot,
  type ShareMapSnapshot,
} from "../../../../template-scripts/src/map/common/share-snapshot";

const props = defineProps<{
  isOpen: boolean;
  layerList: Map<string, LayersData>;
  snapshot?: ShareMapSnapshot | null;
  zIndex?: number;
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
const includeTileOverlays = ref(false);
const submitting = ref(false);
const snapshotMode = ref(false);
const frozenSnapshot = shallowRef<ShareMapSnapshot | null>(null);
const snapshotError = ref("");
const isDropdownOpen = ref(false);
let session = 0;
let currentFetchId = 0;

watch(
  () => props.isOpen,
  (open) => {
    ++session;
    isDropdownOpen.value = false;
    frozenSnapshot.value = null;
    snapshotMode.value = open && props.snapshot != null;
    snapshotError.value = "";
    if (!snapshotMode.value) return;
    try {
      if (!isShareMapSnapshot(props.snapshot)) throw Error("Invalid snapshot");
      frozenSnapshot.value = JSON.parse(JSON.stringify(props.snapshot));
    } catch {
      snapshotError.value =
        "共有する地図を取得できませんでした。地図からもう一度共有してください。";
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++session;
  ++currentFetchId;
});

const snapshotSummary = computed(() => {
  const snapshot = frozenSnapshot.value;
  if (!snapshot) return null;
  return {
    layers: Object.values(snapshot.layers).map((layer) => layer.layer_name),
    markers: Object.keys(snapshot.markers).length,
    shapes: snapshot.shapes.length,
    coloring: Boolean(snapshot.state.coloring),
    background: snapshot.tileServers[snapshot.state.tileServerId]?.label || "選択中の背景地図",
    tiles: snapshot.tileOverlays
      .filter((tile) => snapshot.state.overlays[tile.id])
      .map((tile) => tile.name),
    view: snapshot.state.view,
  };
});

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
  const fetchId = ++currentFetchId;
  existingSharedUrl.value = "";
  existingSharedUuid.value = "";
  existingSharedExpiration.value = "";
  existingSharedProtected.value = false;
  try {
    const response = await apiClient.get(getCurrentOnetimeMapUrl);
    if (fetchId !== currentFetchId) return;
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
  if (!props.isOpen || submitting.value) return;
  const requestSession = session;
  try {
    if (Number.isInteger(onetimeDurationMinits.value) === false) {
      emit("message", "数値を入力してください。");
      return;
    }
    if (onetimeDurationMinits.value < 10) {
      emit("message", "10分以上の設定が必要です。");
      return;
    }

    const snapshot = frozenSnapshot.value;
    if (snapshotMode.value && !snapshot) {
      emit("message", snapshotError.value);
      return;
    }
    const checkedLayers = snapshot ? Object.keys(snapshot.layers) : getCheckedLayersIds();

    if (!snapshot && checkedLayers.length === 0) {
      emit("message", "レイヤが選択されていません。");
      return;
    }

    const payload = {
      minutes: onetimeDurationMinits.value,
      layers: checkedLayers,
      update_url: updateUrl,
      share_password: sharePassword.value,
      include_shapes: snapshot ? snapshot.shapes.length > 0 : includeShapes.value,
      include_tile_overlays: snapshot
        ? snapshot.tileOverlays.length > 0
        : includeTileOverlays.value,
      ...(snapshot ? { snapshot } : {}),
    };

    submitting.value = true;
    const response = await apiClient.post(generateOnetimeMapUrl, payload);
    if (requestSession !== session || !props.isOpen) return;

    emit(
      "generated",
      buildAbsoluteUrl(response.data["url"]),
      response.data["id"],
      updateUrl,
      response.data["expiration"],
    );
    await fetchCurrentSharedUrl();
  } catch (error) {
    if (requestSession !== session || !props.isOpen) return;
    const response = (error as { response?: { status?: number; data?: { error?: unknown } } })
      ?.response;
    const detail = response?.data?.error;
    emit(
      "message",
      typeof detail === "string" && detail.length > 0 && detail.length <= 500
        ? detail
        : response?.status === 413
          ? "共有するデータが大きすぎます。地図の対象を絞ってからもう一度実行してください。"
          : "共有リンクを作成できませんでした。通信状態を確認してもう一度実行してください。",
    );
  } finally {
    submitting.value = false;
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
  <BaseModal
    :isOpen="isOpen"
    :zIndex="zIndex ?? 3"
    :close-on-overlay-click="false"
    @close="!submitting && emit('close')"
  >
    <div class="onetime-setting-content">
      <h2 class="modal-h2">
        {{ snapshotMode ? "現在の地図を共有する" : "マップの共有リンク作成" }}
      </h2>
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
              :disabled="submitting"
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
              :disabled="submitting"
            />
          </div>
          <div v-if="!snapshotMode" class="share-option-row">
            <label for="include-shapes" class="field-label">図形も共有する</label>
            <input
              v-model="includeShapes"
              type="checkbox"
              id="include-shapes"
              :disabled="submitting"
            />
          </div>
          <div v-if="!snapshotMode" class="share-option-row">
            <label for="include-tile-overlays" class="field-label"
              >重ねるタイルレイヤも共有する</label
            >
            <input
              v-model="includeTileOverlays"
              type="checkbox"
              id="include-tile-overlays"
              :disabled="submitting"
            />
          </div>
          <div v-if="existingSharedUrl" class="existing-share-box">
            <div class="existing-share-title">現在有効な共有リンクがあります</div>
            <div class="existing-share-expiration">有効期限: {{ existingSharedExpiration }}</div>
            <div class="existing-share-expiration">
              パスワード保護: {{ existingSharedProtected ? "あり" : "なし" }}
            </div>
            <button
              class="existing-share-btn"
              :disabled="submitting"
              @click="openExistingSharedUrl()"
            >
              現在のリンクを確認
            </button>
          </div>
        </div>
        <div v-if="snapshotMode" class="setting-layer-panel snapshot-summary">
          <div class="layer-table-title">共有する地図の内容</div>
          <p v-if="snapshotError" role="alert">{{ snapshotError }}</p>
          <template v-if="snapshotSummary">
            <p>
              共有ボタンを押した時点の地図を保存します。絞り込みや検索で除外されたデータは含まれません。
            </p>
            <dl>
              <dt>共有対象</dt>
              <dd>マーカー {{ snapshotSummary.markers }}件・図形 {{ snapshotSummary.shapes }}件</dd>
              <dt>色分け</dt>
              <dd>{{ snapshotSummary.coloring ? "あり" : "なし" }}</dd>
              <dt>背景地図</dt>
              <dd>{{ snapshotSummary.background }}</dd>
              <dt>地図の中心</dt>
              <dd>
                {{ snapshotSummary.view.latitude.toFixed(6) }},
                {{ snapshotSummary.view.longitude.toFixed(6) }}
              </dd>
              <dt>ズーム</dt>
              <dd>{{ snapshotSummary.view.zoom }}</dd>
              <dt>表示中の重ねるタイルレイヤ</dt>
              <dd>{{ snapshotSummary.tiles.join("、") || "なし" }}</dd>
              <dt>選択中のレイヤグループ</dt>
              <dd>{{ snapshotSummary.layers.join("、") || "なし" }}</dd>
            </dl>
            <p>地図画面の外にある対象も含めます。背景地図やタイル画像は閲覧時に読み込みます。</p>
            <p>共有リンクは通常の共有と共通です。新規発行すると以前のリンクは使えなくなります。</p>
          </template>
        </div>
        <div v-else class="setting-layer-panel">
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
                      :disabled="submitting"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="btn-zone">
        <button :disabled="submitting" @click="emit('close')">閉じる</button>
        <div class="dropdown-btn">
          <button
            :disabled="submitting || !!snapshotError"
            @click="genOnetimeMapUrl(selectedAction.updateUrl)"
          >
            {{ submitting ? "共有リンクを作成しています…" : selectedAction.label }}
          </button>
          <button
            :class="['dropdown-toggle', { 'is-open': isDropdownOpen }]"
            :disabled="submitting || !!snapshotError"
            aria-label="共有リンクの作成方法"
            :aria-expanded="isDropdownOpen"
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
  max-height: calc(100dvh - 64px);
  overflow-y: auto;
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

.snapshot-summary {
  padding: 12px 16px;
  border: 1px solid #c9d8ea;
  border-radius: 10px;
  background: #f4f8fc;
  overflow-wrap: anywhere;
}

.snapshot-summary p {
  font-size: 14px;
  line-height: 1.6;
}

.snapshot-summary dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 14px;
  font-size: 14px;
}

.snapshot-summary dt {
  font-weight: 600;
}

.snapshot-summary dd {
  margin: 0;
}

.snapshot-summary [role="alert"] {
  color: #b91c1c;
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
