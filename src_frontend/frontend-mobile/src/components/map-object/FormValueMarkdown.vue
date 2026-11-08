<script setup lang="ts">
import { computed } from "vue";
import { marked } from "marked";
import filterXSS from "xss";
import { sanitizeMapHtml } from "../../../../template-scripts/src/map/common/markdown-sanitizer";

const props = defineProps<{ text: string }>();
const html = computed(() =>
  sanitizeMapHtml(marked.parse(props.text, { async: false, breaks: true }), filterXSS),
);
</script>

<template>
  <div class="form-value-markdown" v-html="html"></div>
</template>

<style scoped>
.form-value-markdown {
  overflow-wrap: anywhere;
  white-space: normal;
}
.form-value-markdown :deep(p:first-child) {
  margin-top: 0;
}
.form-value-markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.form-value-markdown :deep(img),
.form-value-markdown :deep(video) {
  max-width: 100%;
  height: auto;
}
.form-value-markdown :deep(pre) {
  overflow-x: auto;
  white-space: pre;
}
.form-value-markdown :deep(table) {
  display: block;
  overflow-x: auto;
}
</style>
