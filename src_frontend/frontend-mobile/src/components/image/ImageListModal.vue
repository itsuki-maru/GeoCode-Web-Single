<script setup lang="ts">
import { ref, computed } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { isPDF, isMP4 } from "@/composables/useFileTypeCheck";
import { useImageStore } from "@/stores/images";
import { baseUrl, assetsUrl } from "@/settingMobile";

const props = defineProps<{
  isOpen: boolean;
  isHttps: boolean;
}>();

const emit = defineEmits<{
  close: [];
  preview: [filename: string, id: string];
  delete: [id: string];
  copyPath: [id: string];
  message: [text: string];
}>();

const imageStore = useImageStore();
const imageList = computed(() => imageStore.imageList);

const queryFormData = ref("");

const onSearch = (reset: boolean = false): void => {
  try {
    if (reset) {
      imageStore.queryImage("");
    } else {
      imageStore.queryImage(queryFormData.value);
    }
  } catch (error) {
    console.error(error);
  }
};

const onImageCopyPath = (id: string) => {
  const imageData = imageStore.getById(id);
  const imageName = imageData.filename;
  const uuidName = imageData.uuid_filename;
  let imageUrlMarkdown = "";
  if (isMP4(imageData.filename)) {
    imageUrlMarkdown = `?[${imageName}](${baseUrl}/static/images/${uuidName})`;
  } else if (isPDF(imageData.filename)) {
    imageUrlMarkdown = `[${imageName}](${baseUrl}/static/images/${uuidName})`;
  } else {
    imageUrlMarkdown = `![${imageName}](${baseUrl}/static/images/${uuidName})`;
  }

  if (props.isHttps) {
    navigator.clipboard.writeText(imageUrlMarkdown);
    emit("message", "クリップボードにコピーしました。");
  } else {
    // HTTP時はテキスト選択
    selectText(imageData.uuid_filename);
  }
};

function selectText(elementId: string) {
  const element = document.getElementById(elementId);
  if (!element || !element.textContent) return;
  if (window.getSelection) {
    const selection = window.getSelection();
    const range = document.createRange();
    try {
      range.selectNodeContents(element);
    } catch (e) {
      console.error(`Error selecting contents of element: ${e}`);
    }
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}

function selectTextOrClipboardCopy(elementId: string) {
  const element = document.getElementById(elementId);
  if (!element || !element.textContent) return;

  if (props.isHttps) {
    navigator.clipboard.writeText(element.textContent);
    emit("message", "クリップボードにコピーしました。");
  } else {
    selectText(elementId);
  }
}
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <h2 class="modal-h2">画像・動画・PDF</h2>
    <div class="search-form">
      <div class="form-text">
        <input
          type="text"
          maxlength="15"
          title=""
          class="query1"
          placeholder="検索ワード"
          v-model="queryFormData"
        />
      </div>
      <div class="search-btn-zone">
        <button
          class="btn-search-start-reset-imagelist"
          type="submit"
          title="検索実行"
          @click.prevent="onSearch()"
        >
          <img :src="`${assetsUrl}search_fill24.png`" class="btn-img" alt="search_fill24.png" />
        </button>
        <button
          class="btn-search-start-reset-imagelist"
          type="submit"
          title="検索結果をクリア"
          @click.prevent="onSearch(true)"
        >
          <img :src="`${assetsUrl}update_fill24.png`" class="btn-img" alt="update_fill24.png" />
        </button>
      </div>
    </div>
    <div class="table-sticky-imagelist">
      <table>
        <thead>
          <tr>
            <th id="copied-msg">FileName</th>
            <th>Preview</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          <!-- HTTPS版: クリップボードコピー -->
          <template v-if="isHttps">
            <tr v-for="[id, image] in imageList" :key="id">
              <td @click="onImageCopyPath(image.id)">{{ image.filename }}</td>
              <td
                v-if="isPDF(image.filename)"
                @click.prevent="emit('preview', image.uuid_filename, image.id)"
                class="td-img"
              >
                <img
                  :src="`${assetsUrl}picture_as_pdf_24.png`"
                  class="btn-img-table"
                  alt="picture_as_pdf_24.png"
                />
              </td>
              <td
                v-else
                @click.prevent="emit('preview', image.uuid_filename, image.id)"
                class="td-img"
              >
                <img
                  :src="`${assetsUrl}photo_camera_24.png`"
                  class="btn-img-table"
                  alt="photo_camera_24.png"
                />
              </td>
              <td @click="emit('delete', id)" class="td-img">
                <img :src="`${assetsUrl}delete_24.png`" class="btn-img-table" alt="delete_24.png" />
              </td>
            </tr>
          </template>
          <!-- HTTP版: テキスト選択 -->
          <template v-else>
            <tr v-for="[id, image] in imageList" :key="id">
              <td
                v-if="isPDF(image.uuid_filename)"
                :id="image.uuid_filename"
                @click="selectTextOrClipboardCopy(image.uuid_filename)"
              >
                [{{ image.filename }}]({{ baseUrl }}/static/images/{{ image.uuid_filename }})
              </td>
              <td
                v-else-if="isMP4(image.uuid_filename)"
                :id="image.uuid_filename"
                @click="selectTextOrClipboardCopy(image.uuid_filename)"
              >
                ?[{{ image.filename }}]({{ baseUrl }}/static/images/{{ image.uuid_filename }})
              </td>
              <td
                v-else
                :id="image.uuid_filename"
                @click="selectTextOrClipboardCopy(image.uuid_filename)"
              >
                ![{{ image.filename }}]({{ baseUrl }}/static/images/{{ image.uuid_filename }})
              </td>
              <td
                v-if="isPDF(image.filename)"
                @click.prevent="emit('preview', image.uuid_filename, image.id)"
                class="td-img"
              >
                <img
                  :src="`${assetsUrl}picture_as_pdf_24.png`"
                  class="btn-img-table"
                  alt="picture_as_pdf_24.png"
                />
              </td>
              <td
                v-else
                @click.prevent="emit('preview', image.uuid_filename, image.id)"
                class="td-img"
              >
                <img
                  :src="`${assetsUrl}photo_camera_24.png`"
                  class="btn-img-table"
                  alt="photo_camera_24.png"
                />
              </td>
              <td @click="emit('delete', id)" class="td-img">
                <img :src="`${assetsUrl}delete_24.png`" class="btn-img-table" alt="delete_24.png" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div class="btn-zone">
      <button @click="emit('close')" class="btn-standard">閉じる</button>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.search-form {
  display: flex;
  margin-bottom: 1%;
}

.form-text {
  margin-top: 1px;
  margin-right: 1%;
  margin-bottom: 1%;
}

.query1 {
  text-align: center;
  font-size: 15px;
  width: 200px;
  height: 32px;
  border-radius: 8px;
}

.search-btn-zone {
  display: flex;
  width: 100%;
}

.btn-search-start-reset-imagelist {
  width: 45px;
  height: 40px;
  font-size: 16px;
  background: white;
  color: #000000;
  padding: 8px 5px;
  text-decoration: none;
  border: 1px;
  border-radius: 15px;
  transition: background-color 0.3s;
  margin-right: 10px;
  margin-left: 5px;
  text-align: center;
}

.btn-search-start-reset-imagelist:hover {
  background: rgb(235, 235, 235);
}

.table-sticky-imagelist table {
  margin-top: 0;
}

.table-sticky-imagelist {
  display: block;
  overflow-y: auto;
  height: 40vh;
}

.table-sticky-imagelist thead th {
  position: sticky;
  top: 0;
  width: 100%;
  z-index: 1;
  background: rgb(44, 52, 78);
  color: whitesmoke;
}

.table-sticky-imagelist td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50px;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.btn-img-table {
  border: none;
  box-shadow: none;
  width: 26px;
}

.btn-img-table:hover {
  opacity: 0.5;
}

.td-img {
  text-align: center;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

.btn-standard {
  min-width: 90px;
}
</style>
