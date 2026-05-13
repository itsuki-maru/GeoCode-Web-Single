<script setup lang="ts">
import { ref, computed } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";
import { isMP4, isPDF } from "@/composables/useFileTypeCheck";
import { useImageStore } from "@/stores/images";
import type { ImageData } from "@/interface";
import { baseUrl, assetsUrl } from "@/setting";

const props = defineProps<{
  isOpen: boolean;
  isHttps: boolean;
}>();

const emit = defineEmits<{
  close: [];
  preview: [filename: string, id: string];
  deleteRequest: [id: string];
  message: [text: string];
}>();

const imageStore = useImageStore();
const imageList = computed((): Map<string, ImageData> => imageStore.imageList);

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
  } else {
    if (isPDF(imageData.filename)) {
      imageUrlMarkdown = `[${imageName}](${baseUrl}/static/images/${uuidName})`;
    } else {
      imageUrlMarkdown = `![${imageName}](${baseUrl}/static/images/${uuidName})`;
    }
  }
  if (props.isHttps) {
    navigator.clipboard.writeText(imageUrlMarkdown);
    emit("message", "クリップボードにコピーしました。");
  } else {
    selectTextOrClipboardCopy(imageData.uuid_filename);
  }
};

function selectTextOrClipboardCopy(elementId: string) {
  let element = document.getElementById(elementId);
  if (!element || !element.textContent) {
    return;
  }

  if (props.isHttps) {
    navigator.clipboard.writeText(element.textContent);
    emit("message", "クリップボードにコピーしました。");
  } else {
    if (window.getSelection) {
      let selection = window.getSelection();
      let range = document.createRange();
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
}
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <div class="image-list-content">
      <h2 class="modal-h2">画像・動画・PDF</h2>
      <div class="search-form">
        <div>
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
              <th>FileName</th>
              <th>Preview</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[id, image] in imageList" :key="id">
              <!-- HTTPS mode: clipboard copy on click -->
              <td v-if="isHttps" @click="onImageCopyPath(image.id)">{{ image.filename }}</td>
              <!-- HTTP mode: show markdown text for selection -->
              <td
                v-else-if="isPDF(image.uuid_filename)"
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
              <td @click="emit('deleteRequest', id)" class="td-img">
                <img :src="`${assetsUrl}delete_24.png`" class="btn-img-table" alt="delete_24.png" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="btn-zone">
        <button @click="emit('close')">閉じる</button>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.image-list-content {
  width: 60vw;
}

.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.search-form {
  display: flex;
  margin-bottom: 1%;
}

.query1 {
  margin-top: 1px;
  margin-right: 1%;
  font-size: 17px;
  width: 100%;
  padding: 0.6em 1.2em;
  display: flex;
  text-align: center;
  margin-bottom: 2%;
  border-radius: 5px;
  box-sizing: border-box;
}

.query1:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
}

.search-btn-zone {
  display: flex;
}

.btn-search-start-reset-imagelist {
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  background: #ffffff;
  width: 50px;
  height: 45px;
  box-shadow: 3px 3px 5px 0 rgba(75, 75, 75, 0.5);
  text-decoration: none;
  border: 1px solid rgb(207, 207, 207);
  border-radius: 50%;
  padding: 0;
  transition-duration: 0.5s;
  transition: background-color 0.3s;
  margin-left: 8px;
  margin-right: 2%;
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

.table-sticky-imagelist table tbody tr:hover {
  background-color: #69a5b8;
}

.btn-img {
  border: none;
  box-shadow: none;
  width: 24px;
}

.btn-img-table {
  border: none;
  box-shadow: none;
  width: 28px;
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
</style>
