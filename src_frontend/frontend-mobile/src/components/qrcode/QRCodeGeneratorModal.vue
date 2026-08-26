<script setup lang="ts">
import { ref, watch } from "vue";
import QRCode from "qrcode";
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
const qrCodeCanvas = ref<HTMLCanvasElement | null>(null);
let generationId = 0;

watch(qrCodeText, async (text) => {
  const currentGenerationId = ++generationId;
  if (text === "") {
    isGenerateOk.value = false;
    clearQRCode();
    return;
  }

  try {
    await generateQRCode(text);
    if (currentGenerationId === generationId) {
      isGenerateOk.value = true;
    }
  } catch (error) {
    console.error(error);
    if (currentGenerationId === generationId) {
      clearQRCode();
      isGenerateOk.value = false;
      emit("message", "QRコードを生成できませんでした。");
    }
  }
});

async function generateQRCode(text: string): Promise<void> {
  const canvas = qrCodeCanvas.value;
  if (canvas === null) {
    throw new Error("QR code canvas is not mounted.");
  }

  await QRCode.toCanvas(canvas, text, {
    width: 128,
    margin: 0,
    errorCorrectionLevel: "H",
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
}

function clearQRCode(): void {
  const canvas = qrCodeCanvas.value;
  if (canvas !== null) {
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function saveQRCode(): void {
  const canvas = qrCodeCanvas.value;
  if (canvas !== null && isGenerateOk.value) {
    const imageUrl = canvas.toDataURL("image/png");
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
      <div class="qrcode">
        <canvas v-show="isGenerateOk" ref="qrCodeCanvas" width="128" height="128"></canvas>
      </div>
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
