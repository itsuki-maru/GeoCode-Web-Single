<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import BaseModal from "@/components/common/BaseModal.vue";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  message: [text: string];
}>();

const qrCodeText = ref("");
const isGenerateOk = ref(false);
const QRCode: any = (window as any).QRCode;

let qrcode: any;
onMounted(() => {
  qrcode = new QRCode(document.getElementById("qrcode"), {
    text: qrCodeText.value,
    width: 128,
    height: 128,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H,
  });
});

watch(qrCodeText, () => {
  if (qrCodeText.value === "") {
    const qrElement = document.getElementById("qrcode") as HTMLElement | null;
    if (qrElement !== null) {
      const images = qrElement.querySelectorAll("img");
      images.forEach((img) => (img.style.display = "none"));
    }
    isGenerateOk.value = false;
  } else {
    isGenerateOk.value = true;
    generateQRCode();
  }
});

function generateQRCode(): void {
  const text = qrCodeText.value;
  if (text === "") {
    emit("message", "文字列を入力してください。");
    return;
  }
  qrcode.clear();
  qrcode.makeCode(text);
}

function saveQRCode(): void {
  const canvas: any = document.querySelector("#qrcode canvas");
  if (canvas) {
    const imageUrl = canvas.toDataURL("image/png").replace("image/png", "image/octet-stream");
    const link = document.createElement("a");
    link.download = "qrcode.png";
    link.href = imageUrl;
    link.click();
  }
}
</script>

<template>
  <BaseModal :isOpen="isOpen" @close="emit('close')">
    <h2 class="modal-h2">QRコード生成</h2>
    <div class="setting-contents">
      <div id="qrcode" class="qrcode"></div>
      <div class="init-latlng-zone">
        <div class="latitude-zone">
          <input
            type="text"
            maxlength="150"
            title=""
            placeholder="文字列を入力"
            class="input-textbox"
            required
            v-model="qrCodeText"
          />
        </div>
        <div :class="{ 'btn-zone': isGenerateOk, 'btn-close': !isGenerateOk }">
          <button @click="emit('close')">閉じる</button>
          <button v-if="isGenerateOk" @click="saveQRCode()">保存</button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.modal-h2 {
  border-bottom: solid 2px #acacac;
  text-align: center;
}

.setting-contents {
  text-align: center;
}

.qrcode {
  margin-bottom: 5%;
  display: grid;
  place-items: center;
}

.input-textbox {
  font-size: 24px;
  width: 90%;
  height: 40px;
  text-align: center;
  border-radius: 5px;
}

.btn-zone {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
}

.btn-close {
  margin-top: 20px;
  text-align: center;
  align-items: center;
}
</style>
