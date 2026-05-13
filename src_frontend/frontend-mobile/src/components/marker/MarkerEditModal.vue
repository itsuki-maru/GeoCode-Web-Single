<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import BaseModal from '@/components/common/BaseModal.vue';
import { useMapObjectStore } from '@/stores/mapobjects';
import { useLayersStore } from '@/stores/layers';
import { assetsUrl } from '@/settingMobile';

const props = defineProps<{
  isOpen: boolean;
  markerId: string;
  isHttpsProtocol: boolean;
}>();

const emit = defineEmits<{
  close: [];
  updated: [id: string, name: string, detail: string, layerId: string];
  openImageUpload: [];
  openImageList: [];
  message: [text: string];
}>();

const mapobjStore = useMapObjectStore();
const layersStore = useLayersStore();
const layerList = computed(() => layersStore.layersList);

const activeMarkerName = ref('');
const activeMarkerDetail = ref('');
const activaMarkerLayer = ref('');

watch(
  () => props.markerId,
  (newId) => {
    if (newId && props.isOpen) {
      const marker = mapobjStore.getById(newId);
      activeMarkerName.value = marker?.marker_name || '';
      activeMarkerDetail.value = marker?.detail || '';
      activaMarkerLayer.value = marker?.layer_id || '';
    }
  },
);

watch(
  () => props.isOpen,
  (open) => {
    if (open && props.markerId) {
      const marker = mapobjStore.getById(props.markerId);
      activeMarkerName.value = marker?.marker_name || '';
      activeMarkerDetail.value = marker?.detail || '';
      activaMarkerLayer.value = marker?.layer_id || '';
    }
  },
);

const updateMarker = (): void => {
  if (
    props.markerId === '' ||
    activeMarkerName.value === '' ||
    activeMarkerDetail.value === '' ||
    activaMarkerLayer.value === ''
  ) {
    emit('message', 'マーカー名と内容の両方に入力が必要です。');
    return;
  }
  emit(
    'updated',
    props.markerId,
    activeMarkerName.value,
    activeMarkerDetail.value,
    activaMarkerLayer.value,
  );
};

function insertMarkdown(text: string) {
  const textareaElm = document.getElementById('detail')! as HTMLTextAreaElement;
  textareaElm.focus();

  const startPos = textareaElm.selectionStart;
  const endPos = textareaElm.selectionEnd;

  const beforeText = textareaElm.value.substring(0, startPos);
  const afterText = textareaElm.value.substring(endPos);

  activeMarkerDetail.value = beforeText + text + afterText;
  textareaElm.value = beforeText + text + afterText;

  const newCursorPos = startPos + text.length;
  textareaElm.setSelectionRange(newCursorPos, newCursorPos);
  textareaElm.focus();
}

const insertUploadedMarkdown = (markdownLink: string) => {
  insertMarkdown(markdownLink);
};

defineExpose({ insertUploadedMarkdown });
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="main-container">
      <h2 id="marker-edit-h2">マーカー情報の編集</h2>
      <div class="input-text-row">
        <input class="input-text" type="text" placeholder="マーカー名" v-model="activeMarkerName" />
        <select class="select-elm-editform" v-model="activaMarkerLayer">
          <option v-for="[id, obj] in layerList" :key="id" :value="obj.id">
            {{ obj.name }}
          </option>
        </select>
      </div>
      <div class="textarea-row">
        <textarea
          class="input-detail-markdown"
          id="detail"
          name="detail"
          placeholder="## マークダウンで記述"
          v-model="activeMarkerDetail"
        ></textarea>
      </div>
      <div class="input-tools">
        <button
          @click="emit('openImageUpload')"
          class="btn-function-image-editor"
          title="ファイルの追加"
        >
          <img
            :src="`${assetsUrl}smartphone_line24.png`"
            class="input-tools-img"
            alt="smartphone_line24.png"
          />
        </button>
        <button
          @click="emit('openImageList')"
          class="btn-function-image-editor"
          title="ファイル一覧"
        >
          <img
            :src="`${assetsUrl}documents_line24.png`"
            class="input-tools-img"
            alt="documents_line24.png"
          />
        </button>
        <button @click="insertMarkdown('## ')" class="btn-function-image-editor" title="## を挿入">
          <img
            :src="`${assetsUrl}format_h2_24.png`"
            class="input-tools-img"
            alt="format_h2_24.png"
          />
        </button>
        <button
          @click="insertMarkdown('### ')"
          class="btn-function-image-editor"
          title="### を挿入"
        >
          <img
            :src="`${assetsUrl}format_h3_24.png`"
            class="input-tools-img"
            alt="format_h3_24.png"
          />
        </button>
        <button @click="insertMarkdown('- ')" class="btn-function-image-editor" title="- を挿入">
          <img
            :src="`${assetsUrl}format_list_bulleted_24.png`"
            class="input-tools-img"
            alt="format_list_bulleted_24.png"
          />
        </button>
        <button @click="insertMarkdown('1. ')" class="btn-function-image-editor" title="1. を挿入">
          <img
            :src="`${assetsUrl}format_list_numbered_24.png`"
            class="input-tools-img"
            alt="format_list_numbered_24.png"
          />
        </button>
        <button @click="insertMarkdown('**')" class="btn-function-image-editor" title="** を挿入">
          <img
            :src="`${assetsUrl}format_bold_24.png`"
            class="input-tools-img"
            alt="format_bold_24.png"
          />
        </button>
        <button
          @click="insertMarkdown('[ Title ]( URL )')"
          class="btn-function-image-editor"
          title="[ Title ]( URL )を挿入"
        >
          <img :src="`${assetsUrl}link_24.png`" class="input-tools-img" alt="link_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::details タイトル\n非表示にする内容\n:::')"
          class="btn-function-image-editor"
          title=":::details を挿入"
        >
          <img :src="`${assetsUrl}more_24.png`" class="input-tools-img" alt="more_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::note タイトル\n内容\n:::')"
          class="btn-function-image-editor"
          title=":::note を挿入"
        >
          <img :src="`${assetsUrl}info_24.png`" class="input-tools-img" alt="info_24.png" />
        </button>
        <button
          @click="insertMarkdown(':::warning タイトル\n内容\n:::')"
          class="btn-function-image-editor"
          title=":::warning を挿入"
        >
          <img :src="`${assetsUrl}warning_24.png`" class="input-tools-img" alt="warning_24.png" />
        </button>
      </div>
      <div class="btn-commit-row">
        <button @click="updateMarker()" class="btn-standard btn-update">+更新</button>
      </div>
      <div class="close-btn-img">
        <img
          @click="emit('close')"
          :src="`${assetsUrl}close_24.png`"
          class="function-img"
          alt="close_24.png"
        />
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.main-container {
  display: flex;
  position: relative;
  flex-direction: column;
  gap: 5px;
  padding: 5px;
}

#marker-edit-h2 {
  text-align: center;
}

.input-text-row {
  text-align: center;
  display: flex;
  width: 100%;
  margin-bottom: 2%;
}

.input-text {
  font-size: 20px;
  width: 70%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.textarea-row {
  text-align: center;
  margin-bottom: 10px;
}

.input-detail-markdown {
  width: 100%;
  height: 60vh;
  padding: 10px 12px;
  margin: auto;
  box-sizing: border-box;
  font-size: 22px;
  color: #333;
  background-color: #f9f9f9;
  border: 1px solid #a9a9a9;
  border-radius: 6px;
  outline: none;
  transition:
    border-color 0.3s,
    box-shadow 0.3s;
  justify-content: center;
}

.input-tools {
  position: absolute;
  display: grid;
  height: 55%;
  right: 4%;
  bottom: 22%;
  overflow: scroll;
  scrollbar-width: none;
}

.input-tools::-webkit-scrollbar {
  display: none;
}

.btn-commit-row {
  position: absolute;
  bottom: 7%;
  right: 5%;
}

.btn-function-image-editor {
  width: 55px;
  height: 45px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  margin-bottom: 25px;
  text-align: center;
}

.input-tools-img {
  border: none;
  box-shadow: none;
  width: 28px;
}

.function-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.close-btn-img {
  position: absolute;
  top: 10px;
  right: 10px;
  color: #fff;
  cursor: pointer;
}

.select-elm-editform {
  width: 30%;
  height: auto;
  font-size: 18px;
  background: white;
  color: #000000;
  padding: 8px 8px;
  text-decoration: none;
  border: solid 1px #adadad;
  border-radius: 8px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.btn-standard {
  min-width: 90px;
}

.btn-update {
  width: 95px;
  height: 50px;
  font-size: 18px;
  background: rgb(23, 155, 126);
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  color: #fff;
  text-decoration: none;
  border: 1px;
  border-radius: 20px;
  transition: background-color 0.3s;
  margin: 5px 5px 5px 5px;
}
</style>
