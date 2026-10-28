<script setup lang="ts">
import type { AnswerColumn, AnswerTableRow, FormAnswer } from "@/utils/answer-presentation";
defineProps<{ rows: AnswerTableRow[]; columns: AnswerColumn[]; editingSupported: boolean }>();
const emit = defineEmits<{ detail: [answer: FormAnswer]; edit: [answer: FormAnswer] }>();
</script>

<template>
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>投稿日時</th>
          <th>対象</th>
          <th>フォーム</th>
          <th v-for="field in columns" :key="field.key">
            {{ field.displayLabel }}
          </th>
          <th class="actions-column" :class="{ editable: editingSupported }">詳細</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-answer-key="row.key">
          <td data-label="投稿日時">
            <span class="cell-value">{{ row.dateLabel }}</span>
          </td>
          <td data-label="対象">
            <span class="cell-value">
              {{ row.answer.target_type === "marker" ? "マーカー" : "図形" }}：{{
                row.answer.target_name
              }}<small>{{ row.answer.layer_name || "レイヤなし" }}</small>
            </span>
          </td>
          <td data-label="フォーム">
            <span class="cell-value">
              {{
                row.answer.common_form_name ||
                row.answer.form_snapshot?.form_title ||
                "個別フォーム"
              }}{{ row.answer.common_form_deleted ? "（削除済み）" : ""
              }}<small v-if="row.answer.source_form"
                >適用元：第{{ row.answer.source_form.version }}版</small
              ><small v-if="!row.answer.form_snapshot">投稿時の定義情報なし</small>
            </span>
          </td>
          <td
            v-for="cell in row.cells"
            :key="cell.key"
            :data-label="cell.label"
            class="answer-value"
          >
            <span class="cell-value">
              {{ cell.text }}
            </span>
          </td>
          <td class="actions-cell">
            <div class="row-actions">
              <button @click="emit('detail', row.answer)">詳細を見る</button>
              <button
                v-if="editingSupported"
                :disabled="!row.canEdit"
                :title="
                  row.answer.form_snapshot
                    ? '回答を編集'
                    : '投稿時のフォーム定義がないため編集できません'
                "
                @click="emit('edit', row.answer)"
              >
                編集
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
button {
  border: 1px solid #aeb9c8;
  border-radius: 8px;
  padding: 8px 12px;
  background: white;
  color: #172033;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.table-scroll {
  overflow: auto;
  margin-top: 12px;
}
table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
  min-width: max(100%, 720px);
  font-size: 14px;
}
th,
td {
  border: 1px solid #ccc;
  padding: 6px 13px;
  text-align: left;
  min-width: 120px;
  max-width: 300px;
  overflow-wrap: anywhere;
  vertical-align: top;
  white-space: pre-wrap;
}
th {
  background: rgb(44, 52, 78);
  color: whitesmoke;
}
tbody tr {
  background: #fff;
}
tbody tr:nth-child(2n) {
  background: #eee;
}
tbody tr:hover {
  background: #69a5b8;
}
small {
  display: block;
  color: #5c6778;
  margin-top: 4px;
  font-size: 12px;
}
@media (max-width: 700px) {
  table,
  tbody,
  tr,
  td {
    display: block;
    width: auto;
  }
  table {
    min-width: 0;
  }
  thead {
    display: none;
  }
  tr {
    border: 1px solid #ccd5e1;
    border-radius: 8px;
    margin-bottom: 12px;
    padding: 8px;
  }
  td {
    border: 0;
    min-width: 0;
    max-width: none;
    padding: 6px;
  }
  td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-weight: bold;
    color: #5c6778;
    margin-bottom: 0;
  }
  td[data-label] {
    display: grid;
    grid-template-columns: minmax(70px, 30%) minmax(0, 1fr);
    align-items: start;
    gap: 10px;
    white-space: normal;
  }
  .cell-value {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .answer-value .cell-value {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
}
.answer-value {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}
.row-actions > button {
  flex: 0 0 auto;
  white-space: nowrap;
}
@media (min-width: 701px) {
  .actions-column {
    width: 104px;
  }
  .actions-column.editable {
    width: 168px;
  }
  .actions-column,
  .actions-cell {
    min-width: 0;
    padding: 6px 8px;
    text-align: center;
    vertical-align: middle;
    white-space: normal;
  }
  .table-scroll {
    flex: 1 0 min(480px, 52dvh);
    min-height: min(480px, 52dvh);
  }
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
}
button {
  background: #5f5f5f;
  color: #fff;
  border-color: transparent;
}
@media (max-width: 700px) {
  .table-scroll {
    max-height: none;
    overflow: visible;
  }
  td.answer-value {
    white-space: normal;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:not(.help-button),
  summary {
    min-height: 40px;
  }
}
</style>
